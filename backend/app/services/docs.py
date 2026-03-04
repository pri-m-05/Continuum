"""
Documentation generation service.
"""

from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import urlparse
import uuid


def dedupe_actions(actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    last_key = None
    last_ts = 0
    for action in actions:
        current_key = (
            action.get("kind", ""),
            action.get("targetLabel", ""),
            action.get("targetSelector", ""),
            action.get("inputName", ""),
        )
        current_ts = int(action.get("timestamp", 0))
        if current_key == last_key and abs(current_ts - last_ts) < 800:
            continue
        cleaned.append(action)
        last_key = current_key
        last_ts = current_ts
    return cleaned


def actions_to_steps(actions: List[Dict[str, Any]], page: Dict[str, Any]) -> List[str]:
    steps: List[str] = []
    if page.get("title") or page.get("url"):
        steps.append(f"Open page '{page.get('title', 'Untitled Page')}' ({page.get('url', '')}).")
    for action in actions:
        kind = action.get("kind", "").lower()
        label = action.get("targetLabel", "") or action.get("targetSelector", "") or "item"
        input_name = action.get("inputName", "")
        value_preview = action.get("valuePreview", "")
        if kind == "page_view":
            continue
        elif kind == "click":
            steps.append(f"Click '{label}'.")
        elif kind == "change":
            if input_name and value_preview:
                steps.append(f"Update field '{input_name}' with {value_preview}.")
            elif input_name:
                steps.append(f"Update field '{input_name}'.")
            else:
                steps.append(f"Change '{label}'.")
        elif kind == "submit":
            steps.append(f"Submit '{label}'.")
        else:
            steps.append(f"Perform action '{kind}' on '{label}'.")
    return steps


def generate_document_options(session_id: str, page: Dict[str, Any], steps: List[str], evidence: Dict[str, Any] | None = None, intent: Dict[str, Any] | None = None) -> List[Dict[str, Any]]:
    evidence = evidence or {}
    intent = intent or {}

    process_name = intent.get("process_name") or build_title(page)
    doc_type = (intent.get("doc_type") or "sop").lower()
    audience = intent.get("audience", "team")
    notes = intent.get("notes", "")

    joined_steps = "\n".join([f"{i+1}. {s}" for i, s in enumerate(steps)])
    intro_line = f"Document the '{process_name}' process for {audience.replace('_', ' ')}."
    if notes:
        intro_line += f" Special instructions: {notes}"

    evidence_lines = [
        f"- Page URL: {page.get('url', '')}",
        f"- Session ID: {session_id}",
        f"- Captured steps: {len(steps)}",
    ]
    screenshot_count = int(evidence.get("screenshot_count", 0) or 0)
    meeting_count = int(evidence.get("meeting_count", 0) or 0)
    latest_meeting_excerpt = (evidence.get("latest_meeting_excerpt") or "").strip()
    if screenshot_count:
        evidence_lines.append(f"- Screenshots captured in this session: {screenshot_count}")
    if meeting_count:
        evidence_lines.append(f"- Meeting captures linked to this session: {meeting_count}")
    if latest_meeting_excerpt:
        evidence_lines.append(f"- Meeting context excerpt: {latest_meeting_excerpt}")
    evidence_block = "\n".join(evidence_lines)

    templates = {
        "sop": {
            "title": f"{process_name} - SOP Draft",
            "summary": "Formal standard operating procedure draft generated from captured browser actions.",
            "controls": "- Confirm the correct page is open before editing data.\n- Review field changes before submission.\n- Validate the final submission step.\n- Capture screenshots when evidence is required.",
        },
        "walkthrough": {
            "title": f"{process_name} - Step-by-Step Walkthrough",
            "summary": "Narrated walkthrough focused on helping someone repeat the process.",
            "controls": "- Follow the steps in sequence.\n- Pause at decision points and verify the page state.\n- Use screenshots to illustrate UI transitions.",
        },
        "training": {
            "title": f"{process_name} - Training Guide",
            "summary": "Training-oriented guide for onboarding and repeat execution.",
            "controls": "- Explain why each step matters.\n- Highlight common mistakes before submission.\n- Include screenshots for new users.",
        },
        "audit": {
            "title": f"{process_name} - Audit Evidence Pack",
            "summary": "Audit-focused document that emphasizes controls, evidence, and proof of completion.",
            "controls": "- Control 1: Confirm the intended record or workflow page is selected.\n- Control 2: Review updated fields before submitting.\n- Control 3: Confirm completion status or evidence output.\n- Control 4: Preserve screenshots and transcript evidence for audit review.",
        },
        "meeting": {
            "title": f"{process_name} - Meeting Notes & Follow-Ups",
            "summary": "Meeting-oriented document that combines workflow context with transcript-derived notes.",
            "controls": "- Confirm meeting capture started before discussion begins.\n- Validate transcript quality after recording.\n- Review follow-up items and owners before sharing notes.",
        },
    }

    primary_template = templates.get(doc_type, templates["sop"])

    primary = {
        "id": f"doc_{uuid.uuid4().hex}",
        "title": primary_template["title"],
        "summary": primary_template["summary"],
        "content": f"""# Purpose
{intro_line}

# Preconditions
- User has access to the target application.
- User is on the correct page before starting.
- Required source information is available.

# Procedure
{joined_steps}

# Controls
{primary_template['controls']}

# Evidence
{evidence_block}
""",
    }

    alternates = [
        {
            "id": f"doc_{uuid.uuid4().hex}",
            "title": f"{process_name} - Quick Reference",
            "summary": "Shorter checklist-style process reference.",
            "content": f"""# Purpose
{intro_line}

# Preconditions
- Required access is active.
- The correct page or record has been opened.

# Procedure
{joined_steps}

# Controls
- Verify key fields before submit.
- Confirm the expected result appears after completion.

# Evidence
{evidence_block}
""",
        },
        {
            "id": f"doc_{uuid.uuid4().hex}",
            "title": f"{process_name} - Control Narrative",
            "summary": "Audit-oriented narrative emphasizing control points and evidence.",
            "content": f"""# Purpose
{intro_line}

# Preconditions
- User identity and access have been validated.
- Input source data has been reviewed.

# Procedure
{joined_steps}

# Controls
- Ensure the intended record or workflow page is selected.
- Review updated fields before submitting.
- Confirm the completion state or confirmation message.
- Preserve evidence for audit review.

# Evidence
{evidence_block}
""",
        },
    ]

    return [primary, *alternates]


def build_title(page: Dict[str, Any]) -> str:
    page_title = (page.get("title") or "").strip()
    if page_title:
        return page_title[:80]
    page_url = page.get("url") or ""
    parsed = urlparse(page_url)
    if parsed.netloc:
        return f"Workflow on {parsed.netloc}"
    return "Captured Workflow"
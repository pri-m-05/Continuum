"""
Documentation generation service.

WHAT THIS FILE DOES
1. Deduplicates noisy browser actions
2. Converts actions into readable workflow steps
3. Generates multiple document options
4. Adds evidence references like screenshots and meeting context

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
        steps.append(
            f"Open page '{page.get('title', 'Untitled Page')}' ({page.get('url', '')})."
        )

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


def generate_document_options(
    session_id: str,
    page: Dict[str, Any],
    steps: List[str],
    evidence: Dict[str, Any] | None = None,
) -> List[Dict[str, Any]]:
    evidence = evidence or {}
    title_base = build_title(page)
    joined_steps = "\n".join([f"{index + 1}. {step}" for index, step in enumerate(steps)])

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

    option_1 = {
        "id": f"doc_{uuid.uuid4().hex}",
        "title": f"{title_base} - SOP Draft",
        "summary": "Formal standard operating procedure draft generated from captured browser actions.",
        "content": f"""# Purpose
Document the procedure used on {page.get("title", "the target page")}.

# Preconditions
- User has access to the target application.
- User is on the correct page before starting.
- Required source information is available.

# Procedure
{joined_steps}

# Controls
- Confirm the correct page is open before editing data.
- Review field changes before submission.
- Validate the final submission step.
- Capture screenshots when evidence is required.

# Evidence
{evidence_block}
""",
    }

    option_2 = {
        "id": f"doc_{uuid.uuid4().hex}",
        "title": f"{title_base} - Quick Reference",
        "summary": "Shorter checklist-style process reference.",
        "content": f"""# Purpose
Provide a quick reference for the {title_base} process.

# Preconditions
- Required access is active.
- The correct record or page has been opened.

# Procedure
{joined_steps}

# Controls
- Verify key fields before submit.
- Confirm the expected result appears after completion.

# Evidence
{evidence_block}
""",
    }

    option_3 = {
        "id": f"doc_{uuid.uuid4().hex}",
        "title": f"{title_base} - Control Narrative",
        "summary": "Audit-oriented narrative emphasizing control points and evidence.",
        "content": f"""# Purpose
Describe the control flow and documentation expectations for {title_base}.

# Preconditions
- User identity and access have been validated.
- Input source data has been reviewed.

# Procedure
{joined_steps}

# Controls
- Control 1: Ensure the intended record or workflow page is selected.
- Control 2: Review updated fields before submitting.
- Control 3: Confirm the completion state or confirmation message.
- Control 4: Preserve evidence for audit review.

# Evidence
{evidence_block}
""",
    }

    return [option_1, option_2, option_3]


def build_title(page: Dict[str, Any]) -> str:
    page_title = (page.get("title") or "").strip()
    if page_title:
        return page_title[:80]

    page_url = page.get("url") or ""
    parsed = urlparse(page_url)
    if parsed.netloc:
        return f"Workflow on {parsed.netloc}"

    return "Captured Workflow"
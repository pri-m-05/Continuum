from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List

import requests

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
SUPPORTED_STYLES = {"professional_bullets", "narrative", "action_items_only"}


def _api_key() -> str:
    return os.getenv("OPENAI_API_KEY", "").strip()


def build_meeting_notes(transcript: str, page_title: str = "", style: str = "professional_bullets") -> Dict[str, Any]:
    style = (style or "professional_bullets").strip().lower()
    if style not in SUPPORTED_STYLES:
        style = "professional_bullets"

    if not transcript.strip():
        notes = {
            "summary": "- No transcript available.",
            "decisions": [],
            "action_items": [],
            "follow_up_questions": [],
            "warnings": ["Transcript text was empty."],
        }
        notes["minutes_markdown"] = render_minutes_markdown(notes, page_title)
        return notes

    if _api_key():
        ai = _notes_with_openai(transcript, page_title, style)
        if ai.get("ok"):
            notes = ai["notes"]
            notes["minutes_markdown"] = render_minutes_markdown(notes, page_title)
            return notes

    notes = _notes_heuristic(transcript, page_title, style)
    notes.setdefault("warnings", [])
    notes["warnings"].append("Heuristic minutes used (AI missing or failed).")
    notes["minutes_markdown"] = render_minutes_markdown(notes, page_title)
    return notes


def _notes_with_openai(transcript: str, page_title: str, style: str) -> Dict[str, Any]:
    key = _api_key()
    if not key:
        return {"ok": False, "error": "Missing OPENAI_API_KEY"}

    if style == "professional_bullets":
        summary_rule = "Summary MUST be 5–10 bullet points. Each line starts with '- '. No paragraphs."
    elif style == "narrative":
        summary_rule = "Summary MUST be a short professional paragraph (2–5 sentences)."
    else:
        summary_rule = "Summary MUST be exactly: '- Action items only (see list below).'"

    system = f"""
Return ONLY valid JSON with this structure:
{{
  "summary": "string",
  "decisions": ["string"],
  "action_items": [{{"owner":"string","task":"string","due_date":"string"}}],
  "follow_up_questions": ["string"],
  "warnings": ["string"]
}}

Rules:
- {summary_rule}
- Decisions: short one-liners.
- Action items: specific tasks. owner="Unassigned" if unknown. due_date="" if unknown.
- No markdown headers.
""".strip()

    user = f"Title/context: {page_title or 'Unknown'}\n\nTranscript:\n{transcript}".strip()

    try:
        r = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": "gpt-4o-mini",
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": 0.2,
            },
            timeout=120,
        )
        if not r.ok:
            return {"ok": False, "error": r.text[:300]}

        parsed = json.loads(r.json()["choices"][0]["message"]["content"])
        notes = {
            "summary": str(parsed.get("summary", "")).strip(),
            "decisions": _clean_str_list(parsed.get("decisions", [])),
            "action_items": _clean_action_items(parsed.get("action_items", [])),
            "follow_up_questions": _clean_str_list(parsed.get("follow_up_questions", [])),
            "warnings": _clean_str_list(parsed.get("warnings", [])),
        }

        if style == "professional_bullets":
            notes["summary"] = ensure_bullets(notes["summary"])
        if style == "action_items_only":
            notes["summary"] = "- Action items only (see list below)."

        return {"ok": True, "notes": notes}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _notes_heuristic(transcript: str, page_title: str, style: str) -> Dict[str, Any]:
    sentences = _split_sentences(transcript)

    if style == "narrative":
        summary = " ".join(sentences[:5]).strip() or f"Meeting captured for {page_title or 'the tab'}."
    elif style == "action_items_only":
        summary = "- Action items only (see list below)."
    else:
        summary = "\n".join([f"- {s}" for s in sentences[:10]]) or "- Meeting captured."
        summary = ensure_bullets(summary)

    decisions, followups, action_items = [], [], []
    for s in sentences:
        low = s.lower()
        if any(x in low for x in ["decided", "agreed", "approved", "resolved"]):
            decisions.append(s)
        if any(x in low for x in ["action item", "todo", "next step", "follow up", "we need to"]):
            action_items.append({"owner": "Unassigned", "task": s, "due_date": ""})
        if "?" in s:
            followups.append(s)

    return {
        "summary": summary,
        "decisions": _dedupe(decisions)[:10],
        "action_items": _dedupe_action_items(action_items)[:15],
        "follow_up_questions": _dedupe(followups)[:10],
        "warnings": [],
    }


def render_minutes_markdown(notes: Dict[str, Any], page_title: str) -> str:
    title = page_title.strip() if page_title else "Meeting"
    summary = str(notes.get("summary", "") or "").strip()
    decisions = notes.get("decisions", []) or []
    actions = notes.get("action_items", []) or []
    followups = notes.get("follow_up_questions", []) or []

    lines: List[str] = []
    lines.append(f"# Meeting Minutes – {title}")
    lines.append("")
    lines.append("## Summary")
    lines.append(summary if summary else "- (no summary)")
    lines.append("")
    lines.append(f"## Decisions ({len(decisions)})")
    lines.extend([f"- {d}" for d in decisions] or ["- None captured."])
    lines.append("")
    lines.append(f"## Action Items ({len(actions)})")
    if actions:
        for a in actions:
            owner = (a.get("owner") or "Unassigned").strip()
            task = (a.get("task") or "").strip()
            due = (a.get("due_date") or "").strip()
            due_str = f" (Due: {due})" if due else ""
            lines.append(f"- **{owner}**: {task}{due_str}")
    else:
        lines.append("- None captured.")
    lines.append("")
    lines.append(f"## Follow-ups ({len(followups)})")
    lines.extend([f"- {q}" for q in followups] or ["- None captured."])
    return "\n".join(lines).strip()


def ensure_bullets(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return "- (no summary)"
    if t.startswith("- "):
        return t
    parts = _split_sentences(t)
    bullets = [f"- {p}" for p in parts[:10] if p.strip()]
    return "\n".join(bullets) if bullets else "- (no summary)"


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _clean_str_list(values: Any) -> List[str]:
    return [str(v).strip() for v in values] if isinstance(values, list) else []


def _clean_action_items(values: Any) -> List[Dict[str, str]]:
    if not isinstance(values, list):
        return []
    out = []
    for v in values:
        if not isinstance(v, dict):
            continue
        out.append({
            "owner": str(v.get("owner", "Unassigned") or "Unassigned").strip(),
            "task": str(v.get("task", "")).strip(),
            "due_date": str(v.get("due_date", "")).strip(),
        })
    return [x for x in out if x["task"]]


def _dedupe(items: List[str]) -> List[str]:
    seen, out = set(), []
    for x in items:
        k = x.strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def _dedupe_action_items(items: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen, out = set(), []
    for it in items:
        k = (it.get("owner", "").strip().lower(), it.get("task", "").strip().lower())
        if not k[1] or k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out

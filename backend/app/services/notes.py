"""
Meeting notes generation service.

WHAT THIS FILE DOES
1. Turns transcript text into:
   - summary
   - decisions
   - action items
   - follow-up questions
2. Uses OpenAI when configured
3. Falls back to heuristic extraction when AI is unavailable

"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List

import requests


OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"


def build_meeting_notes(transcript: str, page_title: str = "") -> Dict[str, Any]:
    
    if not transcript.strip():
        return {
            "summary": "No transcript available.",
            "decisions": [],
            "action_items": [],
            "follow_up_questions": [],
            "warnings": [
                "Transcript text was empty, so follow-up notes could not be generated."
            ],
        }

    if OPENAI_API_KEY:
        ai_result = _generate_notes_with_openai(transcript=transcript, page_title=page_title)
        if ai_result.get("ok"):
            return ai_result["notes"]

    heuristic = _generate_notes_heuristically(transcript=transcript, page_title=page_title)
    heuristic.setdefault("warnings", [])
    if OPENAI_API_KEY:
        heuristic["warnings"].append(
            "OpenAI notes generation failed, so heuristic note extraction was used instead."
        )
    else:
        heuristic["warnings"].append(
            "OPENAI_API_KEY is not set on the backend, so heuristic note extraction was used."
        )
    return heuristic


def _generate_notes_with_openai(transcript: str, page_title: str = "") -> Dict[str, Any]:
    
    system_prompt = """
You are a meeting-notes assistant.
Return ONLY valid JSON with this exact structure:
{
  "summary": "string",
  "decisions": ["string"],
  "action_items": [{"owner": "string", "task": "string", "due_date": "string"}],
  "follow_up_questions": ["string"],
  "warnings": ["string"]
}
Rules:
- Do not include markdown.
- If an owner is unknown, use "Unassigned".
- If a due date is unknown, use "".
- Keep the summary concise but useful.
""".strip()

    user_prompt = f"""
Page title / meeting context:
{page_title or "Unknown"}

Transcript:
{transcript}
""".strip()

    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.2,
            },
            timeout=120,
        )

        if not response.ok:
            return {"ok": False, "error": response.text[:500]}

        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        parsed = json.loads(content)

        return {
            "ok": True,
            "notes": {
                "summary": str(parsed.get("summary", "")).strip(),
                "decisions": _clean_str_list(parsed.get("decisions", [])),
                "action_items": _clean_action_items(parsed.get("action_items", [])),
                "follow_up_questions": _clean_str_list(parsed.get("follow_up_questions", [])),
                "warnings": _clean_str_list(parsed.get("warnings", [])),
            },
        }

    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _generate_notes_heuristically(transcript: str, page_title: str = "") -> Dict[str, Any]:
   
    sentences = _split_sentences(transcript)
    summary = " ".join(sentences[:5]).strip()
    if not summary:
        summary = f"Meeting captured for {page_title or 'the current tab'}, but no usable summary was extracted."

    decisions = []
    action_items = []
    follow_up_questions = []

    decision_markers = [
        "decided",
        "agreed",
        "approved",
        "resolved",
        "we will",
        "we'll",
    ]

    action_markers = [
        "action item",
        "todo",
        "to do",
        "next step",
        "follow up",
        "i will",
        "i'll",
        "we need to",
        "please send",
        "please share",
        "schedule",
    ]

    for sentence in sentences:
        lowered = sentence.lower()

        if any(marker in lowered for marker in decision_markers):
            decisions.append(sentence)

        if any(marker in lowered for marker in action_markers):
            action_items.append(
                {
                    "owner": "Unassigned",
                    "task": sentence,
                    "due_date": "",
                }
            )

        if "?" in sentence:
            follow_up_questions.append(sentence)

    return {
        "summary": summary,
        "decisions": _dedupe_preserve_order(decisions)[:10],
        "action_items": _dedupe_action_items(action_items)[:10],
        "follow_up_questions": _dedupe_preserve_order(follow_up_questions)[:10],
        "warnings": [],
    }


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text.strip())
    return [part.strip() for part in parts if part.strip()]


def _clean_str_list(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    return [str(item).strip() for item in values if str(item).strip()]


def _clean_action_items(values: Any) -> List[Dict[str, str]]:
    if not isinstance(values, list):
        return []

    cleaned: List[Dict[str, str]] = []
    for item in values:
        if not isinstance(item, dict):
            continue
        cleaned.append(
            {
                "owner": str(item.get("owner", "Unassigned") or "Unassigned").strip(),
                "task": str(item.get("task", "")).strip(),
                "due_date": str(item.get("due_date", "")).strip(),
            }
        )

    return [item for item in cleaned if item["task"]]


def _dedupe_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        key = value.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def _dedupe_action_items(values: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen = set()
    result = []
    for value in values:
        key = (value.get("owner", "").strip().lower(), value.get("task", "").strip().lower())
        if not key[1] or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result
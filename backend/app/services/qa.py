from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List

import requests

from app.services.store import get_sessions_by_ids, list_screenshots_for_sessions, read_store

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"


def _api_key() -> str:
    return os.getenv("OPENAI_API_KEY", "").strip()


def _tokenize(text: str) -> List[str]:
    return [t for t in re.findall(r"[a-zA-Z0-9_]+", (text or "").lower()) if len(t) > 1]


def _heading_sections(markdown: str) -> List[Dict[str, str]]:
    text = str(markdown or "").strip()
    if not text:
        return []

    lines = text.splitlines()
    sections: List[Dict[str, str]] = []
    current_title = "Document"
    current_lines: List[str] = []

    for line in lines:
        if line.startswith("#"):
            if current_lines:
                sections.append({"title": current_title, "content": "\n".join(current_lines).strip()})
            current_title = line.lstrip("#").strip() or "Section"
            current_lines = []
            continue
        current_lines.append(line)

    if current_lines:
        sections.append({"title": current_title, "content": "\n".join(current_lines).strip()})

    return [section for section in sections if section["content"]]


def _build_sources(document: Dict[str, Any]) -> List[Dict[str, str]]:
    sources: List[Dict[str, str]] = []
    source_session_ids = list(
        document.get("source_session_ids")
        or ([document.get("session_id")] if document.get("session_id") else [])
    )

    title = str(document.get("title") or "Untitled Document")
    summary = str(document.get("summary") or "").strip()
    content = str(document.get("content") or "").strip()

    if summary:
        sources.append({
            "id": "doc_summary",
            "label": f"Document summary — {title}",
            "kind": "document_summary",
            "content": summary,
        })

    for idx, section in enumerate(_heading_sections(content), start=1):
        sources.append({
            "id": f"doc_section_{idx}",
            "label": f"Document section — {section['title']}",
            "kind": "document_section",
            "content": section["content"],
        })

    sessions = get_sessions_by_ids(source_session_ids)
    for session in sessions:
        session_id = str(session.get("session_id") or "")
        page = session.get("page", {}) or {}
        page_title = str(page.get("title") or page.get("url") or session_id)

        for idx, step in enumerate(session.get("steps", []) or [], start=1):
            step_text = str(step or "").strip()
            if not step_text:
                continue
            sources.append({
                "id": f"step_{session_id}_{idx}",
                "label": f"Captured step {idx} — {page_title}",
                "kind": "captured_step",
                "content": step_text,
            })

    screenshots = list_screenshots_for_sessions(source_session_ids)
    for idx, shot in enumerate(screenshots, start=1):
        caption = str(shot.get("caption") or "Screenshot").strip()
        page_title = str(shot.get("page_title") or shot.get("page_url") or "")
        sources.append({
            "id": f"shot_{idx}",
            "label": f"Screenshot {idx} — {page_title or caption}",
            "kind": "screenshot",
            "content": f"Screenshot caption: {caption}. Page: {page_title}",
        })

    meeting_ids = list(document.get("included_meeting_ids") or [])
    if meeting_ids:
        store = read_store()
        meetings = [m for m in store.get("meetings", []) if m.get("meeting_id") in set(meeting_ids)]
        meetings.sort(key=lambda item: item.get("created_at", ""))
        for idx, meeting in enumerate(meetings, start=1):
            notes = meeting.get("notes", {}) or {}
            summary_text = str(
                notes.get("summary")
                or notes.get("minutes_markdown")
                or meeting.get("transcript")
                or ""
            ).strip()
            if not summary_text:
                continue
            sources.append({
                "id": f"meeting_{idx}",
                "label": f"Linked meeting {idx} — {meeting.get('page_title') or 'Meeting'}",
                "kind": "meeting",
                "content": summary_text[:1400],
            })

    return sources


def _score_source(question: str, source: Dict[str, str]) -> int:
    q_tokens = set(_tokenize(question))
    s_tokens = set(_tokenize(source.get("content", "") + " " + source.get("label", "")))
    if not q_tokens or not s_tokens:
        return 0

    score = len(q_tokens & s_tokens)
    q = question.lower()
    content = (source.get("content", "") + " " + source.get("label", "")).lower()

    if "screenshot" in q and source.get("kind") == "screenshot":
        score += 2
    if any(word in q for word in ["click", "next", "step", "where"]) and source.get("kind") == "captured_step":
        score += 2
    if any(word in q for word in ["summary", "purpose", "precondition", "control"]) and source.get("kind") == "document_section":
        score += 1
    if "meeting" in q and source.get("kind") == "meeting":
        score += 2
    if source.get("id") == "doc_summary":
        score += 1
    if q and q in content:
        score += 3

    return score


def _select_sources(question: str, sources: List[Dict[str, str]], limit: int = 8) -> List[Dict[str, str]]:
    ranked = sorted(sources, key=lambda source: _score_source(question, source), reverse=True)
    picked = [source for source in ranked if _score_source(question, source) > 0][:limit]
    if not picked:
        picked = ranked[: min(limit, len(ranked))]
    return picked


def _source_defaults(document: Dict[str, Any]) -> Dict[str, str]:
    return {
        "source_basis": str(document.get("source_basis") or "internal_capture"),
        "source_label": str(document.get("source_label") or "Internal workflow"),
        "source_note": str(
            document.get("source_note")
            or "Built from captured browser actions, screenshots, and any explicitly included process evidence."
        ),
    }


def _heuristic_answer(question: str, selected: List[Dict[str, str]], document: Dict[str, Any]) -> Dict[str, Any]:
    defaults = _source_defaults(document)
    top = selected[:3]

    if not top:
        return {
            **defaults,
            "answer_markdown": "I couldn't find enough grounded process evidence to answer that yet.",
            "citations": [],
            "used_ai": False,
        }

    lines = ["Based on the current documented process:"]
    for source in top:
        lines.append(f"- {source['content'][:260].strip()}")

    return {
        **defaults,
        "answer_markdown": "\n".join(lines),
        "citations": [{"id": source["id"], "label": source["label"]} for source in top],
        "used_ai": False,
    }


def _ai_answer(question: str, selected: List[Dict[str, str]], document: Dict[str, Any]) -> Dict[str, Any]:
    key = _api_key()
    if not key:
        return {"ok": False, "error": "missing_api_key"}

    defaults = _source_defaults(document)
    context_lines = []
    for source in selected:
        context_lines.append(f"[{source['id']}] {source['label']}\n{source['content']}")

    system = """
You answer questions about a business process using ONLY the provided grounded sources.
Return ONLY valid JSON with this shape:
{
  "answer_markdown": "string",
  "citation_ids": ["string"]
}
Rules:
- Use only the provided sources.
- If the answer is uncertain or the evidence is incomplete, say so plainly.
- Keep the answer concise but useful.
- Prefer exact process steps over general advice.
- Do not invent clicks, fields, URLs, or actions that are not in the sources.
- citation_ids must contain only source ids that directly support the answer.
""".strip()

    user = (
        f"Document: {document.get('title') or 'Untitled'}\n"
        f"Question: {question}\n\n"
        f"Grounded sources:\n\n" + "\n\n".join(context_lines)
    )

    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": "gpt-4o-mini",
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.1,
            },
            timeout=120,
        )
        if not response.ok:
            return {"ok": False, "error": response.text[:300]}

        payload = json.loads(response.json()["choices"][0]["message"]["content"])
        citation_ids = [str(item) for item in payload.get("citation_ids", []) if isinstance(item, str)]

        citations = []
        seen = set()
        for source in selected:
            if source["id"] in citation_ids and source["id"] not in seen:
                seen.add(source["id"])
                citations.append({"id": source["id"], "label": source["label"]})

        return {
            "ok": True,
            **defaults,
            "answer_markdown": str(payload.get("answer_markdown", "")).strip() or "I couldn't produce a grounded answer.",
            "citations": citations,
            "used_ai": True,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def answer_document_question(document: Dict[str, Any], question: str) -> Dict[str, Any]:
    question = str(question or "").strip()
    if not question:
        raise ValueError("question is required")

    sources = _build_sources(document)
    selected = _select_sources(question, sources)

    ai = _ai_answer(question, selected, document)
    if ai.get("ok"):
        return ai

    return _heuristic_answer(question, selected, document)
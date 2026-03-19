"""
JSON-backed storage service.

WHAT THIS FILE DOES
1. Creates and maintains the JSON store
2. Saves sessions, documents, screenshots, and meetings
3. Supports latest-item retrieval and basic search
4. Persists screenshot image files and meeting audio files
"""

from __future__ import annotations

import base64
import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
STORE_PATH = DATA_DIR / "store.json"
SCREENSHOTS_DIR = DATA_DIR / "screenshots"
MEETINGS_DIR = DATA_DIR / "meetings"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_store_exists() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    MEETINGS_DIR.mkdir(parents=True, exist_ok=True)

    if not STORE_PATH.exists():
        STORE_PATH.write_text(
            json.dumps(
                {"sessions": {}, "documents": [], "workflows": [], "screenshots": [], "meetings": []},
                indent=2,
            ),
            encoding="utf-8",
        )


def _normalize_store(data: Dict[str, Any]) -> Dict[str, Any]:
    data.setdefault("sessions", {})
    data.setdefault("documents", [])
    data.setdefault("workflows", [])
    data.setdefault("screenshots", [])
    data.setdefault("meetings", [])
    return data


def read_store() -> Dict[str, Any]:
    ensure_store_exists()
    data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    return _normalize_store(data)


def write_store(data: Dict[str, Any]) -> None:
    ensure_store_exists()
    STORE_PATH.write_text(json.dumps(_normalize_store(data), indent=2), encoding="utf-8")


def upsert_session(session_id: str, page: Dict[str, Any], actions: List[Dict[str, Any]], steps: List[str]) -> Dict[str, Any]:
    data = read_store()
    sessions = data.get("sessions", {})
    existing = sessions.get(session_id)

    if not existing:
        existing = {
            "session_id": session_id,
            "page": page,
            "actions": [],
            "steps": [],
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }

    existing["page"] = page
    existing["actions"].extend(deepcopy(actions))
    existing["steps"] = deepcopy(steps)
    existing["updated_at"] = _now_iso()

    sessions[session_id] = existing
    data["sessions"] = sessions
    write_store(data)
    return existing


def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    data = read_store()
    return data.get("sessions", {}).get(session_id)


# ✅ REQUIRED by automation.py (your crash)
def list_sessions() -> List[Dict[str, Any]]:
    data = read_store()
    return list(data.get("sessions", {}).values())


def save_documents(
    session_id: str,
    documents: List[Dict[str, Any]],
    audit: Dict[str, Any],
    extra_fields: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    data = read_store()
    existing_documents = data.get("documents", [])
    saved = []

    for doc in documents:
        record = deepcopy(doc)
        record["session_id"] = session_id
        record["audit"] = deepcopy(audit)
        record["created_at"] = _now_iso()
        if extra_fields:
            record.update(deepcopy(extra_fields))
        existing_documents.append(record)
        saved.append(record)

    data["documents"] = existing_documents
    write_store(data)
    return saved

def get_latest_document(session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    documents = data.get("documents", [])
    if session_id:
        documents = [doc for doc in documents if doc.get("session_id") == session_id]
    if not documents:
        return None
    documents = sorted(documents, key=lambda item: item.get("created_at", ""), reverse=True)
    return documents[0]

def get_sessions_by_ids(session_ids: List[str]) -> List[Dict[str, Any]]:
    data = read_store()
    sessions = data.get("sessions", {})
    items = [deepcopy(sessions[sid]) for sid in session_ids if sid in sessions]
    return sorted(items, key=lambda item: item.get("created_at", ""))


def get_process_evidence_summary(
    session_ids: List[str],
    meeting_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    data = read_store()
    session_set = {sid for sid in session_ids if sid}
    meeting_set = {mid for mid in (meeting_ids or []) if mid}

    screenshots = [item for item in data.get("screenshots", []) if item.get("session_id") in session_set]
    meetings = [item for item in data.get("meetings", []) if item.get("meeting_id") in meeting_set]

    latest_screenshot = None
    if screenshots:
        latest_screenshot = sorted(screenshots, key=lambda item: item.get("created_at", ""), reverse=True)[0]

    latest_meeting = None
    if meetings:
        latest_meeting = sorted(meetings, key=lambda item: item.get("created_at", ""), reverse=True)[0]

    excerpt = ""
    if latest_meeting:
        notes = latest_meeting.get("notes", {}) or {}
        excerpt = str(notes.get("summary") or latest_meeting.get("transcript") or "").strip()[:400]

    return {
        "session_ids": list(session_set),
        "meeting_ids": list(meeting_set),
        "screenshot_count": len(screenshots),
        "meeting_count": len(meetings),
        "latest_screenshot": latest_screenshot,
        "latest_meeting": latest_meeting,
        "latest_meeting_excerpt": excerpt,
    }

def get_document_item(created_at: Optional[str] = None, session_id: Optional[str] = None, title: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    documents = sorted(data.get("documents", []), key=lambda item: item.get("created_at", ""), reverse=True)

    for doc in documents:
        if created_at and doc.get("created_at") != created_at:
            continue
        if session_id and doc.get("session_id") != session_id:
            continue
        if title and doc.get("title") != title:
            continue
        return doc

    return None

def update_document_item(
    created_at: str,
    session_id: Optional[str] = None,
    original_title: Optional[str] = None,
    title: str = "",
    summary: str = "",
    content: str = "",
) -> Optional[Dict[str, Any]]:
    data = read_store()
    documents = data.get("documents", [])

    for idx, doc in enumerate(documents):
        if created_at and doc.get("created_at") != created_at:
            continue
        if session_id and doc.get("session_id") != session_id:
            continue
        if original_title and doc.get("title") != original_title:
            continue

        updated = deepcopy(doc)
        updated["title"] = title.strip() or doc.get("title", "Untitled Document")
        updated["summary"] = summary.strip()
        updated["content"] = content
        updated["updated_at"] = _now_iso()

        documents[idx] = updated
        data["documents"] = documents
        write_store(data)
        return updated

    return None

def search_documents(query: str) -> List[Dict[str, Any]]:
    data = read_store()
    documents = data.get("documents", [])
    q = query.strip().lower()

    if not q:
        return sorted(documents, key=lambda item: item.get("created_at", ""), reverse=True)[:10]

    terms = [term for term in q.split() if term]
    scored = []

    for doc in documents:
        haystack = " ".join(
            [str(doc.get("title", "")), str(doc.get("summary", "")), str(doc.get("content", ""))]
        ).lower()
        score = 0
        for term in terms:
            score += haystack.count(term)
        if score > 0:
            scored.append((score, doc))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in scored[:20]]


def save_screenshot(
    session_id: str,
    page_url: str,
    page_title: str,
    data_url: str,
    caption: str = "",
    recommended: bool = False,
    step_index: int = 0,
) -> Dict[str, Any]:
    ensure_store_exists()

    if "," not in data_url:
        raise ValueError("Invalid screenshot data URL.")

    header, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)

    screenshot_id = f"screenshot_{uuid.uuid4().hex}"
    file_path = SCREENSHOTS_DIR / f"{screenshot_id}.png"
    file_path.write_bytes(raw)

    record = {
        "screenshot_id": screenshot_id,
        "session_id": session_id,
        "page_url": page_url,
        "page_title": page_title,
        "caption": caption,
        "recommended": bool(recommended),
        "step_index": int(step_index),
        "data_url": data_url,
        "relative_path": f"data/screenshots/{file_path.name}",
        "created_at": _now_iso(),
    }

    data = read_store()
    screenshots = data.get("screenshots", [])
    screenshots.append(record)
    data["screenshots"] = screenshots
    write_store(data)
    return record


def get_latest_screenshot(session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    screenshots = data.get("screenshots", [])
    if session_id:
        screenshots = [item for item in screenshots if item.get("session_id") == session_id]
    if not screenshots:
        return None
    screenshots = sorted(screenshots, key=lambda item: item.get("created_at", ""), reverse=True)
    return screenshots[0]

def list_screenshots(session_id: Optional[str] = None) -> List[Dict[str, Any]]:
    data = read_store()
    screenshots = data.get("screenshots", [])

    if session_id:
        screenshots = [item for item in screenshots if item.get("session_id") == session_id]

    return sorted(screenshots, key=lambda item: item.get("created_at", ""), reverse=True)

def list_screenshots_for_sessions(session_ids: List[str]) -> List[Dict[str, Any]]:
    session_set = {sid for sid in session_ids if sid}
    if not session_set:
        return []

    data = read_store()
    screenshots = [item for item in data.get("screenshots", []) if item.get("session_id") in session_set]
    return sorted(screenshots, key=lambda item: item.get("created_at", ""))

def get_screenshot_item(screenshot_id: str) -> Optional[Dict[str, Any]]:
    data = read_store()
    screenshots = data.get("screenshots", [])

    for item in screenshots:
        if item.get("screenshot_id") == screenshot_id:
            return item

    return None

def save_meeting_record(
    session_id: str,
    tab_id: str,
    page_url: str,
    page_title: str,
    file_name: str,
    relative_path: str,
    mime_type: str,
    transcript: str,
    notes: Dict[str, Any],
) -> Dict[str, Any]:
    data = read_store()
    meetings = data.get("meetings", [])

    record = {
        "meeting_id": f"meeting_{uuid.uuid4().hex}",
        "session_id": session_id,
        "tab_id": tab_id,
        "page_url": page_url,
        "page_title": page_title,
        "file_name": file_name,
        "relative_path": relative_path,
        "mime_type": mime_type,
        "transcript": transcript,
        "notes": notes,
        "created_at": _now_iso(),
    }

    meetings.append(record)
    data["meetings"] = meetings
    write_store(data)
    return record


def get_latest_meeting(session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    meetings = data.get("meetings", [])
    if session_id:
        meetings = [item for item in meetings if item.get("session_id") == session_id]
    if not meetings:
        return None
    meetings = sorted(meetings, key=lambda item: item.get("created_at", ""), reverse=True)
    return meetings[0]


def save_uploaded_meeting_file(file_name: str, content: bytes) -> Dict[str, str]:
    ensure_store_exists()
    safe_id = uuid.uuid4().hex
    suffix = Path(file_name).suffix or ".webm"
    final_name = f"meeting_{safe_id}{suffix}"
    file_path = MEETINGS_DIR / final_name
    file_path.write_bytes(content)

    return {
        "file_name": final_name,
        "absolute_path": str(file_path),
        "relative_path": f"data/meetings/{final_name}",
    }


def get_session_evidence_summary(session_id: str) -> Dict[str, Any]:
    data = read_store()
    screenshots = [item for item in data.get("screenshots", []) if item.get("session_id") == session_id]
    meetings = [item for item in data.get("meetings", []) if item.get("session_id") == session_id]

    latest_meeting = None
    if meetings:
        latest_meeting = sorted(meetings, key=lambda item: item.get("created_at", ""), reverse=True)[0]

    excerpt = ""
    if latest_meeting and latest_meeting.get("transcript"):
        excerpt = latest_meeting["transcript"][:240]

    return {
        "screenshot_count": len(screenshots),
        "meeting_count": len(meetings),
        "latest_meeting_excerpt": excerpt,
    }

def get_meeting_item(meeting_id: Optional[str] = None, created_at: Optional[str] = None, session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    meetings = sorted(data.get("meetings", []), key=lambda item: item.get("created_at", ""), reverse=True)

    for meeting in meetings:
        if meeting_id and meeting.get("meeting_id") != meeting_id:
            continue
        if created_at and meeting.get("created_at") != created_at:
            continue
        if session_id and meeting.get("session_id") != session_id:
            continue
        return meeting

    return None

# Added for Library support (Meetings tab)
def list_meetings() -> List[Dict[str, Any]]:
    data = read_store()
    meetings = data.get("meetings", [])
    return sorted(meetings, key=lambda m: m.get("created_at", ""), reverse=True)


def search_meetings(query: str) -> List[Dict[str, Any]]:
    data = read_store()
    meetings = data.get("meetings", [])
    q = (query or "").strip().lower()
    if not q:
        return sorted(meetings, key=lambda m: m.get("created_at", ""), reverse=True)[:50]

    terms = [t for t in q.split() if t]
    scored: List[tuple[int, Dict[str, Any]]] = []
    for m in meetings:
        notes = m.get("notes") or {}
        hay = " ".join([
            str(m.get("page_title", "")),
            str(m.get("page_url", "")),
            str(notes.get("summary", "")),
            str(notes.get("minutes_markdown", "")),
            str(m.get("transcript", "")),
        ]).lower()
        score = 0
        for term in terms:
            score += hay.count(term)
        if score > 0:
            scored.append((score, m))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [x[1] for x in scored[:50]]

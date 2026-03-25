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
import math
import os
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
STORE_PATH = DATA_DIR / "store.json"
SCREENSHOTS_DIR = DATA_DIR / "screenshots"
MEETINGS_DIR = DATA_DIR / "meetings"

PLAN_LIMITS = {
    "free": {
        "documents_generated": 25,
        "screenshots_saved": 100,
        "meetings_uploaded": 10,
        "external_docs_generated": 10,
    },
    "paid": {
        "documents_generated": None,
        "screenshots_saved": None,
        "meetings_uploaded": None,
        "external_docs_generated": None,
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _blank_usage() -> Dict[str, int]:
    return {
        "sessions_created": 0,
        "documents_generated": 0,
        "screenshots_saved": 0,
        "meetings_uploaded": 0,
        "meeting_minutes_processed": 0,
        "external_docs_generated": 0,
    }

def ensure_store_exists() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    MEETINGS_DIR.mkdir(parents=True, exist_ok=True)

    if not STORE_PATH.exists():
        STORE_PATH.write_text(
            json.dumps(
                {
                    "sessions": {},
                    "documents": [],
                    "workflows": [],
                    "screenshots": [],
                    "meetings": [],
                    "users": {},
                },
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
    data.setdefault("users", {})
    return data


def read_store() -> Dict[str, Any]:
    ensure_store_exists()
    data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    return _normalize_store(data)


def write_store(data: Dict[str, Any]) -> None:
    ensure_store_exists()
    STORE_PATH.write_text(json.dumps(_normalize_store(data), indent=2), encoding="utf-8")

def _normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def _normalize_user_record(record: Dict[str, Any]) -> Dict[str, Any]:
    item = deepcopy(record)
    item["email"] = _normalize_email(item.get("email", ""))
    item["name"] = str(item.get("name") or "").strip()
    plan = str(item.get("plan") or "free").strip().lower()
    item["plan"] = plan if plan in PLAN_LIMITS else "free"
    usage = deepcopy(item.get("usage") or {})
    for key, default_value in _blank_usage().items():
        usage[key] = int(usage.get(key, default_value) or 0)
    item["usage"] = usage
    item.setdefault("created_at", _now_iso())
    item.setdefault("updated_at", item["created_at"])
    item.setdefault("last_seen_at", item["created_at"])
    return item


def upsert_user(email: str, name: str = "", user_id: str = "") -> Dict[str, Any]:
    normalized_email = _normalize_email(email)
    normalized_name = str(name or "").strip()
    provided_user_id = str(user_id or "").strip()

    if not normalized_email and not provided_user_id:
        raise ValueError("email or user_id is required")

    data = read_store()
    users = data.get("users", {})

    target_user_id = None

    # First, try to find an existing user by email.
    if normalized_email:
        for existing_id, existing_user in users.items():
            if _normalize_email(existing_user.get("email", "")) == normalized_email:
                target_user_id = existing_id
                break

    # Only fall back to a provided user_id when it does not conflict with a different email.
    if not target_user_id and provided_user_id and provided_user_id in users:
        existing_user = users[provided_user_id]
        existing_email = _normalize_email(existing_user.get("email", ""))

        if not normalized_email or existing_email == normalized_email:
            target_user_id = provided_user_id

    if not target_user_id:
        target_user_id = provided_user_id or f"user_{uuid.uuid4().hex}"
        users[target_user_id] = {
            "user_id": target_user_id,
            "email": normalized_email,
            "name": normalized_name,
            "plan": "free",
            "usage": _blank_usage(),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "last_seen_at": _now_iso(),
        }
    else:
        existing = _normalize_user_record(users[target_user_id])
        if normalized_email:
            existing["email"] = normalized_email
        if normalized_name:
            existing["name"] = normalized_name
        existing["updated_at"] = _now_iso()
        existing["last_seen_at"] = _now_iso()
        users[target_user_id] = existing

    data["users"] = users
    write_store(data)
    return _normalize_user_record(users[target_user_id])


def get_user(user_id: Optional[str] = None, email: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    users = data.get("users", {})

    resolved_user_id = str(user_id or "").strip()
    if resolved_user_id and resolved_user_id in users:
        return _normalize_user_record(users[resolved_user_id])

    normalized_email = _normalize_email(email or "")
    if normalized_email:
        for existing in users.values():
            if _normalize_email(existing.get("email", "")) == normalized_email:
                return _normalize_user_record(existing)

    return None


def set_user_plan(user_id: str, plan: str) -> Optional[Dict[str, Any]]:
    normalized_plan = str(plan or "").strip().lower()
    if normalized_plan not in PLAN_LIMITS:
        raise ValueError("plan must be 'free' or 'paid'")

    data = read_store()
    users = data.get("users", {})
    if user_id not in users:
        return None

    user = _normalize_user_record(users[user_id])
    user["plan"] = normalized_plan
    user["updated_at"] = _now_iso()
    user["last_seen_at"] = _now_iso()
    users[user_id] = user
    data["users"] = users
    write_store(data)
    return user


def increment_user_usage(user_id: Optional[str], **deltas: int) -> Optional[Dict[str, Any]]:
    resolved_user_id = str(user_id or "").strip()
    if not resolved_user_id:
        return None

    data = read_store()
    users = data.get("users", {})
    if resolved_user_id not in users:
        return None

    user = _normalize_user_record(users[resolved_user_id])
    usage = user.get("usage", _blank_usage())

    for key, delta in deltas.items():
        if key not in usage:
            usage[key] = 0
        usage[key] = max(0, int(usage.get(key, 0) or 0) + int(delta or 0))

    user["usage"] = usage
    user["updated_at"] = _now_iso()
    user["last_seen_at"] = _now_iso()
    users[resolved_user_id] = user
    data["users"] = users
    write_store(data)
    return user


def get_user_status(user_id: Optional[str] = None, email: Optional[str] = None) -> Optional[Dict[str, Any]]:
    user = get_user(user_id=user_id, email=email)
    if not user:
        return None

    plan = user.get("plan", "free")
    return {
        "user_id": user.get("user_id", ""),
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "plan": plan,
        "usage": deepcopy(user.get("usage") or _blank_usage()),
        "limits": deepcopy(PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])),
        "created_at": user.get("created_at", ""),
        "updated_at": user.get("updated_at", ""),
        "last_seen_at": user.get("last_seen_at", ""),
    }


def get_usage_limit_status(user_id: Optional[str], usage_key: str, amount: int = 1) -> Dict[str, Any]:
    resolved_user_id = str(user_id or "").strip()
    requested_amount = max(1, int(amount or 1))

    if usage_key not in _blank_usage():
        raise ValueError(f"Unknown usage key: {usage_key}")

    if not resolved_user_id:
        return {
            "allowed": False,
            "reason": "account_required",
            "usage_key": usage_key,
            "requested_amount": requested_amount,
            "current": 0,
            "limit": None,
            "remaining": None,
            "plan": "",
            "user_id": "",
        }

    user = get_user(user_id=resolved_user_id)
    if not user:
        return {
            "allowed": False,
            "reason": "account_required",
            "usage_key": usage_key,
            "requested_amount": requested_amount,
            "current": 0,
            "limit": None,
            "remaining": None,
            "plan": "",
            "user_id": resolved_user_id,
        }

    plan = str(user.get("plan") or "free").strip().lower()
    usage = deepcopy(user.get("usage") or _blank_usage())
    current = int(usage.get(usage_key, 0) or 0)
    limit = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"]).get(usage_key)

    if limit is None:
        return {
            "allowed": True,
            "reason": "ok",
            "usage_key": usage_key,
            "requested_amount": requested_amount,
            "current": current,
            "limit": None,
            "remaining": None,
            "plan": plan,
            "user_id": resolved_user_id,
        }

    remaining = max(0, int(limit) - current)
    allowed = current + requested_amount <= int(limit)

    return {
        "allowed": allowed,
        "reason": "ok" if allowed else "limit_reached",
        "usage_key": usage_key,
        "requested_amount": requested_amount,
        "current": current,
        "limit": int(limit),
        "remaining": remaining,
        "plan": plan,
        "user_id": resolved_user_id,
    }

def _user_id_for_session(data: Dict[str, Any], session_id: str) -> str:
    session = data.get("sessions", {}).get(session_id) or {}
    return str(session.get("user_id") or "").strip()

def upsert_session(
    session_id: str,
    page: Dict[str, Any],
    actions: List[Dict[str, Any]],
    steps: List[str],
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    data = read_store()
    sessions = data.get("sessions", {})
    existing = sessions.get(session_id)
    was_created = existing is None

    if not existing:
        existing = {
            "session_id": session_id,
            "page": page,
            "actions": [],
            "steps": [],
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "user_id": str(user_id or "").strip(),
        }

    existing["page"] = page
    existing["actions"].extend(deepcopy(actions))
    existing["steps"] = deepcopy(steps)
    existing["updated_at"] = _now_iso()
    if user_id:
        existing["user_id"] = str(user_id).strip()

    sessions[session_id] = existing
    data["sessions"] = sessions
    write_store(data)

    if was_created and user_id:
        increment_user_usage(user_id, sessions_created=1)

    return existing

def _source_meta_for_basis(source_basis: str) -> Dict[str, str]:
    mapping = {
        "internal_capture": {
            "source_label": "Internal workflow",
            "source_note": "Built from captured browser actions, screenshots, and any explicitly included process evidence.",
        },
        "internal_draft": {
            "source_label": "Internal draft",
            "source_note": "Internal content with no verified captured workflow attached yet.",
        },
        "trusted_external": {
            "source_label": "Trusted external",
            "source_note": "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout.",
        },
        "mixed": {
            "source_label": "Mixed sources",
            "source_note": "Combines internal workflow evidence with trusted external references. Verify against your team process before following.",
        },
        "community": {
            "source_label": "Community source",
            "source_note": "Based on community guidance and should be verified against trusted documentation before use.",
        },
    }
    return mapping.get(source_basis, mapping["internal_draft"])


def _normalize_document_source(document: Dict[str, Any]) -> Dict[str, Any]:
    item = deepcopy(document)
    source_basis = str(item.get("source_basis") or "").strip()

    if not source_basis:
        source_basis = "internal_capture" if item.get("source_session_ids") or item.get("session_id") else "internal_draft"
        item["source_basis"] = source_basis

    source_meta = _source_meta_for_basis(source_basis)
    item.setdefault("source_label", source_meta["source_label"])
    item.setdefault("source_note", source_meta["source_note"])
    return item

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

    session_user_id = _user_id_for_session(data, session_id) if session_id else ""

    for doc in documents:
        record = deepcopy(doc)
        record["session_id"] = session_id
        record["audit"] = deepcopy(audit)
        record["created_at"] = _now_iso()
        if extra_fields:
            record.update(deepcopy(extra_fields))
        if not record.get("user_id") and session_user_id:
            record["user_id"] = session_user_id
        record = _normalize_document_source(record)
        existing_documents.append(record)
        saved.append(record)

    data["documents"] = existing_documents
    write_store(data)

    for item in saved:
        resolved_user_id = str(item.get("user_id") or session_user_id or "").strip()
        deltas = {"documents_generated": 1}
        if item.get("source_basis") == "trusted_external":
            deltas["external_docs_generated"] = 1
        increment_user_usage(resolved_user_id, **deltas)

    return saved

def get_latest_document(session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    data = read_store()
    documents = data.get("documents", [])
    if session_id:
        documents = [doc for doc in documents if doc.get("session_id") == session_id]
    if not documents:
        return None
    documents = sorted(documents, key=lambda item: item.get("created_at", ""), reverse=True)
    return _normalize_document_source(documents[0])

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
        return _normalize_document_source(doc)

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

        updated = _normalize_document_source(updated)
        documents[idx] = updated
        data["documents"] = documents
        write_store(data)
        return updated

    return None

def search_documents(query: str) -> List[Dict[str, Any]]:
    data = read_store()
    documents = data.get("documents", [])
    q = str(query or "").strip().lower()
    if not q:
        docs = sorted(documents, key=lambda item: item.get("created_at", ""), reverse=True)
        return [_normalize_document_source(item) for item in docs[:20]]

    terms = [term for term in q.split() if term]
    scored = []

    for doc in documents:
        haystack = " ".join(
            [
                str(doc.get("title", "")),
                str(doc.get("summary", "")),
                str(doc.get("content", "")),
                str(doc.get("session_id", "")),
                str(doc.get("doc_type", "")),
                str(doc.get("source_label", "")),
                str(doc.get("source_note", "")),
            ]
        ).lower()
        score = 0
        for term in terms:
            score += haystack.count(term)
        if score > 0:
            scored.append((score, doc))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [_normalize_document_source(item[1]) for item in scored[:20]]

def save_screenshot(
    session_id: str,
    page_url: str,
    page_title: str,
    data_url: str,
    caption: str = "",
    recommended: bool = False,
    step_index: int = 0,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    ensure_store_exists()

    if "," not in data_url:
        raise ValueError("Invalid screenshot data URL.")

    header, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)

    screenshot_id = f"screenshot_{uuid.uuid4().hex}"
    file_path = SCREENSHOTS_DIR / f"{screenshot_id}.png"
    file_path.write_bytes(raw)

    data = read_store()
    resolved_user_id = str(user_id or _user_id_for_session(data, session_id) or "").strip()

    record = {
        "screenshot_id": screenshot_id,
        "session_id": session_id,
        "user_id": resolved_user_id,
        "page_url": page_url,
        "page_title": page_title,
        "caption": caption,
        "recommended": bool(recommended),
        "step_index": int(step_index),
        "data_url": data_url,
        "relative_path": f"data/screenshots/{file_path.name}",
        "created_at": _now_iso(),
    }

    screenshots = data.get("screenshots", [])
    screenshots.append(record)
    data["screenshots"] = screenshots
    write_store(data)

    increment_user_usage(resolved_user_id, screenshots_saved=1)
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
    user_id: Optional[str] = None,
    duration_seconds: int = 0,
) -> Dict[str, Any]:
    data = read_store()
    meetings = data.get("meetings", [])
    resolved_user_id = str(user_id or _user_id_for_session(data, session_id) or "").strip()

    record = {
        "meeting_id": f"meeting_{uuid.uuid4().hex}",
        "session_id": session_id,
        "user_id": resolved_user_id,
        "tab_id": tab_id,
        "page_url": page_url,
        "page_title": page_title,
        "file_name": file_name,
        "relative_path": relative_path,
        "mime_type": mime_type,
        "transcript": transcript,
        "notes": notes,
        "duration_seconds": int(duration_seconds or 0),
        "created_at": _now_iso(),
    }

    meetings.append(record)
    data["meetings"] = meetings
    write_store(data)

    usage_deltas = {"meetings_uploaded": 1}
    if duration_seconds:
        usage_deltas["meeting_minutes_processed"] = int(math.ceil(max(0, duration_seconds) / 60))
    increment_user_usage(resolved_user_id, **usage_deltas)
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
    if latest_meeting:
        notes = latest_meeting.get("notes", {}) or {}
        excerpt = str(notes.get("summary") or latest_meeting.get("transcript") or "").strip()[:400]

    latest_screenshot = None
    if screenshots:
        latest_screenshot = sorted(screenshots, key=lambda item: item.get("created_at", ""), reverse=True)[0]

    return {
        "session_id": session_id,
        "screenshot_count": len(screenshots),
        "meeting_count": len(meetings),
        "latest_screenshot": latest_screenshot,
        "latest_meeting": latest_meeting,
        "latest_meeting_excerpt": excerpt,
    }

def get_meeting_item(
    meeting_id: Optional[str] = None,
    created_at: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    meetings = list_meetings()
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
    return sorted(meetings, key=lambda item: item.get("created_at", ""), reverse=True)


def search_meetings(query: str) -> List[Dict[str, Any]]:
    data = read_store()
    meetings = data.get("meetings", [])
    q = str(query or "").strip().lower()
    if not q:
        return sorted(meetings, key=lambda item: item.get("created_at", ""), reverse=True)[:20]

    terms = [term for term in q.split() if term]
    scored = []

    for meeting in meetings:
        notes = meeting.get("notes", {}) or {}
        haystack = " ".join(
            [
                str(meeting.get("page_title", "")),
                str(meeting.get("page_url", "")),
                str(meeting.get("session_id", "")),
                str(meeting.get("transcript", "")),
                str(notes.get("summary", "")),
                str(notes.get("minutes", "")),
                str(notes.get("action_items", "")),
            ]
        ).lower()
        score = 0
        for term in terms:
            score += haystack.count(term)
        if score > 0:
            scored.append((score, meeting))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in scored[:20]]

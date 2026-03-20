from __future__ import annotations

from pathlib import Path

import requests

from dotenv import load_dotenv

# Load backend/.env before importing services that read environment variables.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import Response

from app.models import (
    AuditRequest,
    AutomationRequest,
    DocumentUpdateRequest,
    DocumentAskRequest,
    ExternalAssistAskRequest,
    ExternalDocumentGenerateRequest,
    GenerateRequest,
    IngestRequest,
    ProcessGenerateRequest,
)
from app.services.audit import run_audit
from app.services.automation import suggest_automation
from app.services.docs import actions_to_steps, dedupe_actions, generate_document_options
from app.services.export_docs import build_docx_bytes, build_email_draft_bytes, build_pdf_bytes
from app.services.meetings import get_ai_status, save_meeting_upload, transcribe_audio_file
from app.services.notes import build_meeting_notes
from app.services.qa import answer_document_question
from app.services.external_docs import answer_external_question, generate_external_document
from app.services.store import (
    ensure_store_exists,
    get_latest_document,
    get_latest_meeting,
    get_latest_screenshot,
    get_session,
    get_session_evidence_summary,
    save_documents,
    save_meeting_record,
    save_screenshot,
    search_documents,
    upsert_session,
    list_meetings,
    search_meetings,
    get_document_item,
    get_meeting_item,
    update_document_item,
    list_screenshots,
    get_screenshot_item,
    get_sessions_by_ids,
    get_process_evidence_summary,
    list_screenshots_for_sessions,
)

app = FastAPI(title="Continuum API", version="1.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    ensure_store_exists()

@app.get("/")
def root():
    return {"ok": True, "service": "continuum-api", "version": "1.3.0"}

@app.get("/health")
def health():
    return {"ok": True, "service": "continuum-api"}

@app.get("/config/status")
def config_status():
    ai = get_ai_status()
    return {
        "ok": True,
        "backend_env_loaded": True,
        "ai": ai,
        "meeting_features": {
            "transcription": ai["transcription_enabled"],
            "follow_up_notes": ai["notes_enabled"],
        },
    }

@app.post("/ingest-actions")
def ingest_actions(payload: IngestRequest):
    actions = [action.model_dump() for action in payload.actions]
    page = payload.page.model_dump()

    cleaned_actions = dedupe_actions(actions)
    steps = actions_to_steps(cleaned_actions, page)

    upsert_session(session_id=payload.session_id, page=page, actions=cleaned_actions, steps=steps)

    evidence = get_session_evidence_summary(payload.session_id)

    return {
        "ok": True,
        "session_id": payload.session_id,
        "steps": steps,
        "evidence_summary": evidence,
    }


def _guide_instruction_from_action(action: dict[str, Any]) -> str:
    kind = str(action.get("kind", "")).lower()
    label = str(action.get("targetLabel") or action.get("inputName") or action.get("targetSelector") or "item").strip()

    if kind == "click":
        return f"Click {label}."
    if kind == "change":
        if action.get("inputName"):
            return f"Update the {action.get('inputName')} field."
        return f"Update {label}."
    if kind == "submit":
        return f"Submit {label}."
    return f"Complete the {label} step."


def _build_guide_payload(document: dict[str, Any], backend_base_url: str) -> dict[str, Any]:
    source_session_ids = list(document.get("source_session_ids") or ([document.get("session_id")] if document.get("session_id") else []))
    sessions = get_sessions_by_ids(source_session_ids)
    if not sessions:
        raise HTTPException(status_code=404, detail="No source sessions found for this document.")

    screenshots = list_screenshots_for_sessions(source_session_ids)
    screenshots_by_session: dict[str, list[dict[str, Any]]] = {}
    for shot in screenshots:
        sid = shot.get("session_id")
        if not sid:
            continue
        screenshots_by_session.setdefault(sid, []).append(shot)

    steps: list[dict[str, Any]] = []
    for session in sessions:
        session_id = session.get("session_id", "")
        page = session.get("page", {}) or {}
        session_screens = screenshots_by_session.get(session_id, [])
        action_position = 0

        for action in session.get("actions", []) or []:
            kind = str(action.get("kind", "")).lower()
            if kind == "page_view":
                continue

            screenshot = session_screens[action_position] if action_position < len(session_screens) else (session_screens[-1] if session_screens else None)

            steps.append({
                "step_id": f"guide_step_{len(steps)+1}",
                "session_id": session_id,
                "page_url": str(action.get("pageUrl") or page.get("url") or ""),
                "page_title": str(action.get("pageTitle") or page.get("title") or ""),
                "action_kind": kind,
                "instruction": _guide_instruction_from_action(action),
                "target_label": str(action.get("targetLabel") or "").strip(),
                "target_selector": str(action.get("targetSelector") or "").strip(),
                "input_name": str(action.get("inputName") or "").strip(),
                "value_preview": str(action.get("valuePreview") or "").strip(),
                "screenshot_url": f"{backend_base_url.rstrip('/')}/screenshots/{screenshot.get('screenshot_id')}" if screenshot and screenshot.get("screenshot_id") else "",
                "screenshot_caption": str((screenshot or {}).get("caption") or "Screenshot"),
            })
            action_position += 1

    if not steps:
        raise HTTPException(status_code=400, detail="No guided steps could be built from the captured sessions.")

    return {
        "document_title": document.get("title") or "Guided Run",
        "document_summary": document.get("summary") or "",
        "document_created_at": document.get("created_at") or "",
        "document_session_id": document.get("session_id") or "",
        "source_session_ids": source_session_ids,
        "steps": steps,
        "start_url": steps[0].get("page_url") or sessions[0].get("page", {}).get("url") or "",
    }

@app.post("/docs/generate")
def generate_docs(payload: GenerateRequest):
    session = get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    page = session.get("page", {})
    steps = session.get("steps", [])
    evidence = get_session_evidence_summary(payload.session_id)
    intent = payload.intent.model_dump() if payload.intent else None

    documents = generate_document_options(payload.session_id, page, steps, evidence=evidence, intent=intent)
    primary = documents[0:1]

    rules = payload.rules.model_dump() if payload.rules else None
    audit = run_audit(primary[0]["content"], rules)
    saved_documents = save_documents(
        payload.session_id,
        primary,
        audit,
        extra_fields={"doc_type": (intent or {}).get("doc_type", "sop")},
    )

    return {
        "ok": True,
        "session_id": payload.session_id,
        "steps": steps,
        "primary_document": saved_documents[0] if saved_documents else None,
        "options": saved_documents,
        "audit": audit,
    }

@app.post("/docs/generate-process")
def generate_docs_for_process(payload: ProcessGenerateRequest):
    if not payload.session_ids:
        raise HTTPException(status_code=400, detail="At least one included session is required.")

    sessions = get_sessions_by_ids(payload.session_ids)
    if not sessions:
        raise HTTPException(status_code=404, detail="No included sessions were found.")

    intent = payload.intent.model_dump() if payload.intent else None
    primary_page = sessions[0].get("page", {})

    steps = []
    for session in sessions:
        steps.extend(session.get("steps", []))

    if not steps:
        raise HTTPException(status_code=400, detail="No captured steps were found for the included tabs.")

    evidence = get_process_evidence_summary(payload.session_ids, payload.meeting_ids)
    documents = generate_document_options(
        payload.process_id or payload.session_ids[0],
        primary_page,
        steps,
        evidence=evidence,
        intent=intent,
    )
    primary = documents[0:1]

    rules = payload.rules.model_dump() if payload.rules else None
    audit = run_audit(primary[0]["content"], rules)

    saved_documents = save_documents(
        payload.session_ids[0],
        primary,
        audit,
        extra_fields={
            "doc_type": (intent or {}).get("doc_type", "sop"),
            "process_id": payload.process_id or "",
            "source_session_ids": payload.session_ids,
            "included_meeting_ids": payload.meeting_ids,
        },
    )

    return {
        "ok": True,
        "process_id": payload.process_id,
        "session_ids": payload.session_ids,
        "meeting_ids": payload.meeting_ids,
        "steps": steps,
        "primary_document": saved_documents[0] if saved_documents else None,
        "options": saved_documents,
        "audit": audit,
    }

@app.post("/external/ask")
def external_ask(payload: ExternalAssistAskRequest):
    try:
        answer = answer_external_question(
            topic=payload.topic,
            question=payload.question,
            doc_type=payload.doc_type,
            audience=payload.audience,
            notes=payload.notes,
            source_urls=payload.source_urls,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except requests.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not load one of the trusted sources: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return {"ok": True, "answer": answer}

@app.post("/docs/generate-external")
def generate_external_doc(payload: ExternalDocumentGenerateRequest):
    try:
        document, fetched_sources = generate_external_document(
            topic=payload.topic,
            doc_type=payload.doc_type,
            audience=payload.audience,
            notes=payload.notes,
            source_urls=payload.source_urls,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except requests.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not load one of the trusted sources: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    audit = run_audit(document["content"], None)
    saved = save_documents(
        session_id="",
        documents=[document],
        audit=audit,
        extra_fields={
            "doc_type": payload.doc_type or "sop",
            "source_basis": "trusted_external",
            "trusted_source_urls": [src["url"] for src in fetched_sources],
            "trusted_source_titles": [src["title"] for src in fetched_sources],
        },
    )

    return {
        "ok": True,
        "primary_document": saved[0] if saved else None,
        "sources": [{"title": src["title"], "url": src["url"], "host": src["host"]} for src in fetched_sources],
        "audit": audit,
    }

@app.get("/docs/search")
def docs_search(query: str = Query(default="")):
    items = search_documents(query)
    return {"ok": True, "items": items, "count": len(items)}

@app.get("/docs/item")
def docs_item(created_at: str | None = None, session_id: str | None = None, title: str | None = None):
    item = get_document_item(created_at=created_at, session_id=session_id, title=title)
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"ok": True, "item": item}

@app.get("/docs/guide")
def docs_guide(created_at: str | None = None, session_id: str | None = None, title: str | None = None):
    item = get_document_item(created_at=created_at, session_id=session_id, title=title)
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")

    guide = _build_guide_payload(item, backend_base_url="http://127.0.0.1:8000")
    return {"ok": True, "guide": guide}

@app.post("/docs/ask")
def docs_ask(payload: DocumentAskRequest):
    item = get_document_item(
        created_at=payload.created_at,
        session_id=payload.session_id,
        title=payload.title,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")

    try:
        answer = answer_document_question(item, payload.question)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"ok": True, "item": item, "answer": answer}

@app.get("/docs/export/docx")
def docs_export_docx(created_at: str | None = None, session_id: str | None = None, title: str | None = None):
    item = get_document_item(created_at=created_at, session_id=session_id, title=title)
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")

    content, filename = build_docx_bytes(item)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/docs/export/pdf")
def docs_export_pdf(created_at: str | None = None, session_id: str | None = None, title: str | None = None):
    item = get_document_item(created_at=created_at, session_id=session_id, title=title)
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")

    content, filename = build_pdf_bytes(item)
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/docs/export/email-draft")
def docs_export_email_draft(
    created_at: str | None = None,
    session_id: str | None = None,
    title: str | None = None,
    attachment_format: str = Query(default="docx"),
):
    item = get_document_item(created_at=created_at, session_id=session_id, title=title)
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")

    fmt = (attachment_format or "docx").lower()
    if fmt not in {"docx", "pdf"}:
        raise HTTPException(status_code=400, detail="attachment_format must be 'docx' or 'pdf'.")

    content, filename = build_email_draft_bytes(item, attachment_format=fmt)
    return Response(
        content=content,
        media_type="message/rfc822",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.post("/docs/update")
def docs_update(payload: DocumentUpdateRequest):
    item = update_document_item(
        created_at=payload.created_at,
        session_id=payload.session_id,
        original_title=payload.original_title,
        title=payload.title,
        summary=payload.summary,
        content=payload.content,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"ok": True, "item": item}

@app.get("/docs/latest")
def docs_latest(session_id: str | None = None):
    item = get_latest_document(session_id=session_id)
    return {"ok": True, "item": item}

@app.post("/audit-check")
def audit_check(payload: AuditRequest):
    rules = payload.rules.model_dump() if payload.rules else None
    result = run_audit(payload.content, rules)
    return {"ok": True, **result}

@app.post("/automate-step")
def automate_step(payload: AutomationRequest):
    session = get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    suggestions = suggest_automation(payload.session_id)
    return {"ok": True, "session_id": payload.session_id, "suggestions": suggestions}

@app.get("/sessions/evidence-summary")
def evidence_summary(session_id: str):
    summary = get_session_evidence_summary(session_id)
    return {"ok": True, "summary": summary}

@app.post("/sessions/screenshot")
def sessions_screenshot(payload: dict):
    session_id = str(payload.get("session_id", "")).strip()
    page_url = str(payload.get("page_url", "")).strip()
    page_title = str(payload.get("page_title", "")).strip()
    data_url = str(payload.get("data_url", "")).strip()
    caption = str(payload.get("caption", "")).strip()
    recommended = bool(payload.get("recommended", False))
    step_index = int(payload.get("step_index", 0) or 0)

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required.")
    if not data_url:
        raise HTTPException(status_code=400, detail="data_url is required.")

    screenshot = save_screenshot(
        session_id=session_id,
        page_url=page_url,
        page_title=page_title,
        data_url=data_url,
        caption=caption,
        recommended=recommended,
        step_index=step_index,
    )
    return {"ok": True, "screenshot": screenshot}

@app.get("/sessions/latest-screenshot")
def sessions_latest_screenshot(session_id: str | None = None):
    item = get_latest_screenshot(session_id=session_id)
    return {"ok": True, "screenshot": item}

@app.get("/sessions/screenshots")
def sessions_screenshots(session_id: str | None = None):
    items = list_screenshots(session_id=session_id)
    return {"ok": True, "items": items, "count": len(items)}

@app.get("/screenshots/{screenshot_id}")
def screenshot_file(screenshot_id: str):
    item = get_screenshot_item(screenshot_id)
    if not item:
        raise HTTPException(status_code=404, detail="Screenshot not found.")

    relative_path = item.get("relative_path")
    if not relative_path:
        raise HTTPException(status_code=404, detail="Screenshot path missing.")

    file_path = Path(__file__).resolve().parent / relative_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Screenshot file missing on disk.")

    return FileResponse(file_path, media_type="image/png", filename=file_path.name)

@app.post("/meetings/upload")
async def meetings_upload(
    session_id: str = Form(...),
    tab_id: str = Form(default=""),
    page_url: str = Form(default=""),
    page_title: str = Form(default=""),
    notes_style: str = Form(default="professional_bullets"),
    mic_ok: str = Form(default="false"),
    tab_level: str = Form(default="0"),
    mic_level: str = Form(default="0"),
    file: UploadFile = File(...),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded meeting file is empty.")

    saved_file = save_meeting_upload(file_name=file.filename or "meeting.webm", content=content)

    transcription = transcribe_audio_file(saved_file["absolute_path"])
    transcript_text = transcription.get("text", "") or ""

    notes = build_meeting_notes(transcript=transcript_text, page_title=page_title, style=notes_style)
    notes.setdefault("warnings", [])

    for w in transcription.get("warnings", []):
        notes["warnings"].append(w)

    meeting = save_meeting_record(
        session_id=session_id,
        tab_id=tab_id,
        page_url=page_url,
        page_title=page_title,
        file_name=saved_file["file_name"],
        relative_path=saved_file["relative_path"],
        mime_type=file.content_type or "audio/webm",
        transcript=transcript_text,
        notes=notes,
    )

    return {"ok": True, "meeting": meeting}

@app.get("/meetings/item")
def meetings_item(meeting_id: str | None = None, created_at: str | None = None, session_id: str | None = None):
    meeting = get_meeting_item(meeting_id=meeting_id, created_at=created_at, session_id=session_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    return {"ok": True, "item": meeting}

@app.get("/meetings/latest")
def meetings_latest(session_id: str | None = None):
    meeting = get_latest_meeting(session_id=session_id)
    return {"ok": True, "meeting": meeting}

@app.get("/meetings/list")
def meetings_list():
    return {"ok": True, "items": list_meetings()}

@app.get("/meetings/search")
def meetings_search(query: str = Query(default="")):
    return {"ok": True, "items": search_meetings(query)}

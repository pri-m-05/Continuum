"""
FASTAPI ENTRYPOINT

WHAT THIS FILE DOES
1. Starts the API
2. Enables CORS for the extension
3. Accepts browser action batches
4. Generates document options
5. Audits docs
6. Searches docs
7. Saves screenshots
8. Accepts meeting audio uploads
9. Generates meeting transcripts + follow-up notes

"""

from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.models import (
    AuditRequest,
    AutomationRequest,
    GenerateRequest,
    IngestRequest,
)
from app.services.audit import run_audit
from app.services.automation import suggest_automation
from app.services.docs import actions_to_steps, dedupe_actions, generate_document_options
from app.services.meetings import save_meeting_upload, transcribe_audio_file
from app.services.notes import build_meeting_notes
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
)

app = FastAPI(title="Continuum API", version="1.1.0")

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
    
    return {
        "ok": True,
        "service": "continuum-api",
        "version": "1.1.0",
        "routes": [
            "/health",
            "/ingest-actions",
            "/docs/generate",
            "/docs/search",
            "/docs/latest",
            "/audit-check",
            "/automate-step",
            "/sessions/screenshot",
            "/meetings/upload",
            "/meetings/latest",
        ],
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "continuum-api"}


@app.post("/ingest-actions")
def ingest_actions(payload: IngestRequest):
    actions = [action.model_dump() for action in payload.actions]
    page = payload.page.model_dump()

    cleaned_actions = dedupe_actions(actions)
    steps = actions_to_steps(cleaned_actions, page)

    upsert_session(
        session_id=payload.session_id,
        page=page,
        actions=cleaned_actions,
        steps=steps,
    )

    evidence = get_session_evidence_summary(payload.session_id)

    documents = generate_document_options(
        session_id=payload.session_id,
        page=page,
        steps=steps,
        evidence=evidence,
    )

    rules = payload.rules.model_dump() if payload.rules else None
    audit = run_audit(documents[0]["content"], rules)
    saved_documents = save_documents(payload.session_id, documents, audit)

    return {
        "ok": True,
        "session_id": payload.session_id,
        "steps": steps,
        "primary_document": saved_documents[0] if saved_documents else None,
        "options": saved_documents,
        "audit": audit,
    }


@app.post("/docs/generate")
def generate_docs(payload: GenerateRequest):
    session = get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    page = session.get("page", {})
    steps = session.get("steps", [])
    evidence = get_session_evidence_summary(payload.session_id)

    documents = generate_document_options(
        payload.session_id,
        page,
        steps,
        evidence=evidence,
    )

    rules = payload.rules.model_dump() if payload.rules else None
    audit = run_audit(documents[0]["content"], rules)
    saved_documents = save_documents(payload.session_id, documents, audit)

    return {
        "ok": True,
        "session_id": payload.session_id,
        "steps": steps,
        "primary_document": saved_documents[0] if saved_documents else None,
        "options": saved_documents,
        "audit": audit,
    }


@app.get("/docs/search")
def docs_search(query: str = Query(default="")):
    items = search_documents(query)
    return {
        "ok": True,
        "items": items,
        "count": len(items),
    }


@app.get("/docs/latest")
def docs_latest(session_id: str | None = None):
    item = get_latest_document(session_id=session_id)
    return {
        "ok": True,
        "item": item,
    }


@app.post("/audit-check")
def audit_check(payload: AuditRequest):
    rules = payload.rules.model_dump() if payload.rules else None
    result = run_audit(payload.content, rules)
    return {
        "ok": True,
        **result,
    }


@app.post("/automate-step")
def automate_step(payload: AutomationRequest):
    session = get_session(payload.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    suggestions = suggest_automation(payload.session_id)
    return {
        "ok": True,
        "session_id": payload.session_id,
        "suggestions": suggestions,
    }


@app.post("/sessions/screenshot")
def sessions_screenshot(payload: dict):
    
    session_id = str(payload.get("session_id", "")).strip()
    page_url = str(payload.get("page_url", "")).strip()
    page_title = str(payload.get("page_title", "")).strip()
    data_url = str(payload.get("data_url", "")).strip()

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required.")
    if not data_url:
        raise HTTPException(status_code=400, detail="data_url is required.")

    screenshot = save_screenshot(
        session_id=session_id,
        page_url=page_url,
        page_title=page_title,
        data_url=data_url,
    )

    return {
        "ok": True,
        "screenshot": screenshot,
    }


@app.get("/sessions/latest-screenshot")
def sessions_latest_screenshot(session_id: str | None = None):
    item = get_latest_screenshot(session_id=session_id)
    return {
        "ok": True,
        "screenshot": item,
    }


@app.post("/meetings/upload")
async def meetings_upload(
    session_id: str = Form(...),
    tab_id: str = Form(default=""),
    page_url: str = Form(default=""),
    page_title: str = Form(default=""),
    file: UploadFile = File(...),
):
    
    content = await file.read()

    if not content:
        raise HTTPException(status_code=400, detail="Uploaded meeting file is empty.")

    saved_file = save_meeting_upload(file_name=file.filename or "meeting.webm", content=content)
    transcription = transcribe_audio_file(saved_file["absolute_path"])
    transcript_text = transcription.get("text", "") or ""

    notes = build_meeting_notes(transcript=transcript_text, page_title=page_title)

    for warning in transcription.get("warnings", []):
        notes.setdefault("warnings", [])
        notes["warnings"].append(warning)

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

    return {
        "ok": True,
        "meeting": meeting,
    }


@app.get("/meetings/latest")
def meetings_latest(session_id: str | None = None):
    meeting = get_latest_meeting(session_id=session_id)
    return {
        "ok": True,
        "meeting": meeting,
    }
"""
Meeting recording + transcription service.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, Dict

import requests

from app.services.store import save_uploaded_meeting_file

OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"


def get_openai_api_key() -> str:
    return os.getenv("OPENAI_API_KEY", "").strip()


def get_ai_status() -> Dict[str, Any]:
    key = get_openai_api_key()
    return {
        "provider": "openai",
        "configured": bool(key),
        "transcription_enabled": bool(key),
        "notes_enabled": bool(key),
    }


def save_meeting_upload(file_name: str, content: bytes) -> Dict[str, str]:
    return save_uploaded_meeting_file(file_name=file_name, content=content)


def transcribe_audio_file(absolute_path: str) -> Dict[str, Any]:
    openai_api_key = get_openai_api_key()

    if not openai_api_key:
        return {
            "status": "skipped",
            "provider": "none",
            "text": "",
            "warnings": [
                "OPENAI_API_KEY is not loaded on the backend, so transcript generation was skipped."
            ],
        }

    path = Path(absolute_path)
    if not path.exists():
        return {
            "status": "error",
            "provider": "none",
            "text": "",
            "warnings": [f"Uploaded meeting file not found: {absolute_path}"],
        }

    mime_type, _ = mimetypes.guess_type(path.name)
    mime_type = mime_type or "audio/webm"

    try:
        with path.open("rb") as file_handle:
            response = requests.post(
                OPENAI_TRANSCRIBE_URL,
                headers={
                    "Authorization": f"Bearer {openai_api_key}",
                },
                files={
                    "file": (path.name, file_handle, mime_type),
                },
                data={
                    "model": "gpt-4o-mini-transcribe",
                    "response_format": "json",
                },
                timeout=120,
            )

        if not response.ok:
            return {
                "status": "error",
                "provider": "openai",
                "text": "",
                "warnings": [
                    f"Transcription failed with status {response.status_code}: {response.text[:500]}"
                ],
            }

        payload = response.json()
        return {
            "status": "ok",
            "provider": "openai",
            "text": payload.get("text", "") or "",
            "warnings": [],
        }

    except Exception as exc:
        return {
            "status": "error",
            "provider": "openai",
            "text": "",
            "warnings": [f"Transcription error: {exc}"],
        }
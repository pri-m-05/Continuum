from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class PageMeta(BaseModel):
    url: str = ""
    title: str = ""

class UserAction(BaseModel):
    kind: str
    targetLabel: str = ""
    targetSelector: str = ""
    inputName: str = ""
    inputType: str = ""
    valuePreview: str = ""
    pageUrl: str = ""
    pageTitle: str = ""
    timestamp: int

class AuditRules(BaseModel):
    required_sections: List[str] = Field(default_factory=lambda: ["Purpose","Preconditions","Procedure","Controls","Evidence"])
    required_keywords: List[str] = Field(default_factory=list)
    prohibited_words: List[str] = Field(default_factory=list)

class CaptureIntentEvidence(BaseModel):
    screenshots: bool = True
    meeting: bool = False

class CaptureIntent(BaseModel):
    process_name: str = ""
    doc_type: str = "sop"
    audience: str = "team"
    notes: str = ""
    evidence: CaptureIntentEvidence = Field(default_factory=CaptureIntentEvidence)

class IngestRequest(BaseModel):
    session_id: str
    page: PageMeta
    actions: List[UserAction]
    rules: Optional[AuditRules] = None
    intent: Optional[CaptureIntent] = None

class GenerateRequest(BaseModel):
    session_id: str
    rules: Optional[AuditRules] = None
    intent: Optional[CaptureIntent] = None

class AuditRequest(BaseModel):
    content: str
    rules: Optional[AuditRules] = None

class AutomationRequest(BaseModel):
    session_id: str

class DocumentUpdateRequest(BaseModel):
    created_at: str
    session_id: Optional[str] = None
    original_title: Optional[str] = None
    title: str
    summary: str = ""
    content: str = ""

class ProcessGenerateRequest(BaseModel):
    process_id: str = ""
    session_ids: List[str] = Field(default_factory=list)
    meeting_ids: List[str] = Field(default_factory=list)
    rules: Optional[AuditRules] = None
    intent: Optional[CaptureIntent] = None
"""
Pydantic models shared across the backend.

WHAT THIS FILE DOES:
1. Defines the request payloads the extension sends
2. Defines structured audit rules
3. Defines document and response shapes

"""

from typing import List, Optional
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
    required_sections: List[str] = Field(
        default_factory=lambda: [
            "Purpose",
            "Preconditions",
            "Procedure",
            "Controls",
            "Evidence",
        ]
    )
    required_keywords: List[str] = Field(default_factory=list)
    prohibited_words: List[str] = Field(default_factory=list)


class IngestRequest(BaseModel):
    session_id: str
    page: PageMeta
    actions: List[UserAction]
    rules: Optional[AuditRules] = None


class GenerateRequest(BaseModel):
    session_id: str
    rules: Optional[AuditRules] = None


class AuditRequest(BaseModel):
    content: str
    rules: Optional[AuditRules] = None


class AutomationRequest(BaseModel):
    session_id: str
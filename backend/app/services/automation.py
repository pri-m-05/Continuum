"""
Automation suggestion service.

WHAT THIS FILE DOES:
1. Looks at one session's steps
2. Compares it against other captured sessions
3. Suggests simple automation opportunities

"""

from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import urlparse

from app.services.store import get_session, list_sessions


def suggest_automation(session_id: str) -> List[Dict[str, str]]:
    
    session = get_session(session_id)
    if not session:
        return []

    current_page = session.get("page", {})
    current_url = current_page.get("url", "")
    current_host = urlparse(current_url).netloc
    steps = session.get("steps", [])
    sessions = list_sessions()

    suggestions: List[Dict[str, str]] = []

    same_host_count = 0
    for item in sessions:
        url = item.get("page", {}).get("url", "")
        if urlparse(url).netloc == current_host and current_host:
            same_host_count += 1

    if same_host_count >= 3:
        suggestions.append(
            {
                "title": "Build a host-specific workflow template",
                "reason": f"This process host appears in {same_host_count} captured sessions. That is enough repetition to justify a reusable template.",
                "example": "Template idea: open record -> update fields -> submit -> store confirmation.",
            }
        )

    change_steps = [step for step in steps if step.lower().startswith("update field")]
    submit_steps = [step for step in steps if step.lower().startswith("submit")]
    click_steps = [step for step in steps if step.lower().startswith("click")]

    if len(change_steps) >= 2 and len(submit_steps) >= 1:
        suggestions.append(
            {
                "title": "Form-fill macro candidate",
                "reason": "This session contains multiple field updates followed by a submit. That usually maps well to browser automation.",
                "example": "Automation idea: preload field mappings, fill values, submit, then capture confirmation.",
            }
        )

    if len(click_steps) >= 4:
        suggestions.append(
            {
                "title": "Multi-click navigation macro candidate",
                "reason": "The workflow relies on repeated click navigation. That can often be reduced to a guided macro.",
                "example": "Automation idea: script the repeated navigation path and stop for final review before submit.",
            }
        )

    if not suggestions:
        suggestions.append(
            {
                "title": "No strong automation candidate yet",
                "reason": "This workflow has not repeated enough or does not yet show a stable structure.",
                "example": "Capture the same process a few more times and compare the repeated steps.",
            }
        )

    return suggestions
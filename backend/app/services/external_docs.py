from __future__ import annotations

import json
import os
import re
from html.parser import HTMLParser
from typing import Dict, List, Tuple
from urllib.parse import urlparse

import requests

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"

TRUSTED_HOSTS = {
    "learn.microsoft.com",
    "support.microsoft.com",
    "support.apple.com",
    "support.google.com",
    "help.openai.com",
    "platform.openai.com",
    "developers.openai.com",
}


def _api_key() -> str:
    return os.getenv("OPENAI_API_KEY", "").strip()


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript"}:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = re.sub(r"\s+", " ", data or " ").strip()
        if text:
            self.parts.append(text)

    def get_text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def _normalize_host(host: str) -> str:
    return (host or "").strip().lower().replace("www.", "")


def is_trusted_source_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False

    if parsed.scheme not in {"http", "https"}:
        return False

    return _normalize_host(parsed.netloc) in TRUSTED_HOSTS


def _fetch_source(url: str) -> Dict[str, str]:
    response = requests.get(
        url,
        headers={"User-Agent": "Continuum/1.0 (+trusted external doc generation)"},
        timeout=30,
    )
    response.raise_for_status()

    content_type = (response.headers.get("content-type") or "").lower()
    raw = response.text or ""
    text = raw

    if "html" in content_type or "<html" in raw[:500].lower():
        parser = _TextExtractor()
        parser.feed(raw)
        text = parser.get_text()

    title = ""
    match = re.search(r"<title[^>]*>(.*?)</title>", raw, flags=re.IGNORECASE | re.DOTALL)
    if match:
        title = re.sub(r"\s+", " ", match.group(1)).strip()

    text = re.sub(r"\s+", " ", text).strip()

    return {
        "url": url,
        "host": _normalize_host(urlparse(url).netloc),
        "title": title or _normalize_host(urlparse(url).netloc),
        "content": text[:12000],
    }


def _fallback_document(topic: str, doc_type: str, audience: str, notes: str, sources: List[Dict[str, str]]) -> Dict[str, str]:
    source_lines = [f"- [{src['title']}]({src['url']})" for src in sources]
    procedure_sections = []

    for idx, src in enumerate(sources, start=1):
        snippet = src["content"][:900].strip()
        procedure_sections.append(f"## Source {idx}: {src['title']}\n\n{snippet}")

    return {
        "title": f"{topic} - External {doc_type.upper()} Draft",
        "summary": f"Trusted-external draft for {topic}, tailored for {audience.replace('_', ' ')}.",
        "content": f"""# Purpose
Create a starter {doc_type} for {topic} using trusted external product documentation.

# Preconditions
- Validate the final steps against your own environment before using them operationally.
- Confirm permissions, tenant settings, and UI rollout details.
- Review any notes or constraints for your team.

# Procedure
{'\n\n'.join(procedure_sections) if procedure_sections else '- No external source content was available.'}

# Controls
- Confirm each step matches your tenant, permissions, and UI version.
- Treat this as assisted guidance until your team verifies it internally.

# Evidence
{'\n'.join(source_lines)}

# Sources
{'\n'.join(source_lines)}
""",
    }


def _ai_document(topic: str, doc_type: str, audience: str, notes: str, sources: List[Dict[str, str]]) -> Dict[str, str]:
    key = _api_key()
    if not key:
        return _fallback_document(topic, doc_type, audience, notes, sources)

    context = []
    for idx, source in enumerate(sources, start=1):
        context.append(
            f"[SOURCE_{idx}] {source['title']}\nURL: {source['url']}\nContent: {source['content']}"
        )

    system = """
You generate a process document using ONLY the trusted external sources provided.
Return ONLY valid JSON with this shape:
{
  "title": "string",
  "summary": "string",
  "content": "markdown string"
}
Rules:
- Use only the supplied sources.
- Do not invent internal company-specific steps or controls.
- Be explicit when a step may vary by tenant, permissions, rollout, OS version, or configuration.
- Produce concise but useful markdown.
- Include these sections in content: Purpose, Preconditions, Procedure, Controls, Evidence, Sources.
- In Sources, include markdown links for every source used.
""".strip()

    user = (
        f"Topic: {topic}\n"
        f"Document type: {doc_type}\n"
        f"Audience: {audience}\n"
        f"Additional notes: {notes or 'None'}\n\n"
        f"Trusted source excerpts:\n\n" + "\n\n".join(context)
    )

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
            "temperature": 0.2,
        },
        timeout=120,
    )
    response.raise_for_status()

    payload = json.loads(response.json()["choices"][0]["message"]["content"])

    return {
        "title": str(payload.get("title") or f"{topic} - External {doc_type.upper()} Draft").strip(),
        "summary": str(payload.get("summary") or f"Trusted-external draft for {topic}.").strip(),
        "content": str(payload.get("content") or "").strip(),
    }


def generate_external_document(topic: str, doc_type: str, audience: str, notes: str, source_urls: List[str]) -> Tuple[Dict[str, str], List[Dict[str, str]]]:
    clean_urls: List[str] = []

    for raw in source_urls:
        url = str(raw or "").strip()
        if not url:
            continue
        if not is_trusted_source_url(url):
            raise ValueError(f"Only trusted source URLs are allowed: {url}")
        if url not in clean_urls:
            clean_urls.append(url)

    if not topic.strip():
        raise ValueError("topic is required")
    if not clean_urls:
        raise ValueError("At least one trusted source URL is required")

    sources = [_fetch_source(url) for url in clean_urls]
    document = _ai_document(
        topic=topic.strip(),
        doc_type=(doc_type or "sop").strip(),
        audience=(audience or "team").strip(),
        notes=notes or "",
        sources=sources,
    )
    return document, sources


def _tokenize(text: str) -> List[str]:
    return [token for token in re.findall(r"[a-zA-Z0-9_]+", (text or "").lower()) if len(token) > 1]


def _score_external_source(question: str, source: Dict[str, str]) -> int:
    q_tokens = set(_tokenize(question))
    s_tokens = set(_tokenize(source.get("title", "") + " " + source.get("content", "")))
    if not q_tokens or not s_tokens:
        return 0

    score = len(q_tokens & s_tokens)
    q = question.lower()
    content = (source.get("title", "") + " " + source.get("content", "")).lower()

    if q and q in content:
        score += 3
    if "sharepoint" in q and "sharepoint" in content:
        score += 2
    if "power automate" in q and "power automate" in content:
        score += 2
    if any(word in q for word in ["click", "step", "where", "next"]) and "step" in content:
        score += 1

    return score


def _select_external_sources(question: str, sources: List[Dict[str, str]], limit: int = 6) -> List[Dict[str, str]]:
    ranked = sorted(sources, key=lambda src: _score_external_source(question, src), reverse=True)
    picked = [src for src in ranked if _score_external_source(question, src) > 0][:limit]
    if not picked:
        picked = ranked[: min(limit, len(ranked))]
    return picked


def _fallback_external_answer(topic: str, question: str, selected: List[Dict[str, str]]) -> Dict[str, Any]:
    if not selected:
        return {
            "source_basis": "trusted_external",
            "source_label": "Trusted external",
            "source_note": "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout.",
            "answer_markdown": "I couldn't find enough trusted external source content to answer that yet.",
            "citations": [],
            "used_ai": False,
        }

    lines = [
        f"Based on the trusted external sources for **{topic}**:"
    ]
    for source in selected[:3]:
        snippet = source.get("content", "")[:320].strip()
        lines.append(f"- **{source['title']}**: {snippet}")

    return {
        "source_basis": "trusted_external",
        "source_label": "Trusted external",
        "source_note": "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout.",
        "answer_markdown": "\n".join(lines),
        "citations": [{"id": src["id"], "label": src["title"]} for src in selected[:3]],
        "used_ai": False,
    }


def _ai_external_answer(
    topic: str,
    question: str,
    doc_type: str,
    audience: str,
    notes: str,
    selected: List[Dict[str, str]],
) -> Dict[str, Any]:
    key = _api_key()
    if not key:
        return {"ok": False, "error": "missing_api_key"}

    context = []
    for source in selected:
        context.append(
            f"[{source['id']}] {source['title']}\n"
            f"URL: {source['url']}\n"
            f"Content: {source['content']}"
        )

    system = """
You answer questions using ONLY the provided trusted external sources.
Return ONLY valid JSON with this shape:
{
  "answer_markdown": "string",
  "citation_ids": ["string"]
}
Rules:
- Use only the supplied trusted external sources.
- Do not invent company-specific internal processes.
- Be explicit when steps may vary by tenant, permissions, rollout, OS version, or configuration.
- Keep the answer concise but practical.
- citation_ids must contain only source ids that directly support the answer.
""".strip()

    user = (
        f"Topic: {topic}\n"
        f"Question: {question}\n"
        f"Doc type: {doc_type}\n"
        f"Audience: {audience}\n"
        f"Notes: {notes or 'None'}\n\n"
        f"Trusted external sources:\n\n" + "\n\n".join(context)
    )

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
            "temperature": 0.2,
        },
        timeout=120,
    )
    response.raise_for_status()

    payload = json.loads(response.json()["choices"][0]["message"]["content"])
    citation_ids = [str(item) for item in payload.get("citation_ids", []) if isinstance(item, str)]

    citations = []
    seen = set()
    for source in selected:
        if source["id"] in citation_ids and source["id"] not in seen:
            seen.add(source["id"])
            citations.append({"id": source["id"], "label": source["title"]})

    return {
        "ok": True,
        "source_basis": "trusted_external",
        "source_label": "Trusted external",
        "source_note": "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout.",
        "answer_markdown": str(payload.get("answer_markdown", "")).strip() or "I couldn't produce a grounded answer.",
        "citations": citations,
        "used_ai": True,
    }


def answer_external_question(
    topic: str,
    question: str,
    doc_type: str,
    audience: str,
    notes: str,
    source_urls: List[str],
) -> Dict[str, Any]:
    clean_urls: List[str] = []

    for raw in source_urls:
        url = str(raw or "").strip()
        if not url:
            continue
        if not is_trusted_source_url(url):
            raise ValueError(f"Only trusted source URLs are allowed: {url}")
        if url not in clean_urls:
            clean_urls.append(url)

    if not topic.strip():
        raise ValueError("topic is required")
    if not question.strip():
        raise ValueError("question is required")
    if not clean_urls:
        raise ValueError("At least one trusted source URL is required")

    fetched = [_fetch_source(url) for url in clean_urls]
    indexed = [
        {
            "id": f"external_source_{idx+1}",
            "url": src["url"],
            "host": src["host"],
            "title": src["title"],
            "content": src["content"],
        }
        for idx, src in enumerate(fetched)
    ]

    selected = _select_external_sources(question, indexed)
    ai = _ai_external_answer(topic, question, doc_type, audience, notes, selected)
    if ai.get("ok"):
        return ai

    return _fallback_external_answer(topic, question, selected)
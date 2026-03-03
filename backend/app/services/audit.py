"""
Audit rule service.

WHAT THIS FILE DOES:
1. Normalizes audit rules
2. Checks a generated document against those rules
3. Returns structured issues

"""

from __future__ import annotations

from typing import Any, Dict, List


DEFAULT_RULES = {
    "required_sections": [
        "Purpose",
        "Preconditions",
        "Procedure",
        "Controls",
        "Evidence",
    ],
    "required_keywords": [],
    "prohibited_words": [],
}


def normalize_rules(rules: Dict[str, Any] | None) -> Dict[str, List[str]]:
   
    normalized = {
        "required_sections": list(DEFAULT_RULES["required_sections"]),
        "required_keywords": list(DEFAULT_RULES["required_keywords"]),
        "prohibited_words": list(DEFAULT_RULES["prohibited_words"]),
    }

    if rules:
        for key in normalized.keys():
            values = rules.get(key, [])
            normalized[key] = [str(item).strip() for item in values if str(item).strip()]

    return normalized


def run_audit(content: str, rules: Dict[str, Any] | None = None) -> Dict[str, Any]:
    
    normalized_rules = normalize_rules(rules)
    lowered = content.lower()
    issues: List[Dict[str, str]] = []

    for section in normalized_rules["required_sections"]:
        if section.lower() not in lowered:
            issues.append(
                {
                    "rule": "required_section",
                    "severity": "high",
                    "message": f"Missing required section: {section}",
                }
            )

    for keyword in normalized_rules["required_keywords"]:
        if keyword.lower() not in lowered:
            issues.append(
                {
                    "rule": "required_keyword",
                    "severity": "medium",
                    "message": f"Missing required keyword: {keyword}",
                }
            )

    for bad_word in normalized_rules["prohibited_words"]:
        if bad_word.lower() in lowered:
            issues.append(
                {
                    "rule": "prohibited_word",
                    "severity": "high",
                    "message": f"Prohibited word found: {bad_word}",
                }
            )

    if len(content.strip()) < 200:
        issues.append(
            {
                "rule": "document_length",
                "severity": "low",
                "message": "Document is very short and may be incomplete.",
            }
        )

    return {
        "passed": len([issue for issue in issues if issue["severity"] == "high"]) == 0,
        "issues": issues,
        "applied_rules": normalized_rules,
    }
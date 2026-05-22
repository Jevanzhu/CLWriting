#!/usr/bin/env python3
"""Project learning memory helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.security_utils import atomic_write_json, read_json_safe
from core.time_utils import now_utc_iso


VALID_PATTERN_TYPES = {
    "hook",
    "pacing",
    "dialogue",
    "payoff",
    "emotion",
    "format",
    "other",
}


def _learning_file(project_root: str | Path) -> Path:
    return StoryCraftConfig.from_project_root(project_root).learning_file


def _load_learning(project_root: str | Path) -> dict[str, Any]:
    payload = read_json_safe(_learning_file(project_root), {"patterns": []})
    if not isinstance(payload.get("patterns"), list):
        payload["patterns"] = []
    return payload


def append_learning_pattern(
    project_root: str | Path,
    pattern_type: str,
    description: str,
    example: str,
    instruction: str,
    chapter: int,
) -> dict[str, Any]:
    """Append one project learning pattern and return it."""
    normalized_type = pattern_type if pattern_type in VALID_PATTERN_TYPES else "other"
    payload = _load_learning(project_root)
    next_number = len(payload["patterns"]) + 1
    pattern = {
        "id": f"pat_{next_number:03d}",
        "chapter": int(chapter),
        "pattern_type": normalized_type,
        "description": description,
        "example": example,
        "instruction": instruction,
        "created_at": now_utc_iso(),
    }
    payload["patterns"].append(pattern)
    atomic_write_json(_learning_file(project_root), payload, use_lock=True, backup=True)
    return pattern


def get_learning_patterns(
    project_root: str | Path,
    pattern_type: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Return project learning patterns, optionally filtered by type."""
    patterns = list(_load_learning(project_root).get("patterns", []))
    if pattern_type is None:
        return patterns
    return [item for item in patterns if item.get("pattern_type") == pattern_type]

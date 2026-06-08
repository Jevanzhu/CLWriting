#!/usr/bin/env python3
"""Resolve chapter directives from contract and commit truth sources."""

from __future__ import annotations

from typing import Any

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.contract_store import ContractStore


def resolve_chapter_directive(
    config: StoryCraftConfig,
    chapter: int,
) -> dict[str, Any]:
    """Return chapter directive fields without reading outline markdown."""
    chapter_num = int(chapter)
    contract = ContractStore(config).read_chapter(chapter_num)
    if contract is not None:
        return {
            "chapter_directive": str(contract.get("chapter_directive") or ""),
            "must_cover": _string_list(contract.get("must_cover")),
            "title": str(contract.get("title") or ""),
            "planned_word_count": _positive_int(contract.get("planned_word_count")),
            "source": "contract",
        }

    commit = CommitStore(config).read(chapter_num)
    if commit is not None:
        title = str(commit.get("title") or "")
        summary = _commit_summary(commit)
        return {
            "chapter_directive": summary,
            "must_cover": [],
            "title": title,
            "planned_word_count": 0,
            "source": "commit",
        }

    return {
        "chapter_directive": "",
        "must_cover": [],
        "title": "",
        "planned_word_count": 0,
        "source": "none",
    }


def _commit_summary(commit: dict[str, Any]) -> str:
    chapter_summary = commit.get("chapter_summary")
    if isinstance(chapter_summary, dict):
        summary = chapter_summary.get("summary")
        if summary:
            return str(summary)
    return str(commit.get("summary_text") or "")


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item]


def _positive_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


__all__ = ["resolve_chapter_directive"]

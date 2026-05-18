#!/usr/bin/env python3
"""Quality trend reporting for story-craft chapter commits."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.security_utils import read_json_safe


class QualityTrendReporter:
    """Aggregate review warnings and word-count changes across chapters."""

    def __init__(self, config: Optional[StoryCraftConfig] = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root: str | Path) -> "QualityTrendReporter":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def build(self) -> dict[str, Any]:
        commits = self._load_commits()
        accepted = [item for item in commits if item.get("status") == "accepted"]
        warning_counter: Counter[str] = Counter()
        blocker_counter: Counter[str] = Counter()
        words: list[int] = []
        warning_rows: list[dict[str, Any]] = []

        for payload in commits:
            review = payload.get("review", {})
            word_count = int(payload.get("word_count") or 0)
            if word_count:
                words.append(word_count)
            for item in review.get("warnings", []) or []:
                category = self._category(item)
                warning_counter[category] += 1
                warning_rows.append(
                    {
                        "chapter": payload.get("chapter"),
                        "category": category,
                        "description": self._description(item),
                    }
                )
            for item in review.get("blockers", []) or []:
                blocker_counter[self._category(item)] += 1

        return {
            "chapter_count": len(commits),
            "accepted_count": len(accepted),
            "rejected_count": len(commits) - len(accepted),
            "avg_words": round(sum(words) / len(words), 2) if words else 0,
            "min_words": min(words) if words else 0,
            "max_words": max(words) if words else 0,
            "warning_categories": dict(warning_counter),
            "blocker_categories": dict(blocker_counter),
            "recent_warnings": warning_rows[-10:],
            "risk_flags": self._risk_flags(words, warning_counter, blocker_counter),
        }

    def _load_commits(self) -> list[dict[str, Any]]:
        commits = []
        if not self.config.chapters_dir.exists():
            return commits
        for path in sorted(self.config.chapters_dir.glob("ch_*_commit.json")):
            payload = read_json_safe(path, {})
            if payload:
                commits.append(payload)
        return commits

    def _category(self, item: Any) -> str:
        if isinstance(item, dict):
            return str(item.get("category") or "other")
        return "other"

    def _description(self, item: Any) -> str:
        if isinstance(item, dict):
            return str(item.get("description") or item.get("message") or "")
        return str(item)

    def _risk_flags(
        self,
        words: list[int],
        warnings: Counter[str],
        blockers: Counter[str],
    ) -> list[str]:
        flags = []
        if len(words) >= 3 and words[-1] < max(1200, int(sum(words[-3:]) / 3 * 0.65)):
            flags.append("最近章节字数明显下滑，可能存在节奏压缩过度。")
        if warnings.get("pacing", 0) >= 3:
            flags.append("节奏类 warning 较多，建议检查中段场景推进。")
        if warnings.get("continuity", 0) + blockers.get("continuity", 0) >= 2:
            flags.append("连续性问题重复出现，建议重建上下文索引并核对设定。")
        return flags

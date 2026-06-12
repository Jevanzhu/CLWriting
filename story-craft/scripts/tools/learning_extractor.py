#!/usr/bin/env python3
"""从章节审查历史自动提炼候选 learning pattern。

只读分析、不写入：返回候选列表，由 A3 的人工确认流程决定是否回写
project_learning.json。当前来源为审查历史（source=auto-review）；模块按
来源可扩展，后续可接入风格漂移（auto-style）等信号。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from core.chapter_paths import iter_chapter_record_files
from core.config import StoryCraftConfig
from core.security_utils import read_json_safe


# 审查 category（自由文本）→ 7 类 pattern_type 的关键词映射
_CATEGORY_KEYWORDS = (
    ("pacing", "pacing"),
    ("节奏", "pacing"),
    ("hook", "hook"),
    ("钩子", "hook"),
    ("dialogue", "dialogue"),
    ("对白", "dialogue"),
    ("对话", "dialogue"),
    ("payoff", "payoff"),
    ("伏笔", "payoff"),
    ("兑现", "payoff"),
    ("emotion", "emotion"),
    ("情绪", "emotion"),
    ("情感", "emotion"),
    ("format", "format"),
    ("排版", "format"),
    ("格式", "format"),
)

_NORM = re.compile(r"[\s，。、；：！？,.;:!?]+")

_IMPORTANCE_RANK = {"low": 0, "medium": 1, "high": 2}


def _map_pattern_type(category: str) -> str:
    text = (category or "").strip().lower()
    for keyword, ptype in _CATEGORY_KEYWORDS:
        # 英文关键词用词边界匹配，避免 "information"→format、"spacing"→pacing 这类子串误判；
        # 中文无词边界，直接子串匹配
        if keyword.isascii():
            if re.search(rf"\b{re.escape(keyword)}\b", text):
                return ptype
        elif keyword in text:
            return ptype
    return "other"


def _norm_desc(text: str) -> str:
    return _NORM.sub("", (text or "").strip()).lower()


def _issue_fields(item: Any) -> tuple[str, str]:
    if isinstance(item, dict):
        category = str(item.get("category") or "general")
        description = str(item.get("description") or item.get("message") or "")
        return category, description
    return "general", str(item)


def extract_learning_candidates(
    project_root: str | Path,
    min_occurrences: int = 2,
    min_chapters: int = 2,
) -> list[dict[str, Any]]:
    """提炼候选 pattern：跨章反复出现的审查问题，或任意 blocker。

    阈值：blocker 出现即提炼；warning 需累计达到 min_occurrences 且
    跨越至少 min_chapters 个章节。返回按置信度降序的候选列表，不写入。
    """
    config = StoryCraftConfig.from_project_root(project_root)
    aggregated: dict[tuple[str, str], dict[str, Any]] = {}

    for path in iter_chapter_record_files(config=config):
        payload = read_json_safe(path, {})
        review = payload.get("review")
        if not isinstance(review, dict):
            review = {}
        chapter = payload.get("chapter")
        warnings = review.get("warnings")
        blockers = review.get("blockers")
        sources = (
            ("warning", warnings if isinstance(warnings, list) else []),
            ("blocker", blockers if isinstance(blockers, list) else []),
        )
        for severity, items in sources:
            for item in items:
                category, description = _issue_fields(item)
                description = description.strip()
                if not description:
                    continue
                pattern_type = _map_pattern_type(category)
                key = (pattern_type, _norm_desc(description))
                entry = aggregated.setdefault(
                    key,
                    {
                        "pattern_type": pattern_type,
                        "description": description,
                        "chapters": set(),
                        "occurrences": 0,
                        "has_blocker": False,
                    },
                )
                entry["occurrences"] += 1
                if chapter is not None:
                    entry["chapters"].add(int(chapter))
                if severity == "blocker":
                    entry["has_blocker"] = True

    candidates: list[dict[str, Any]] = []
    for entry in aggregated.values():
        chapters = sorted(entry["chapters"])
        occurrences = entry["occurrences"]
        qualifies = entry["has_blocker"] or (
            occurrences >= min_occurrences and len(chapters) >= min_chapters
        )
        if not qualifies:
            continue
        importance = "high" if (entry["has_blocker"] or occurrences >= 4) else "medium"
        # blocker 是已确认的阻塞级问题，置信度基线更高
        confidence = round(
            min(1.0, occurrences / 5 + (0.4 if entry["has_blocker"] else 0.0)), 2
        )
        candidates.append(
            {
                "pattern_type": entry["pattern_type"],
                "description": f"反复出现的审查问题：{entry['description']}",
                "example": "",
                "instruction": f"后续章节必须避免：{entry['description']}",
                "source": "auto-review",
                "importance": importance,
                "evidence": {
                    "occurrences": occurrences,
                    "chapters": chapters,
                    "has_blocker": entry["has_blocker"],
                },
                "confidence": confidence,
            }
        )

    # 先按严重度（importance）再按置信度排序，确保 blocker/高危问题排在最前
    candidates.sort(
        key=lambda item: (_IMPORTANCE_RANK.get(item["importance"], 1), item["confidence"]),
        reverse=True,
    )
    return candidates

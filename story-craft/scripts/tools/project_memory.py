#!/usr/bin/env python3
"""Project learning memory helpers."""

from __future__ import annotations

import re
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

VALID_IMPORTANCE = {"high", "medium", "low"}
_IMPORTANCE_RANK = {"low": 0, "medium": 1, "high": 2}

# 归一化 instruction 用于去重：去掉空白与常见中英文标点后比较
_DEDUP_NOISE = re.compile(r"[\s，。、；：！？,.;:!?]+")


def _normalize_instruction(text: str) -> str:
    return _DEDUP_NOISE.sub("", (text or "").strip()).lower()


def _higher_importance(a: str, b: str) -> str:
    a = a if a in _IMPORTANCE_RANK else "medium"
    b = b if b in _IMPORTANCE_RANK else "medium"
    return a if _IMPORTANCE_RANK[a] >= _IMPORTANCE_RANK[b] else b


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
    source: str = "manual",
    importance: str = "medium",
) -> dict[str, Any]:
    """Append one project learning pattern and return it.

    同类型 + 归一化 instruction 命中已有记录时不新增，而是合并：
    importance 取高、补全缺失的 example、刷新 updated_at，并标记 merged。
    """
    normalized_type = pattern_type if pattern_type in VALID_PATTERN_TYPES else "other"
    normalized_importance = importance if importance in VALID_IMPORTANCE else "medium"
    source = (source or "manual").strip() or "manual"
    payload = _load_learning(project_root)
    patterns = payload["patterns"]
    now = now_utc_iso()

    # 归一化为去重键；纯标点/空白导致归一化为空时回退到原文，确保仍能去重
    instr_key = _normalize_instruction(instruction) or (instruction or "").strip()
    if instr_key:
        for existing in patterns:
            if existing.get("pattern_type") != normalized_type:
                continue
            existing_instr = str(existing.get("instruction", ""))
            existing_key = _normalize_instruction(existing_instr) or existing_instr.strip()
            if existing_key != instr_key:
                continue
            existing["importance"] = _higher_importance(
                existing.get("importance", "medium"), normalized_importance
            )
            if not existing.get("example") and example:
                existing["example"] = example
            # 合并所有来源，避免丢失"被多来源确认过"的信息
            merged_sources = {
                part for part in str(existing.get("source") or "").split(",") if part
            }
            merged_sources.add(source)
            existing["source"] = ",".join(sorted(merged_sources))
            existing["updated_at"] = now
            existing["merged"] = True
            atomic_write_json(_learning_file(project_root), payload, use_lock=True, backup=True)
            return existing

    next_number = len(patterns) + 1
    pattern = {
        "id": f"pat_{next_number:03d}",
        "chapter": int(chapter),
        "pattern_type": normalized_type,
        "description": description,
        "example": example,
        "instruction": instruction,
        "source": source,
        "importance": normalized_importance,
        "created_at": now,
    }
    patterns.append(pattern)
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


DEFAULT_LEARNING_LIMIT = 12


def rank_learning_patterns(
    patterns: list[dict[str, Any]],
    limit: int = DEFAULT_LEARNING_LIMIT,
) -> list[dict[str, Any]]:
    """按 importance 高优先、同级按章节新近度排序，并截断 top-N。

    用于注入写作 guidance/checklist 前，防止 learning 无限膨胀淹没关键经验。
    limit <= 0 表示不截断。
    """

    def _key(pattern: dict[str, Any]) -> tuple[int, int]:
        importance = _IMPORTANCE_RANK.get(pattern.get("importance", "medium"), 1)
        try:
            chapter = int(pattern.get("chapter") or 0)
        except (TypeError, ValueError):
            chapter = 0
        return (importance, chapter)

    active = [pattern for pattern in patterns if not pattern.get("disabled")]
    ranked = sorted(active, key=_key, reverse=True)
    if limit and limit > 0:
        return ranked[:limit]
    return ranked


def disable_learning_pattern(project_root: str | Path, pattern_id: str) -> dict[str, Any]:
    """软删除（停用）指定 id 的经验：标记 disabled，注入写作时排除，但数据保留可恢复。

    用 disabled 标记而非物理删除，避免破坏 `pat_NNN` 的 len+1 顺序导致 id 冲突。
    """
    payload = _load_learning(project_root)
    for pattern in payload["patterns"]:
        if pattern.get("id") == pattern_id:
            if pattern.get("disabled"):
                return {"status": "already_disabled", "id": pattern_id}
            pattern["disabled"] = True
            pattern["updated_at"] = now_utc_iso()
            atomic_write_json(_learning_file(project_root), payload, use_lock=True, backup=True)
            return {"status": "disabled", "id": pattern_id}
    return {"status": "not_found", "id": pattern_id}

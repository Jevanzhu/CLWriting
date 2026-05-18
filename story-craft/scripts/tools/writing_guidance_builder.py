#!/usr/bin/env python3
"""Build dynamic writing guidance for story-craft."""

from __future__ import annotations

from typing import Any


def _normalize_issue(issue: dict[str, Any]) -> dict[str, str]:
    category = str(issue.get("category") or issue.get("pattern_type") or "general")
    description = str(issue.get("description") or issue.get("instruction") or issue)
    return {"category": category, "description": description}


def build_writing_checklist(
    chapter: int,
    review_history: list[dict[str, Any]],
    learning_patterns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build a compact chapter checklist from review and learning history."""
    items: list[dict[str, Any]] = [
        {
            "id": "chapter_goal",
            "category": "structure",
            "instruction": f"第{int(chapter):02d}章必须有明确场景目标、阻力和章末变化。",
            "source": "default",
        },
        {
            "id": "opening_hook",
            "category": "hook",
            "instruction": "前300字内给出行动、异常、冲突或悬念之一。",
            "source": "default",
        },
    ]

    seen: set[tuple[str, str]] = set()
    for report in review_history[-5:]:
        review = report.get("review", report)
        for issue in (review.get("warnings") or []) + (review.get("blockers") or []):
            normalized = _normalize_issue(issue)
            key = (normalized["category"], normalized["description"])
            if key in seen:
                continue
            seen.add(key)
            items.append(
                {
                    "id": f"review_{len(items) + 1}",
                    "category": normalized["category"],
                    "instruction": f"避免重复历史审查问题：{normalized['description']}",
                    "source": "review_history",
                }
            )

    for pattern in learning_patterns:
        instruction = str(pattern.get("instruction") or "").strip()
        if not instruction:
            continue
        category = str(pattern.get("pattern_type") or "learning")
        key = (category, instruction)
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "id": str(pattern.get("id") or f"learn_{len(items) + 1}"),
                "category": category,
                "instruction": instruction,
                "source": "project_learning",
            }
        )

    return items


def build_anti_ai_checklist() -> list[dict[str, str]]:
    """Return fixed anti-AI-flavor checks."""
    return [
        {
            "id": "sentence_variety",
            "category": "style",
            "instruction": "检查是否连续使用同长度、同节奏句式。",
        },
        {
            "id": "abstract_emotion",
            "category": "emotion",
            "instruction": "把抽象情绪改成动作、物件、停顿和感官细节。",
        },
        {
            "id": "expository_dialogue",
            "category": "dialogue",
            "instruction": "删除角色互相解释已知信息的对白。",
        },
        {
            "id": "generic_metaphor",
            "category": "language",
            "instruction": "替换常见比喻和空泛形容词，优先使用本故事专属细节。",
        },
    ]

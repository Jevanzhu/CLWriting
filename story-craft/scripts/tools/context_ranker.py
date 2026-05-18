#!/usr/bin/env python3
"""Context ranking utilities for medium story-craft projects."""

from __future__ import annotations

from typing import Any


PRIORITY = {
    "foreshadowing:high": 100,
    "character:active": 85,
    "chapter_summary:recent": 75,
    "timeline:recent": 65,
    "world_rule": 60,
    "foreshadowing:medium": 55,
    "foreshadowing:low": 40,
}


def rank_context_items(
    memory: dict[str, Any],
    *,
    chapter: int,
    budget: int = 20,
) -> dict[str, Any]:
    """Return a budgeted context list ordered by writing relevance."""
    items = []
    chapter_num = int(chapter)
    for item in memory.get("foreshadowing", []) or []:
        if item.get("status") == "resolved":
            continue
        urgency = str(item.get("urgency") or "low")
        items.append(
            _item(
                "foreshadowing",
                f"foreshadowing:{urgency}",
                PRIORITY.get(f"foreshadowing:{urgency}", 40),
                int(item.get("planted_chapter") or 0),
                item,
            )
        )
    for char in memory.get("characters", []) or []:
        last_seen = int(char.get("last_appearance_chapter") or 0)
        if last_seen and last_seen >= max(1, chapter_num - 4):
            score = PRIORITY["character:active"] + max(0, 4 - (chapter_num - last_seen))
        else:
            score = 35
        items.append(_item("character", "character:active", score, last_seen, char))
    for summary in memory.get("chapter_summaries", []) or []:
        summary_chapter = int(summary.get("chapter") or 0)
        if summary_chapter < chapter_num:
            recency_bonus = max(0, 8 - (chapter_num - summary_chapter))
            items.append(
                _item(
                    "chapter_summary",
                    "chapter_summary:recent",
                    PRIORITY["chapter_summary:recent"] + recency_bonus,
                    summary_chapter,
                    summary,
                )
            )
    for event in memory.get("timeline", []) or []:
        event_chapter = int(event.get("chapter") or 0)
        if event.get("planned") or event_chapter >= chapter_num:
            continue
        items.append(
            _item(
                "timeline",
                "timeline:recent",
                PRIORITY["timeline:recent"] + max(0, 5 - abs(chapter_num - event_chapter)),
                event_chapter,
                event,
            )
        )
    for rule in memory.get("world_rules", []) or []:
        items.append(
            _item(
                "world_rule",
                "world_rule",
                PRIORITY["world_rule"],
                int(rule.get("chapter") or 0),
                rule,
            )
        )

    ordered = sorted(
        items,
        key=lambda item: (-int(item["score"]), -int(item["chapter"]), item["kind"]),
    )
    limit = max(1, int(budget))
    return {
        "chapter": chapter_num,
        "budget": limit,
        "selected": ordered[:limit],
        "omitted_count": max(0, len(ordered) - limit),
        "total_candidates": len(ordered),
    }


def _item(
    kind: str,
    reason: str,
    score: int,
    chapter: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "kind": kind,
        "reason": reason,
        "score": int(score),
        "chapter": int(chapter or 0),
        "id": str(payload.get("id") or payload.get("name") or payload.get("title") or ""),
        "payload": payload,
    }

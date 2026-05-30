#!/usr/bin/env python3
"""Memory projection writer."""

from __future__ import annotations

from collections.abc import Iterable
from copy import deepcopy
from typing import Any

from core.chapter_commit_builder import events_to_legacy_delta
from core.memory_manager import MemoryManager, default_memory
from core.projection.base import ProjectionResult, ProjectionWriter
from core.types import ChapterCommit


class MemoryProjectionWriter(ProjectionWriter):
    """Project accepted commit events into memory.json."""

    name = "memory"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )

        events = commit.get("accepted_events") or []
        if not events:
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="no accepted events",
            )

        delta = events_to_legacy_delta(events)
        delta.setdefault("chapter", int(commit.get("chapter") or 0))
        if commit.get("timeline_entry"):
            delta.setdefault("timeline_entry", commit["timeline_entry"])
        if commit.get("chapter_summary"):
            delta.setdefault("chapter_summary", commit["chapter_summary"])

        memory = MemoryManager(self.config)
        memory.apply_chapter_delta(delta)
        memory.flush()
        return ProjectionResult(
            name=self.name,
            ok=True,
            skipped=False,
            detail="memory updated",
        )

    def rebuild_all(self, commits: Iterable[ChapterCommit]) -> ProjectionResult:
        items = list(commits)
        accepted = [commit for commit in items if self.should_run(commit)]

        memory = MemoryManager(self.config)
        baseline = _chapter_projection_baseline(memory.load())
        memory.save(baseline)

        results = [self.write(commit) for commit in accepted]
        failed = [result for result in results if not result.ok]
        return ProjectionResult(
            name=self.name,
            ok=not failed,
            skipped=not accepted,
            detail=(
                f"replayed {len(accepted)} accepted commits"
                if not failed
                else f"{len(failed)} replay failures"
            ),
        )


def _chapter_projection_baseline(memory: dict[str, Any]) -> dict[str, Any]:
    """Keep non-commit planning/init facts, then replay chapter commits."""
    baseline = default_memory()
    baseline["characters"] = [
        deepcopy(item)
        for item in memory.get("characters", []) or []
        if _is_baseline_character(item)
    ]
    baseline["timeline"] = [
        deepcopy(item)
        for item in memory.get("timeline", []) or []
        if isinstance(item, dict) and item.get("planned")
    ]
    baseline["world_rules"] = [
        deepcopy(item)
        for item in memory.get("world_rules", []) or []
        if isinstance(item, dict) and item.get("source") == "story-plan"
    ]
    return baseline


def _is_baseline_character(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    source = item.get("source")
    if source in {"init", "story-plan"}:
        return True
    role = str(item.get("role") or "")
    first_seen = int(item.get("first_appearance_chapter") or 0)
    last_seen = int(item.get("last_appearance_chapter") or 0)
    return role == "protagonist" or (first_seen == 0 and last_seen == 0)

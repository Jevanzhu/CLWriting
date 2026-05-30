#!/usr/bin/env python3
"""Memory projection writer."""

from __future__ import annotations

from core.chapter_commit_builder import events_to_legacy_delta
from core.memory_manager import MemoryManager
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

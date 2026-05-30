#!/usr/bin/env python3
"""State projection writer."""

from __future__ import annotations

from core.projection.base import ProjectionResult, ProjectionWriter
from core.state_manager import StateManager
from core.types import ChapterCommit


class StateProjectionWriter(ProjectionWriter):
    """Project accepted commit progress into state.json."""

    name = "state"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )

        try:
            chapter = int(commit["chapter"])
            word_count = int(commit.get("word_count") or 0)
        except (KeyError, TypeError, ValueError) as exc:
            return ProjectionResult(
                name=self.name,
                ok=False,
                skipped=False,
                detail=f"invalid state projection commit: {exc}",
            )

        projected = StateManager(self.config).project_commit_progress(
            chapter=chapter,
            word_count=word_count,
        )
        detail = "progress updated" if projected else "chapter already projected"
        return ProjectionResult(name=self.name, ok=True, skipped=not projected, detail=detail)

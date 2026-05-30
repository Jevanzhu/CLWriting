#!/usr/bin/env python3
"""Route chapter commits to read-model projection writers."""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass
from typing import Any

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.projection.base import ProjectionResult, ProjectionWriter
from core.types import ChapterCommit

logger = logging.getLogger("core.event_projection_router")


@dataclass(frozen=True)
class _WriterSpec:
    name: str
    module: str
    class_name: str


_WRITER_SPECS = [
    _WriterSpec("state", "core.projection.state_writer", "StateProjectionWriter"),
    _WriterSpec("memory", "core.projection.memory_writer", "MemoryProjectionWriter"),
    _WriterSpec("summary", "core.projection.summary_writer", "SummaryProjectionWriter"),
    _WriterSpec("index", "core.projection.index_writer", "IndexProjectionWriter"),
    _WriterSpec("vector", "core.projection.vector_writer", "VectorProjectionWriter"),
    _WriterSpec(
        "markdown_view",
        "core.projection.markdown_view_writer",
        "MarkdownViewProjectionWriter",
    ),
]


class EventProjectionRouter:
    """Dispatch chapter commits to projection writers without hard writer imports."""

    def __init__(self, config: StoryCraftConfig | None = None):
        self.config = config or StoryCraftConfig()

    @classmethod
    def from_project(cls, project_root) -> "EventProjectionRouter":
        return cls(StoryCraftConfig.from_project_root(project_root))

    def dispatch(
        self,
        commit: ChapterCommit,
        *,
        only: list[str] | None = None,
    ) -> dict[str, ProjectionResult]:
        selected = set(only or [])
        results: dict[str, ProjectionResult] = {}
        for spec in _WRITER_SPECS:
            if selected and spec.name not in selected:
                continue
            writer = self._load_writer(spec)
            if writer is None:
                results[spec.name] = ProjectionResult(
                    name=spec.name,
                    ok=True,
                    skipped=True,
                    detail="writer unavailable",
                )
                continue
            if writer.is_lazy():
                results[writer.name] = ProjectionResult(
                    name=writer.name,
                    ok=True,
                    skipped=True,
                    detail="lazy projection skipped",
                )
                continue
            results[writer.name] = self._safe_write(writer, commit)
        return results

    def writers(self) -> list[ProjectionWriter]:
        writers: list[ProjectionWriter] = []
        for spec in _WRITER_SPECS:
            writer = self._load_writer(spec)
            if writer is not None:
                writers.append(writer)
        return writers

    def rebuild(self, *, only: list[str] | None = None) -> dict[str, ProjectionResult]:
        commits = CommitStore(self.config).iter_all()
        results: dict[str, ProjectionResult] = {}
        selected = set(only or [])
        for spec in _WRITER_SPECS:
            if selected and spec.name not in selected:
                continue
            writer = self._load_writer(spec)
            if writer is None:
                results[spec.name] = ProjectionResult(
                    name=spec.name,
                    ok=True,
                    skipped=True,
                    detail="writer unavailable",
                )
                continue
            if writer.is_lazy():
                results[writer.name] = ProjectionResult(
                    name=writer.name,
                    ok=True,
                    skipped=True,
                    detail="lazy projection skipped",
                )
                continue
            if hasattr(writer, "rebuild_all"):
                results[writer.name] = self._safe_rebuild(writer, commits)
                continue
            writer_results = [self._safe_write(writer, commit) for commit in commits]
            failed = [result for result in writer_results if not result.ok]
            results[writer.name] = ProjectionResult(
                name=writer.name,
                ok=not failed,
                skipped=not commits,
                detail=(
                    f"replayed {len(commits)} commits"
                    if not failed
                    else f"{len(failed)} replay failures"
                ),
            )
        return results

    def _load_writer(self, spec: _WriterSpec) -> ProjectionWriter | None:
        try:
            module = importlib.import_module(spec.module)
            writer_class = getattr(module, spec.class_name)
            return writer_class(self.config)
        except (ImportError, AttributeError) as exc:
            logger.warning("projection writer %s unavailable: %s", spec.name, exc)
            return None

    def _safe_write(
        self,
        writer: ProjectionWriter,
        commit: ChapterCommit,
    ) -> ProjectionResult:
        try:
            return writer.write(commit)
        except Exception as exc:  # pragma: no cover - defensive safety net
            logger.exception("projection writer %s failed", writer.name)
            return ProjectionResult(
                name=writer.name,
                ok=False,
                skipped=False,
                detail=str(exc),
            )

    def _safe_rebuild(
        self,
        writer: ProjectionWriter,
        commits: list[ChapterCommit],
    ) -> ProjectionResult:
        try:
            return writer.rebuild_all(commits)  # type: ignore[attr-defined]
        except Exception as exc:  # pragma: no cover - defensive safety net
            logger.exception("projection writer %s rebuild failed", writer.name)
            return ProjectionResult(
                name=writer.name,
                ok=False,
                skipped=False,
                detail=str(exc),
            )


__all__ = ["EventProjectionRouter", "ProjectionResult"]

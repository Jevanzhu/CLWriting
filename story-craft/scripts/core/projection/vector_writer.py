#!/usr/bin/env python3
"""Vector projection writer placeholder for RAG-backed projects."""

from __future__ import annotations

from collections.abc import Iterable

from core.projection.base import ProjectionResult, ProjectionWriter
from core.types import ChapterCommit


class VectorProjectionWriter(ProjectionWriter):
    """Project commit scene text into the vector store when RAG is available."""

    name = "vector"

    def is_lazy(self) -> bool:
        return self.config.project_type() == "short"

    def write(self, commit: ChapterCommit) -> ProjectionResult:
        if not self.should_run(commit):
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="rejected commit skipped",
            )
        chunks = _vector_chunks([commit])
        if not chunks:
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="no embedding text",
            )
        return _rag_unavailable(self.name)

    def rebuild_all(self, commits: Iterable[ChapterCommit]) -> ProjectionResult:
        accepted = [commit for commit in commits if self.should_run(commit)]
        chunks = _vector_chunks(accepted)
        if not accepted:
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="no accepted commits",
            )
        if not chunks:
            return ProjectionResult(
                name=self.name,
                ok=True,
                skipped=True,
                detail="no embedding text",
            )
        return _rag_unavailable(self.name)


def _vector_chunks(commits: list[ChapterCommit]) -> list[dict[str, object]]:
    chunks: list[dict[str, object]] = []
    for commit in commits:
        chapter = int(commit.get("chapter") or 0)
        summary_text = str(commit.get("summary_text") or "")
        if summary_text:
            chunks.append(
                {
                    "chunk_id": f"ch{chapter:03d}:summary",
                    "chapter": chapter,
                    "text": summary_text,
                    "strand": commit.get("dominant_strand") or "",
                }
            )
        for index, scene in enumerate(commit.get("scenes", []) or [], start=1):
            text = str(scene.get("embedding_text") or scene.get("summary") or "")
            if not text:
                continue
            chunks.append(
                {
                    "chunk_id": scene.get("chunk_id") or f"ch{chapter:03d}:scene:{index:03d}",
                    "chapter": chapter,
                    "text": text,
                    "strand": scene.get("strand") or commit.get("dominant_strand") or "",
                }
            )
    return chunks


def _rag_unavailable(name: str) -> ProjectionResult:
    try:
        import core.rag  # noqa: F401
    except ImportError:
        return ProjectionResult(
            name=name,
            ok=True,
            skipped=True,
            detail="rag unavailable",
        )
    return ProjectionResult(
        name=name,
        ok=True,
        skipped=True,
        detail="rag adapter not wired",
    )

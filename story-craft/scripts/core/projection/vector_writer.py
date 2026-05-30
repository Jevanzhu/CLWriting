#!/usr/bin/env python3
"""Vector projection writer backed by core.rag."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from core.projection.base import ProjectionResult, ProjectionWriter
from core.rag import EmbeddingClient, EmbeddingError, VectorChunk, VectorStore
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
        return _write_chunks(self.name, self.config, chunks, replace=False)

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
        return _write_chunks(self.name, self.config, chunks, replace=True)


def _vector_chunks(commits: list[ChapterCommit]) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for commit in commits:
        chapter = int(commit.get("chapter") or 0)
        summary_text = str(commit.get("summary_text") or "")
        if summary_text:
            chunks.append(
                {
                    "chunk_id": f"ch{chapter:03d}:summary",
                    "kind": "summary",
                    "chapter": chapter,
                    "text": summary_text,
                    "strand": commit.get("dominant_strand") or "",
                    "payload": {
                        "chapter": chapter,
                        "title": commit.get("title") or "",
                        "strand": commit.get("dominant_strand") or "",
                    },
                }
            )
        for index, scene in enumerate(commit.get("scenes", []) or [], start=1):
            text = str(scene.get("embedding_text") or scene.get("summary") or "")
            if not text:
                continue
            chunks.append(
                {
                    "chunk_id": scene.get("chunk_id") or f"ch{chapter:03d}:scene:{index:03d}",
                    "kind": "scene",
                    "chapter": chapter,
                    "text": text,
                    "strand": scene.get("strand") or commit.get("dominant_strand") or "",
                    "payload": dict(scene),
                }
            )
    return chunks


def _write_chunks(
    name: str,
    config,
    chunks: list[dict[str, Any]],
    *,
    replace: bool,
) -> ProjectionResult:
    texts = [str(chunk["text"]) for chunk in chunks]
    try:
        vectors = EmbeddingClient().embed_texts(texts)
    except EmbeddingError:
        return ProjectionResult(
            name=name,
            ok=True,
            skipped=True,
            detail="embedding unavailable",
        )
    if len(vectors) != len(chunks):
        return ProjectionResult(
            name=name,
            ok=False,
            skipped=False,
            detail="embedding count mismatch",
        )

    store = VectorStore(config)
    vector_chunks = [
        VectorChunk(
            chunk_id=str(chunk["chunk_id"]),
            kind=str(chunk["kind"]),
            chapter=int(chunk["chapter"]),
            embedding_text=str(chunk["text"]),
            vector=vector,
            payload=dict(chunk.get("payload") or {}),
        )
        for chunk, vector in zip(chunks, vectors)
    ]
    stored = (
        store.replace_chunks(vector_chunks)
        if replace
        else store.upsert_chunks(vector_chunks)
    )
    return ProjectionResult(
        name=name,
        ok=True,
        skipped=False,
        detail=f"wrote {stored} vector chunks",
    )

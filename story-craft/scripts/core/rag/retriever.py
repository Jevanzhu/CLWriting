#!/usr/bin/env python3
"""Hybrid retrieval over vector and BM25 stores."""

from __future__ import annotations

from typing import Any

from core.config import StoryCraftConfig
from core.memory_index import MemoryIndexService
from core.rag.embedding_client import EmbeddingClient, EmbeddingError
from core.rag.rag_config import RagConfig
from core.rag.rerank_client import RerankClient, RerankError
from core.rag.vector_store import VectorStore

# rerank 前的超额取候选倍数：先多取再重排截断，提升召回质量。
_RERANK_OVERFETCH = 4


class HybridRetriever:
    """Search vector chunks, then degrade to BM25 and legacy LIKE index."""

    def __init__(
        self,
        config: StoryCraftConfig,
        *,
        embedding_client: EmbeddingClient | None = None,
        vector_store: VectorStore | None = None,
        rerank_client: RerankClient | None = None,
    ):
        self.config = config
        rag_config = RagConfig.from_env(config.project_root)
        self.embedding_client = embedding_client or EmbeddingClient(rag_config)
        self.vector_store = vector_store or VectorStore(config)
        self.rerank_client = rerank_client or RerankClient(rag_config)

    def search(
        self,
        text: str,
        *,
        kind: str | None = None,
        limit: int = 20,
        mode: str | None = None,
    ) -> list[dict[str, Any]]:
        fetch_limit = self._fetch_limit(limit)

        if mode != "bm25":
            try:
                vector = self.embedding_client.embed_texts([text])[0]
                matches = self.vector_store.query_vector(vector, kind=kind, limit=fetch_limit)
                if matches:
                    return self._maybe_rerank(text, matches, limit)
            except (EmbeddingError, IndexError):
                pass

        matches = self.vector_store.query_bm25(text, kind=kind, limit=fetch_limit)
        if matches:
            return self._maybe_rerank(text, matches, limit)
        return MemoryIndexService(self.config).query(kind=kind, text=text, limit=limit)

    def _fetch_limit(self, limit: int) -> int:
        limit = max(1, int(limit))
        if not self.rerank_client.is_available():
            return limit
        return min(limit * _RERANK_OVERFETCH, 200)

    def _maybe_rerank(
        self,
        text: str,
        matches: list[dict[str, Any]],
        limit: int,
    ) -> list[dict[str, Any]]:
        limit = max(1, int(limit))
        if len(matches) <= 1 or not self.rerank_client.is_available():
            return matches[:limit]
        documents = [str(row.get("embedding_text") or "") for row in matches]
        try:
            ranked = self.rerank_client.rerank(text, documents, top_n=limit)
        except RerankError:
            return matches[:limit]
        reordered: list[dict[str, Any]] = []
        used: set[int] = set()
        for index, score in ranked:
            if index in used:
                continue
            used.add(index)
            row = {**matches[index], "rerank_score": score, "score_type": "rerank"}
            reordered.append(row)
            if len(reordered) >= limit:
                break
        for index, row in enumerate(matches):
            if len(reordered) >= limit:
                break
            if index in used:
                continue
            reordered.append(row)
        return reordered or matches[:limit]

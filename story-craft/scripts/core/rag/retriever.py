#!/usr/bin/env python3
"""Hybrid retrieval over vector and BM25 stores."""

from __future__ import annotations

from typing import Any

from core.config import StoryCraftConfig
from core.memory_index import MemoryIndexService
from core.rag.embedding_client import EmbeddingClient, EmbeddingError
from core.rag.vector_store import VectorStore


class HybridRetriever:
    """Search vector chunks, then degrade to BM25 and legacy LIKE index."""

    def __init__(
        self,
        config: StoryCraftConfig,
        *,
        embedding_client: EmbeddingClient | None = None,
        vector_store: VectorStore | None = None,
    ):
        self.config = config
        self.embedding_client = embedding_client or EmbeddingClient()
        self.vector_store = vector_store or VectorStore(config)

    def search(
        self,
        text: str,
        *,
        kind: str | None = None,
        limit: int = 20,
        mode: str | None = None,
    ) -> list[dict[str, Any]]:
        if mode != "bm25":
            try:
                vector = self.embedding_client.embed_texts([text])[0]
                matches = self.vector_store.query_vector(vector, kind=kind, limit=limit)
                if matches:
                    return matches
            except (EmbeddingError, IndexError):
                pass

        matches = self.vector_store.query_bm25(text, kind=kind, limit=limit)
        if matches:
            return matches
        return MemoryIndexService(self.config).query(kind=kind, text=text, limit=limit)

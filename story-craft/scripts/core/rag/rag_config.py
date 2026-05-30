#!/usr/bin/env python3
"""RAG runtime configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class RagConfig:
    embedding_model: str = "Qwen/Qwen3-Embedding-8B"
    vector_dim: int = 4096
    reranker_model: str = "jina-reranker-v3"
    retrieval_mode: Literal["auto", "graph_hybrid"] = "auto"
    enable_embedding: bool = True
    api_base_url: str = ""
    api_key: str = ""
    api_max_retries: int = 3

    @classmethod
    def from_env(cls) -> "RagConfig":
        enabled = os.getenv("STORYCRAFT_ENABLE_EMBEDDING", "1").lower()
        return cls(
            embedding_model=os.getenv(
                "STORYCRAFT_EMBEDDING_MODEL",
                cls.embedding_model,
            ),
            vector_dim=int(os.getenv("STORYCRAFT_VECTOR_DIM", str(cls.vector_dim))),
            reranker_model=os.getenv("STORYCRAFT_RERANKER_MODEL", cls.reranker_model),
            retrieval_mode=os.getenv(
                "STORYCRAFT_RETRIEVAL_MODE",
                cls.retrieval_mode,
            ),  # type: ignore[arg-type]
            enable_embedding=enabled not in {"0", "false", "no", "off"},
            api_base_url=os.getenv("STORYCRAFT_API_BASE_URL", "").rstrip("/"),
            api_key=os.getenv("STORYCRAFT_API_KEY", ""),
            api_max_retries=int(os.getenv("STORYCRAFT_API_MAX_RETRIES", "3")),
        )

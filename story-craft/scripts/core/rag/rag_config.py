#!/usr/bin/env python3
"""RAG runtime configuration.

环境变量命名参考 webnovel-writer，采用 ``EMBED_*`` / ``RERANK_*`` 主名，
并保留 ``STORYCRAFT_API_*`` / ``STORYCRAFT_*`` 作为向后兼容回退。
可通过 ``.env`` 文件填写（见 :mod:`core.rag.env_loader`）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from core.rag.env_loader import load_dotenv

_FALSE_VALUES = {"0", "false", "no", "off"}


@dataclass(frozen=True)
class RagConfig:
    embedding_model: str = "Qwen/Qwen3-Embedding-8B"
    vector_dim: int = 4096
    reranker_model: str = "jina-reranker-v3"
    retrieval_mode: Literal["auto", "graph_hybrid"] = "auto"
    enable_embedding: bool = True
    enable_rerank: bool = True
    api_base_url: str = ""
    api_key: str = ""
    rerank_base_url: str = ""
    rerank_api_key: str = ""
    api_max_retries: int = 3

    @classmethod
    def from_env(cls, project_root: str | Path | None = None) -> "RagConfig":
        load_dotenv(project_root)

        embed_enabled = os.getenv("STORYCRAFT_ENABLE_EMBEDDING", "1").lower()
        rerank_enabled = os.getenv("STORYCRAFT_ENABLE_RERANK", "1").lower()

        # embedding：EMBED_* 优先，回退到旧的 STORYCRAFT_API_* / STORYCRAFT_EMBEDDING_MODEL
        embed_base = os.getenv("EMBED_BASE_URL") or os.getenv("STORYCRAFT_API_BASE_URL", "")
        embed_key = os.getenv("EMBED_API_KEY") or os.getenv("STORYCRAFT_API_KEY", "")
        embed_model = (
            os.getenv("EMBED_MODEL")
            or os.getenv("STORYCRAFT_EMBEDDING_MODEL")
            or cls.embedding_model
        )

        # rerank：RERANK_* 优先，保留 STORYCRAFT_RERANK_* 回退；不复用 embedding 端点。
        rerank_base = os.getenv("RERANK_BASE_URL") or os.getenv(
            "STORYCRAFT_RERANK_BASE_URL",
            "",
        )
        rerank_key = os.getenv("RERANK_API_KEY") or os.getenv(
            "STORYCRAFT_RERANK_API_KEY",
            "",
        )
        rerank_model = (
            os.getenv("RERANK_MODEL")
            or os.getenv("STORYCRAFT_RERANKER_MODEL")
            or cls.reranker_model
        )

        return cls(
            embedding_model=embed_model,
            vector_dim=int(os.getenv("STORYCRAFT_VECTOR_DIM", str(cls.vector_dim))),
            reranker_model=rerank_model,
            retrieval_mode=os.getenv(
                "STORYCRAFT_RETRIEVAL_MODE",
                cls.retrieval_mode,
            ),  # type: ignore[arg-type]
            enable_embedding=embed_enabled not in _FALSE_VALUES,
            enable_rerank=rerank_enabled not in _FALSE_VALUES,
            api_base_url=embed_base.rstrip("/"),
            api_key=embed_key,
            rerank_base_url=rerank_base.rstrip("/"),
            rerank_api_key=rerank_key,
            api_max_retries=int(os.getenv("STORYCRAFT_API_MAX_RETRIES", "3")),
        )

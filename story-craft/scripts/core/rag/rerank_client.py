#!/usr/bin/env python3
"""Rerank client with urllib-only transport.

调用 OpenAI / Jina / Cohere 兼容的 ``/rerank`` 接口，对候选文档按与 query 的
相关性重排。无端点或调用失败时由调用方降级（保持原顺序）。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from core.rag.api_url import build_openai_endpoint_url
from core.rag.rag_config import RagConfig


class RerankError(Exception):
    """Raised when rerank is unavailable or failed."""


class RerankClient:
    """Call an OpenAI/Jina-compatible rerank endpoint without third-party packages."""

    def __init__(self, config: RagConfig | None = None):
        self.config = config or RagConfig.from_env()

    def is_available(self) -> bool:
        return bool(
            self.config.enable_rerank
            and self.config.rerank_base_url
            and self.config.rerank_api_key
        )

    def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        """返回 ``[(原始下标, 相关性分数), ...]``，按分数从高到低。

        无法重排时抛出 :class:`RerankError`，由调用方决定降级策略。
        """
        if not self.is_available():
            raise RerankError("rerank unavailable")
        if not documents:
            return []
        documents = [document if document else " " for document in documents]

        payload: dict = {
            "model": self.config.reranker_model,
            "query": query,
            "documents": documents,
        }
        if top_n:
            payload["top_n"] = int(top_n)
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            build_openai_endpoint_url(self.config.rerank_base_url, "rerank"),
            data=data,
            headers={
                "Authorization": f"Bearer {self.config.rerank_api_key}",
                "Content-Type": "application/json",
                "User-Agent": "story-craft-rag/1.0",
            },
            method="POST",
        )

        last_error: Exception | None = None
        retries = max(1, int(self.config.api_max_retries))
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read().decode("utf-8")
                return _parse_rerank(json.loads(body), expected=len(documents))
            except (OSError, urllib.error.URLError, json.JSONDecodeError, KeyError, ValueError) as exc:
                last_error = exc
                if attempt + 1 < retries:
                    time.sleep(min(0.2 * (attempt + 1), 1.0))
        raise RerankError(str(last_error or "rerank failed"))


def _parse_rerank(payload: dict, *, expected: int) -> list[tuple[int, float]]:
    # Jina/Cohere 兼容格式：{"results": [{"index": 0, "relevance_score": 0.9}, ...]}
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError("rerank response missing results")
    ranked: list[tuple[int, float]] = []
    for item in results:
        if not isinstance(item, dict):
            raise ValueError("rerank response malformed item")
        index = item.get("index")
        if not isinstance(index, int) or not (0 <= index < expected):
            raise ValueError("rerank response index out of range")
        score = item.get("relevance_score", item.get("score", 0.0))
        ranked.append((index, float(score)))
    ranked.sort(key=lambda pair: pair[1], reverse=True)
    return ranked

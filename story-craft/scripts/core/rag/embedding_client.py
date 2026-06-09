#!/usr/bin/env python3
"""Embedding client with urllib-only transport."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from core.rag.api_url import build_openai_endpoint_url
from core.rag.rag_config import RagConfig


class EmbeddingError(Exception):
    """Raised when embedding is unavailable or failed."""


class EmbeddingClient:
    """Call an OpenAI-compatible embeddings endpoint without third-party packages."""

    def __init__(self, config: RagConfig | None = None):
        self.config = config or RagConfig.from_env()

    def is_available(self) -> bool:
        return bool(
            self.config.enable_embedding
            and self.config.api_base_url
            and self.config.api_key
        )

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if not self.is_available():
            raise EmbeddingError("embedding unavailable")
        texts = [text if text else " " for text in texts]
        payload = {
            "model": self.config.embedding_model,
            "input": texts,
            "encoding_format": "float",
        }
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            build_openai_endpoint_url(self.config.api_base_url, "embeddings"),
            data=data,
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        last_error: Exception | None = None
        for attempt in range(max(1, int(self.config.api_max_retries))):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read().decode("utf-8")
                result = json.loads(body)
                return _parse_embeddings(result, expected=len(texts))
            except (OSError, urllib.error.URLError, json.JSONDecodeError, KeyError, ValueError) as exc:
                last_error = exc
                if attempt + 1 < max(1, int(self.config.api_max_retries)):
                    time.sleep(min(0.2 * (attempt + 1), 1.0))
        raise EmbeddingError(str(last_error or "embedding failed"))


def _parse_embeddings(payload: dict, *, expected: int) -> list[list[float]]:
    data = payload.get("data")
    if not isinstance(data, list) or len(data) != expected:
        raise ValueError("embedding response item count mismatch")
    sorted_data = sorted(
        data,
        key=lambda item: item.get("index", 0) if isinstance(item, dict) else 0,
    )
    vectors: list[list[float]] = []
    for item in sorted_data:
        vector = item.get("embedding") if isinstance(item, dict) else None
        if not isinstance(vector, list):
            raise ValueError("embedding response missing vector")
        vectors.append([float(value) for value in vector])
    return vectors

#!/usr/bin/env python3
"""RAG API endpoint helpers."""

from __future__ import annotations


def build_openai_endpoint_url(base_url: str, endpoint: str) -> str:
    """Build an OpenAI-compatible ``/v1/{endpoint}`` URL from a base or full URL."""
    base = str(base_url or "").rstrip("/")
    endpoint = endpoint.strip("/")
    if not base or not endpoint:
        return base
    suffix = f"/{endpoint}"
    if base.endswith(suffix):
        return base
    if base.endswith("/v1"):
        return f"{base}/{endpoint}"
    return f"{base}/v1/{endpoint}"

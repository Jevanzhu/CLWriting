#!/usr/bin/env python3
"""Projection writer contracts and public exports."""

from __future__ import annotations

from core.projection.base import ProjectionResult, ProjectionWriter
from core.projection.markdown_view_writer import MarkdownViewProjectionWriter
from core.projection.memory_writer import MemoryProjectionWriter
from core.projection.state_writer import StateProjectionWriter
from core.projection.summary_writer import SummaryProjectionWriter

__all__ = [
    "MarkdownViewProjectionWriter",
    "MemoryProjectionWriter",
    "ProjectionResult",
    "ProjectionWriter",
    "StateProjectionWriter",
    "SummaryProjectionWriter",
]

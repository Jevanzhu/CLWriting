#!/usr/bin/env python3
"""Projection writer contracts and public exports."""

from __future__ import annotations

from core.projection.base import ProjectionResult, ProjectionWriter
from core.projection.memory_writer import MemoryProjectionWriter
from core.projection.state_writer import StateProjectionWriter
from core.projection.summary_writer import SummaryProjectionWriter

__all__ = [
    "MemoryProjectionWriter",
    "ProjectionResult",
    "ProjectionWriter",
    "StateProjectionWriter",
    "SummaryProjectionWriter",
]

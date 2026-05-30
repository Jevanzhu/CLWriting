#!/usr/bin/env python3
"""Projection writer contracts and public exports."""

from __future__ import annotations

from core.projection.base import ProjectionResult, ProjectionWriter
from core.projection.state_writer import StateProjectionWriter
from core.projection.summary_writer import SummaryProjectionWriter

__all__ = [
    "ProjectionResult",
    "ProjectionWriter",
    "StateProjectionWriter",
    "SummaryProjectionWriter",
]

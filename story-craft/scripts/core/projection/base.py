#!/usr/bin/env python3
"""Projection writer base contracts."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from core.config import StoryCraftConfig
from core.types import ChapterCommit


@dataclass
class ProjectionResult:
    name: str
    ok: bool
    skipped: bool
    detail: str


class ProjectionWriter(ABC):
    """Base class for commit-driven read-model projection writers."""

    name: str

    def __init__(self, config: StoryCraftConfig):
        self.config = config

    @abstractmethod
    def write(self, commit: ChapterCommit) -> ProjectionResult:
        """Write one read-model projection from a chapter commit."""

    def should_run(self, commit: ChapterCommit) -> bool:
        return commit.get("status") != "rejected"

    def is_lazy(self) -> bool:
        return False

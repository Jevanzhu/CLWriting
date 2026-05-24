#!/usr/bin/env python3
"""Backward-compatible chapter commit imports.

New code should use core.chapter_record.ChapterRecordService.
"""

from __future__ import annotations

from core.chapter_record import ChapterCommitService, ChapterRecordService

__all__ = ["ChapterCommitService", "ChapterRecordService"]

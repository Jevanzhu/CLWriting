#!/usr/bin/env python3
"""Deprecated backward-compatible chapter commit imports.

New code should use core.chapter_record.ChapterRecordService.
This module remains for old projects and fixtures that still import
core.chapter_commit; remove after the legacy commit contract is retired.
"""

from __future__ import annotations

from core.chapter_record import ChapterCommitService, ChapterRecordService

__all__ = ["ChapterCommitService", "ChapterRecordService"]

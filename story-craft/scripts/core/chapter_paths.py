#!/usr/bin/env python3
"""Chapter path helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from core.config import StoryCraftConfig
from core.security_utils import sanitize_filename


def chapter_file_name(
    chapter: int,
    title: str = "",
    *,
    pad_width: int = 2,
    suffix: str = ".md",
) -> str:
    """Build a chapter filename."""
    chapter_num = str(int(chapter)).zfill(pad_width)
    safe_title = sanitize_filename(title, max_length=40) if title else ""
    if safe_title:
        return f"第{chapter_num}章-{safe_title}{suffix}"
    return f"第{chapter_num}章{suffix}"


def chapter_commit_file_name(chapter: int, *, pad_width: int = 2) -> str:
    """Build a chapter commit filename."""
    chapter_num = str(int(chapter)).zfill(pad_width)
    return f"ch_{chapter_num}_commit.json"


def find_chapter_file(
    chapter: int,
    *,
    config: Optional[StoryCraftConfig] = None,
) -> Optional[Path]:
    """Find an existing chapter markdown file by number."""
    cfg = config or StoryCraftConfig()
    chapter_num = str(int(chapter)).zfill(cfg.chapter_pad_width)
    patterns = [
        f"第{chapter_num}章*.md",
        f"第{int(chapter)}章*.md",
    ]
    for pattern in patterns:
        matches = sorted(cfg.project_chapters_dir.glob(pattern))
        if matches:
            return matches[0]
    return None

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
    """Build a legacy chapter commit filename."""
    chapter_num = str(int(chapter)).zfill(pad_width)
    return f"ch_{chapter_num}_commit.json"


def chapter_record_file_name(chapter: int, *, pad_width: int = 2) -> str:
    """Build a chapter acceptance record filename."""
    chapter_num = str(int(chapter)).zfill(pad_width)
    return f"ch_{chapter_num}_record.json"


def find_chapter_record_file(
    chapter: int,
    *,
    config: Optional[StoryCraftConfig] = None,
) -> Optional[Path]:
    """Find a chapter record, accepting the old commit filename for legacy projects."""
    cfg = config or StoryCraftConfig()
    record_path = cfg.chapters_dir / chapter_record_file_name(
        chapter,
        pad_width=cfg.chapter_pad_width,
    )
    if record_path.exists():
        return record_path
    legacy_path = cfg.chapters_dir / chapter_commit_file_name(
        chapter,
        pad_width=cfg.chapter_pad_width,
    )
    if legacy_path.exists():
        return legacy_path
    return None


def iter_chapter_record_files(
    *,
    config: Optional[StoryCraftConfig] = None,
) -> list[Path]:
    """Return record files, preferring new record filenames over legacy commit ones."""
    cfg = config or StoryCraftConfig()
    if not cfg.chapters_dir.exists():
        return []
    paths_by_chapter: dict[int, Path] = {}
    for path in sorted(cfg.chapters_dir.glob("ch_*_commit.json")):
        chapter = _chapter_number_from_record_name(path.name)
        if chapter is not None:
            paths_by_chapter.setdefault(chapter, path)
    for path in sorted(cfg.chapters_dir.glob("ch_*_record.json")):
        chapter = _chapter_number_from_record_name(path.name)
        if chapter is not None:
            paths_by_chapter[chapter] = path
    return [paths_by_chapter[key] for key in sorted(paths_by_chapter)]


def _chapter_number_from_record_name(name: str) -> Optional[int]:
    parts = name.split("_")
    if len(parts) < 3:
        return None
    try:
        return int(parts[1])
    except ValueError:
        return None


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

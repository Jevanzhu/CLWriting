#!/usr/bin/env python3
"""Pre-write validation for story-craft."""

from __future__ import annotations

from pathlib import Path

from core.chapter_paths import chapter_commit_file_name
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.security_utils import read_json_safe
from core.state_manager import StateManager
from tools.placeholder_scanner import scan_placeholders


def _required_files(config: StoryCraftConfig) -> list[Path]:
    return [
        config.state_file,
        config.memory_file,
        config.learning_file,
        config.outline_dir / "总纲.md",
        config.settings_dir / "世界观.md",
        config.settings_dir / "主角卡.md",
        config.settings_dir / "独特优势.md",
    ]


def _chapter_commit(config: StoryCraftConfig, chapter: int) -> dict:
    path = config.chapters_dir / chapter_commit_file_name(
        chapter,
        pad_width=config.chapter_pad_width,
    )
    return read_json_safe(path, {}) if path.exists() else {}


def validate_prewrite(project_root: str | Path, chapter: int) -> dict:
    """Validate whether a chapter is ready to be drafted."""
    config = StoryCraftConfig.from_project_root(project_root)
    blockers: list[str] = []
    warnings: list[str] = []

    for path in _required_files(config):
        if not path.exists():
            blockers.append(f"缺少必需文件：{path.relative_to(config.project_root)}")

    if blockers:
        return {"ready": False, "blockers": blockers, "warnings": warnings}

    state = StateManager(config)
    progress = state.get_progress()
    current_chapter = int(progress.get("current_chapter") or 0)
    target_chapter = int(chapter)

    if target_chapter <= current_chapter:
        warnings.append(f"目标章节不大于当前进度：current_chapter={current_chapter}")

    if target_chapter > 1:
        previous_commit = _chapter_commit(config, target_chapter - 1)
        if not previous_commit:
            blockers.append(f"缺少上一章提交记录：第{target_chapter - 1:02d}章")
        elif previous_commit.get("status") != "accepted":
            blockers.append(f"上一章未通过审查：第{target_chapter - 1:02d}章")

    outline_text = (config.outline_dir / "总纲.md").read_text(encoding="utf-8")
    if f"第{target_chapter:02d}章" not in outline_text and f"第{target_chapter}章" not in outline_text:
        warnings.append(f"总纲未显式覆盖第{target_chapter:02d}章")

    placeholders = scan_placeholders(outline_text)
    if placeholders:
        warnings.append(f"总纲存在占位符：{len(placeholders)}处")

    urgent_items = [
        item
        for item in MemoryManager(config).get_open_foreshadowing()
        if item.get("urgency") == "high"
    ]
    if len(urgent_items) >= 3:
        warnings.append("高紧急度未兑现伏笔过多，建议先处理伏笔债")

    return {
        "ready": not blockers,
        "blockers": blockers,
        "warnings": warnings,
    }

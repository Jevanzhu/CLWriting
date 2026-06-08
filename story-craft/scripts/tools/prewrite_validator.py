#!/usr/bin/env python3
"""Pre-write validation for story-craft."""

from __future__ import annotations

from pathlib import Path

from core.chapter_paths import find_chapter_record_file
from core.config import StoryCraftConfig
from core.contract_store import ContractStore
from core.memory_manager import MemoryManager
from core.security_utils import read_json_safe
from core.state_manager import StateManager
from tools.placeholder_scanner import scan_placeholders


def _required_files(config: StoryCraftConfig) -> list[Path]:
    return [
        config.state_file,
        config.memory_file,
        config.learning_file,
        config.settings_dir / "世界观.md",
        config.settings_dir / "主角卡.md",
        config.settings_dir / "独特优势.md",
    ]


def _chapter_record(config: StoryCraftConfig, chapter: int) -> dict:
    path = find_chapter_record_file(chapter, config=config)
    return read_json_safe(path, {}) if path and path.exists() else {}


def _positive_int(value: object) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def _contract_placeholder_text(contract: dict) -> str:
    parts: list[str] = []
    directive = contract.get("chapter_directive")
    if isinstance(directive, str):
        parts.append(directive)

    must_cover = contract.get("must_cover") or []
    if isinstance(must_cover, str):
        parts.append(must_cover)
    elif isinstance(must_cover, list):
        parts.extend(item for item in must_cover if isinstance(item, str))

    return "\n".join(parts)


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

    contract = ContractStore(config).read_chapter(target_chapter)
    if not contract:
        blockers.append(f"第{target_chapter:02d}章缺少章节合同，请先 plan")
        return {"ready": False, "blockers": blockers, "warnings": warnings}
    else:
        planned_word_count = _positive_int(contract.get("planned_word_count"))
        if planned_word_count <= 0:
            blockers.append(
                f"第{target_chapter:02d}章章节合同 planned_word_count 无效，请先重新 plan"
            )

    if target_chapter <= current_chapter:
        blockers.append(f"目标章节不大于当前进度：current_chapter={current_chapter}")

    if target_chapter > 1:
        previous_record = _chapter_record(config, target_chapter - 1)
        if not previous_record:
            blockers.append(f"缺少上一章验收记录：第{target_chapter - 1:02d}章")
        elif previous_record.get("status") != "accepted":
            blockers.append(f"上一章未通过审查：第{target_chapter - 1:02d}章")

    placeholders = scan_placeholders(_contract_placeholder_text(contract or {}))
    if placeholders:
        warnings.append(f"章节合同存在占位符：{len(placeholders)}处")

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

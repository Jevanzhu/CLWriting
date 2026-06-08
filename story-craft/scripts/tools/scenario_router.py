#!/usr/bin/env python3
"""Route long-form writing requests into high-level scenarios."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.contract_store import ContractStore


SCENARIO_DAILY_CONTINUE = "daily_continue"
SCENARIO_MAJOR_REVISION = "major_revision"
SCENARIO_NEW_VOLUME = "new_volume"
SCENARIO_OPEN_BOOK = "open_book"
SCENARIO_IMPORT_EXTERNAL = "import_external"

DAILY_KEYWORDS = ("日更", "续写", "继续写", "继续", "下一章", "下章")
REVISION_KEYWORDS = ("修改", "大修", "回炉", "重写", "修订", "返工")
NEW_VOLUME_KEYWORDS = ("新卷", "开新卷", "下一卷", "第二卷", "第三卷")
IMPORT_KEYWORDS = ("导入", "外部", "既有作品", "已有作品", "导进来")


def detect_scenario(project_root: str | Path, *, user_input: str = "") -> dict[str, Any]:
    """Detect the next writing scenario without mutating project state."""
    config = StoryCraftConfig.from_project_root(project_root)
    store = ContractStore(config)
    master = store.read_master()
    commits = CommitStore(config).iter_all()
    volumes = store.iter_volumes()

    user_text = user_input.strip()
    project_type = _project_type(master, config)
    commit_count = len(commits)
    chapter_file_count = _count_chapter_files(config.project_chapters_dir)
    latest_chapter = _latest_chapter(commits, chapter_file_count)
    has_master = master is not None
    has_written_content = commit_count > 0 or chapter_file_count > 0
    tracking_exists = config.tracking_dir.exists()
    daily_ready = has_master and has_written_content and tracking_exists

    keyword_signals = {
        "daily": _contains_any(user_text, DAILY_KEYWORDS),
        "major_revision": _contains_any(user_text, REVISION_KEYWORDS),
        "new_volume": _contains_any(user_text, NEW_VOLUME_KEYWORDS),
        "import_external": _contains_any(user_text, IMPORT_KEYWORDS),
    }
    latest_volume = volumes[-1] if volumes else None
    latest_volume_completed = _latest_volume_completed(latest_volume, latest_chapter)
    is_long_project = project_type == "long"

    signals: dict[str, Any] = {
        "has_master": has_master,
        "project_type": project_type,
        "commit_count": commit_count,
        "chapter_file_count": chapter_file_count,
        "latest_chapter": latest_chapter,
        "tracking_exists": tracking_exists,
        "daily_ready": daily_ready,
        "volume_count": len(volumes),
        "latest_volume_completed": latest_volume_completed,
        "keywords": keyword_signals,
    }

    if not has_master:
        return _result(
            SCENARIO_OPEN_BOOK,
            "缺少 master 合同，进入开书场景。",
            signals,
        )

    if keyword_signals["daily"] and daily_ready:
        return _result(
            SCENARIO_DAILY_CONTINUE,
            "命中日更/续写信号，且已有正文与追踪投影。",
            signals,
        )

    if keyword_signals["major_revision"]:
        return _result(
            SCENARIO_MAJOR_REVISION,
            "命中修改、回炉或重写信号。",
            signals,
        )

    if is_long_project and (keyword_signals["new_volume"] or latest_volume_completed):
        return _result(
            SCENARIO_NEW_VOLUME,
            "长篇项目命中新卷信号，或末卷章节范围已完成。",
            signals,
        )

    if not has_written_content:
        return _result(
            SCENARIO_OPEN_BOOK,
            "尚未产生正文，进入开书场景。",
            signals,
        )

    if keyword_signals["import_external"]:
        return _result(
            SCENARIO_IMPORT_EXTERNAL,
            "命中导入或既有作品信号。",
            signals,
        )

    return _result(
        SCENARIO_DAILY_CONTINUE,
        "已有项目内容，默认进入日更续写场景。",
        signals,
    )


def _result(scenario: str, reasoning: str, signals: dict[str, Any]) -> dict[str, Any]:
    return {
        "scenario": scenario,
        "reasoning": reasoning,
        "signals": signals,
    }


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def _project_type(master: dict[str, Any] | None, config: StoryCraftConfig) -> str:
    if master and master.get("project_type") in {"short", "long"}:
        return str(master["project_type"])
    return config.project_type()


def _count_chapter_files(chapters_dir: Path) -> int:
    if not chapters_dir.exists():
        return 0
    return sum(1 for path in chapters_dir.glob("*.md") if path.is_file())


def _latest_chapter(commits: list[dict[str, Any]], chapter_file_count: int) -> int:
    commit_chapters = [_chapter_number(commit) for commit in commits]
    latest_commit_chapter = max(commit_chapters, default=0)
    return max(latest_commit_chapter, chapter_file_count)


def _chapter_number(commit: dict[str, Any]) -> int:
    try:
        return int(commit.get("chapter") or 0)
    except (TypeError, ValueError):
        return 0


def _latest_volume_completed(
    latest_volume: dict[str, Any] | None,
    latest_chapter: int,
) -> bool:
    if not latest_volume:
        return False
    chapter_range = latest_volume.get("chapter_range")
    if not isinstance(chapter_range, list) or len(chapter_range) < 2:
        return False
    try:
        return latest_chapter >= int(chapter_range[-1])
    except (TypeError, ValueError):
        return False


__all__ = [
    "SCENARIO_DAILY_CONTINUE",
    "SCENARIO_IMPORT_EXTERNAL",
    "SCENARIO_MAJOR_REVISION",
    "SCENARIO_NEW_VOLUME",
    "SCENARIO_OPEN_BOOK",
    "detect_scenario",
]

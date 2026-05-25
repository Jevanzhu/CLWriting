"""Shared test helpers for story-craft script modules."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def long_chapter(title: str, sentence: str, repeat: int = 100) -> str:
    return f"# {title}\n\n" + sentence * repeat


def reviewer_issue(**overrides) -> dict:
    issue = {
        "severity": "low",
        "category": "pacing",
        "location": "全文",
        "description": "局部节奏需要调整",
        "evidence": "测试证据",
        "fix_hint": "按审查意见微调",
        "blocking": False,
    }
    issue.update(overrides)
    return issue


def create_planned_project(root: Path) -> Path:
    from tools.init_project import init_project
    from tools.outline_planner import plan_story

    project = root / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
        protagonist_desire="查清亡友死因",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市，证据必须可回溯",
    )
    plan_story(project, chapter_count=8)
    return project

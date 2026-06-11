"""Shared test helpers for story-craft script modules."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# 测试默认隔离于本机用户级 .env（~/.claude/story-craft/.env）。
# 否则开发者一旦在本机配置了真实 EMBED_/RERANK_ key，env_loader 会把它们
# 注入测试环境，污染所有"假设无 key / embedding 不可用"的断言（含 CI）。
_RAG_ENV_KEYS = (
    "EMBED_BASE_URL",
    "EMBED_MODEL",
    "EMBED_API_KEY",
    "RERANK_BASE_URL",
    "RERANK_MODEL",
    "RERANK_API_KEY",
    "STORYCRAFT_API_BASE_URL",
    "STORYCRAFT_API_KEY",
    "STORYCRAFT_EMBEDDING_MODEL",
    "STORYCRAFT_RERANK_BASE_URL",
    "STORYCRAFT_RERANK_API_KEY",
    "STORYCRAFT_RERANKER_MODEL",
    "STORYCRAFT_ENABLE_EMBEDDING",
    "STORYCRAFT_ENABLE_RERANK",
    "STORYCRAFT_VECTOR_DIM",
    "STORYCRAFT_API_MAX_RETRIES",
    "STORYCRAFT_RETRIEVAL_MODE",
)


@pytest.fixture(autouse=True)
def _isolate_user_rag_env(monkeypatch, tmp_path_factory):
    """把 CLAUDE_HOME 指向隔离空目录并清空 RAG 环境变量，让每个测试在干净环境运行。

    需要特定 key 的测试可在用例内用 monkeypatch.setenv 自行设置（会覆盖此处）。
    """
    import core.rag.env_loader as env_loader

    isolated_home = tmp_path_factory.mktemp("claude_home")
    monkeypatch.setenv("CLAUDE_HOME", str(isolated_home))
    for key in _RAG_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    env_loader._LOADED_VALUES.clear()
    yield
    env_loader._LOADED_VALUES.clear()


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
    del title
    return sentence * repeat


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

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from core import security_utils
from core.memory_index import MemoryIndexService
from core.project_locator import (
    ENV_PROJECT_ROOT,
    locate_project_root,
    resolve_project_root,
    write_current_project_pointer,
)
from core.runtime_diagnostics import build_runtime_diagnostics
from core.security_utils import (
    AtomicWriteError,
    atomic_write_json,
    read_json_safe,
    sanitize_commit_message,
    sanitize_filename,
)
from core.state_manager import StateManager
from tools.init_project import init_project
from tools.prewrite_validator import validate_prewrite


def test_runtime_diagnostics_report_filelock_degrade():
    original = security_utils.HAS_FILELOCK
    try:
        security_utils.HAS_FILELOCK = False
        diagnostics = build_runtime_diagnostics()
    finally:
        security_utils.HAS_FILELOCK = original

    assert not diagnostics["filelock_available"]
    assert any("filelock" in warning for warning in diagnostics["warnings"])


def test_project_locator_resolves_explicit_env_ancestor_and_pointer(tmp_path):
    project = tmp_path / "故事"
    init_project(project, "暗室", "悬疑")

    explicit, explicit_source = locate_project_root(project)
    assert explicit == project.resolve()
    assert explicit_source == "explicit"

    child = project / "正文"
    child.mkdir(parents=True, exist_ok=True)
    ancestor, ancestor_source = locate_project_root(cwd=child)
    assert ancestor == project.resolve()
    assert ancestor_source == "ancestor"

    old_env = os.environ.pop(ENV_PROJECT_ROOT, None)
    try:
        os.environ[ENV_PROJECT_ROOT] = str(project)
        env_root, env_source = locate_project_root(cwd=tmp_path)
        assert env_root == project.resolve()
        assert env_source == "env"
    finally:
        if old_env is not None:
            os.environ[ENV_PROJECT_ROOT] = old_env
        else:
            os.environ.pop(ENV_PROJECT_ROOT, None)

    workspace = tmp_path / "workspace"
    (workspace / ".claude").mkdir(parents=True)
    nested = workspace / "nested"
    nested.mkdir()
    pointer = write_current_project_pointer(project, workspace_root=workspace)
    assert pointer and pointer.is_file()
    pointer_root, pointer_source = locate_project_root(cwd=nested)
    assert pointer_root == project.resolve()
    assert pointer_source == "pointer"

    fallback = resolve_project_root(tmp_path / "not-project", allow_fallback=True)
    assert fallback == (tmp_path / "not-project").resolve()

    with pytest.raises(FileNotFoundError):
        locate_project_root(tmp_path / "not-project")


def test_security_helpers_sanitize_and_preserve_json_backup(tmp_path):
    assert sanitize_filename("../第01章:雨夜?.md") == "第01章_雨夜_md"
    assert sanitize_commit_message("--amend '坏消息'\n第二行") == "坏消息 第二行"

    target = tmp_path / "state.json"
    atomic_write_json(target, {"version": 1}, use_lock=False, backup=False)
    atomic_write_json(target, {"version": 2}, use_lock=False, backup=True)
    assert json.loads(target.read_text(encoding="utf-8"))["version"] == 2
    assert (
        json.loads(target.with_suffix(".json.bak").read_text(encoding="utf-8"))["version"]
        == 1
    )

    broken = tmp_path / "broken.json"
    broken.write_text("{不是合法 JSON", encoding="utf-8")
    assert read_json_safe(broken, {"ok": False}) == {"ok": False}

    with pytest.raises(AtomicWriteError):
        atomic_write_json(tmp_path / "bad.json", {"bad": {1, 2}}, use_lock=False)


def test_state_and_prewrite_boundaries_for_medium_projects(tmp_path):
    project = tmp_path / "demo"
    init_project(project, "长夜", "现实题材", word_count_target=80000)

    state = StateManager.from_project(project).get_project()
    assert state["tier"] == "medium"

    outline = project / "大纲" / "总纲.md"
    outline.write_text("# 长夜\n\n## 第01章 开端\n\n有[TODO:补伏笔]。\n", encoding="utf-8")

    memory_file = project / ".story" / "memory.json"
    memory = json.loads(memory_file.read_text(encoding="utf-8"))
    memory["foreshadowing"] = [
        {"id": "fh_1", "status": "open", "urgency": "high", "planted_chapter": 1},
        {"id": "fh_2", "status": "open", "urgency": "high", "planted_chapter": 1},
        {"id": "fh_3", "status": "open", "urgency": "high", "planted_chapter": 1},
    ]
    atomic_write_json(memory_file, memory, use_lock=False, backup=False)

    validation = validate_prewrite(project, 1)
    assert validation["ready"]
    assert any("占位符" in warning for warning in validation["warnings"])
    assert any("伏笔债" in warning for warning in validation["warnings"])

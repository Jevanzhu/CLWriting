from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from core.project_locator import (
    ENV_PROJECT_ROOT,
    locate_project_root,
    resolve_project_root,
    write_current_project_pointer,
)
from core import security_utils
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


class Phase10CoreBoundaryTests(unittest.TestCase):
    def test_runtime_diagnostics_report_filelock_degrade(self) -> None:
        original = security_utils.HAS_FILELOCK
        try:
            security_utils.HAS_FILELOCK = False
            diagnostics = build_runtime_diagnostics()
        finally:
            security_utils.HAS_FILELOCK = original

        self.assertFalse(diagnostics["filelock_available"])
        self.assertTrue(any("filelock" in warning for warning in diagnostics["warnings"]))

    def test_project_locator_resolves_explicit_env_ancestor_and_pointer(self) -> None:
        old_env = os.environ.pop(ENV_PROJECT_ROOT, None)
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                project = root / "故事"
                init_project(project, "暗室", "悬疑")

                explicit, explicit_source = locate_project_root(project)
                self.assertEqual(explicit, project.resolve())
                self.assertEqual(explicit_source, "explicit")

                child = project / "正文"
                child.mkdir(parents=True, exist_ok=True)
                ancestor, ancestor_source = locate_project_root(cwd=child)
                self.assertEqual(ancestor, project.resolve())
                self.assertEqual(ancestor_source, "ancestor")

                os.environ[ENV_PROJECT_ROOT] = str(project)
                env_root, env_source = locate_project_root(cwd=root)
                self.assertEqual(env_root, project.resolve())
                self.assertEqual(env_source, "env")
                os.environ.pop(ENV_PROJECT_ROOT, None)

                workspace = root / "workspace"
                (workspace / ".claude").mkdir(parents=True)
                nested = workspace / "nested"
                nested.mkdir()
                pointer = write_current_project_pointer(project, workspace_root=workspace)
                self.assertTrue(pointer and pointer.is_file())
                pointer_root, pointer_source = locate_project_root(cwd=nested)
                self.assertEqual(pointer_root, project.resolve())
                self.assertEqual(pointer_source, "pointer")

                fallback = resolve_project_root(root / "not-project", allow_fallback=True)
                self.assertEqual(fallback, (root / "not-project").resolve())

                with self.assertRaises(FileNotFoundError):
                    locate_project_root(root / "not-project")
        finally:
            if old_env is not None:
                os.environ[ENV_PROJECT_ROOT] = old_env
            else:
                os.environ.pop(ENV_PROJECT_ROOT, None)

    def test_security_helpers_sanitize_and_preserve_json_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            self.assertEqual(sanitize_filename("../第01章:雨夜?.md"), "第01章_雨夜_md")
            self.assertEqual(
                sanitize_commit_message("--amend '坏消息'\n第二行"),
                "坏消息 第二行",
            )

            target = root / "state.json"
            atomic_write_json(target, {"version": 1}, use_lock=False, backup=False)
            atomic_write_json(target, {"version": 2}, use_lock=False, backup=True)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["version"], 2)
            self.assertEqual(
                json.loads(target.with_suffix(".json.bak").read_text(encoding="utf-8"))[
                    "version"
                ],
                1,
            )

            broken = root / "broken.json"
            broken.write_text("{不是合法 JSON", encoding="utf-8")
            self.assertEqual(read_json_safe(broken, {"ok": False}), {"ok": False})

            with self.assertRaises(AtomicWriteError):
                atomic_write_json(root / "bad.json", {"bad": {1, 2}}, use_lock=False)

    def test_state_and_prewrite_boundaries_for_medium_projects(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "demo"
            init_project(project, "长夜", "现实题材", word_count_target=80000)

            state = StateManager.from_project(project).get_project()
            self.assertEqual(state["tier"], "medium")

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
            self.assertTrue(validation["ready"])
            self.assertTrue(any("占位符" in warning for warning in validation["warnings"]))
            self.assertTrue(any("伏笔债" in warning for warning in validation["warnings"]))


if __name__ == "__main__":
    unittest.main()

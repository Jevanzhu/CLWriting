from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
import os
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_DIR.parents[1]
SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


class Phase15UsabilityDocsTests(unittest.TestCase):
    def test_cli_help_is_chinese_and_author_facing(self) -> None:
        root_help = run_cli("--help")
        self.assertEqual(root_help.returncode, 0, root_help.stderr)
        self.assertIn("用法:", root_help.stdout)
        self.assertIn("初始化一个故事项目", root_help.stdout)
        self.assertIn("显示帮助信息并退出", root_help.stdout)

        write_help = run_cli("write", "--help")
        self.assertEqual(write_help.returncode, 0, write_help.stderr)
        self.assertIn("提交一章草稿并更新故事记忆", write_help.stdout)
        self.assertIn("write 3", write_help.stdout)
        self.assertIn("把写前校验和字数偏差 warning 也视为阻断", write_help.stdout)

        review_help = run_cli("review", "--help")
        self.assertEqual(review_help.returncode, 0, review_help.stderr)
        self.assertIn("review 3", review_help.stdout)

    def test_project_root_errors_explain_next_step(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            proc = run_cli("--project-root", str(Path(temp) / "missing"), "query", "status")

            self.assertEqual(proc.returncode, 1)
            self.assertIn("项目定位失败", proc.stderr)
            self.assertIn("下一步", proc.stderr)
            self.assertIn("--project-root", proc.stderr)

    def test_readme_is_project_intro_and_docs_navigation(self) -> None:
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

        for heading in (
            "## 项目形态",
            "## 核心入口",
            "## 文档导航",
            "## 当前边界",
        ):
            self.assertIn(heading, readme)
        self.assertIn("Claude Code 插件包", readme)
        self.assertIn("docs/quickstart.md", readme)
        self.assertIn("docs/claude-code-usage.md", readme)
        self.assertIn("docs/cli-usage.md", readme)
        self.assertIn("docs/data-formats.md", readme)
        self.assertIn("docs/troubleshooting.md", readme)
        self.assertIn("docs/development.md", readme)
        self.assertIn("不提供独立的 `story-craft <subcommand>` 命令封装", readme)

    def test_usage_docs_are_split_by_category(self) -> None:
        docs = {
            "quickstart.md": ("/story-init", "/story-write 1"),
            "claude-code-usage.md": ("Agent 编排", ".story/workflows/ch_NN/"),
            "cli-usage.md": ("write 1", "review 1"),
            "data-formats.md": ("reviewer JSON", "delta JSON"),
            "troubleshooting.md": ("word_count_check", "工作台恢复"),
            "development.md": ("测试命令", "README 只放项目介绍"),
        }
        docs_dir = REPO_ROOT / "docs"
        for filename, expected_fragments in docs.items():
            text = (docs_dir / filename).read_text(encoding="utf-8")
            for fragment in expected_fragments:
                self.assertIn(fragment, text)


if __name__ == "__main__":
    unittest.main()

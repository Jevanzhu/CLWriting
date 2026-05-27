from __future__ import annotations

import os
import subprocess
import sys
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


def test_cli_help_is_chinese_and_author_facing():
    root_help = run_cli("--help")
    assert root_help.returncode == 0, root_help.stderr
    assert "用法:" in root_help.stdout
    assert "初始化一个故事项目" in root_help.stdout
    assert "显示帮助信息并退出" in root_help.stdout

    write_help = run_cli("write", "--help")
    assert write_help.returncode == 0, write_help.stderr
    assert "验收一章草稿并更新故事记忆" in write_help.stdout
    assert "write 3" in write_help.stdout
    assert "把写前校验和字数偏差 warning 也视为阻断" in write_help.stdout

    review_help = run_cli("review", "--help")
    assert review_help.returncode == 0, review_help.stderr
    assert "review 3" in review_help.stdout


def test_project_root_errors_explain_next_step(tmp_path):
    proc = run_cli("--project-root", str(tmp_path / "missing"), "query", "status")

    assert proc.returncode == 1
    assert "项目定位失败" in proc.stderr
    assert "下一步" in proc.stderr
    assert "--project-root" in proc.stderr


def test_readme_is_project_intro_and_docs_navigation():
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    for heading in (
        "## 快速开始",
        "## 项目结构",
        "## 文档",
    ):
        assert heading in readme
    assert "1-10 万字" in readme
    assert "docs/quickstart.md" in readme
    assert "docs/claude-code-usage.md" in readme
    assert "docs/cli-usage.md" in readme
    assert "docs/data-formats.md" in readme
    assert "docs/troubleshooting.md" in readme
    assert "docs/development.md" in readme


def test_usage_docs_are_split_by_category():
    docs = {
        "quickstart.md": ("/story-init", "/story-write 1"),
        "claude-code-usage.md": ("Agent 编排", ".story/workflows/ch_NN/"),
        "cli-usage.md": ("write 1", "review 1"),
        "data-formats.md": ("reviewer JSON", "data-agent 完整输出", "write 最小可消费 delta"),
        "troubleshooting.md": ("word_count_check", "工作台恢复"),
        "development.md": ("测试命令", "README 只放项目介绍"),
    }
    docs_dir = REPO_ROOT / "docs"
    for filename, expected_fragments in docs.items():
        text = (docs_dir / filename).read_text(encoding="utf-8")
        for fragment in expected_fragments:
            assert fragment in text


def test_write_result_docs_list_actual_stage_contract():
    text = (REPO_ROOT / "docs" / "data-formats.md").read_text(encoding="utf-8")

    assert '"ok": true' in text
    assert "WriteResult = WriteSuccess | WriteFailure" in text
    assert "WriteSuccess" in text
    assert "WriteFailure" in text
    for stage in (
        "prewrite",
        "placeholder",
        "word_count",
        "warnings",
        "delta_validation",
        "record",
        "write_error",
    ):
        assert f"`{stage}`" in text

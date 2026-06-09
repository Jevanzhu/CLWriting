from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
TEMPLATES_DIR = REPO_ROOT / "story-craft" / "skills" / "story-init" / "references" / "templates"
HOOKS_DIR = TEMPLATES_DIR / "hooks"
SETTINGS_HOOKS = TEMPLATES_DIR / "settings-hooks.json"

HOOK_FILES = {
    "session-start.sh",
    "session-end.sh",
    "pre-compact.sh",
    "post-compact.sh",
    "detect-story-gaps.sh",
    "validate-story-commit.sh",
}
LIB_FILES = {"lib/common.sh", "lib/sentinel.sh"}


def test_hook_template_files_exist_and_pass_bash_syntax():
    paths = [HOOKS_DIR / relative_path for relative_path in sorted(HOOK_FILES | LIB_FILES)]

    for path in paths:
        assert path.exists(), f"missing hook template: {path.relative_to(REPO_ROOT)}"
        result = subprocess.run(
            ["bash", "-n", str(path)],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr


def test_hook_templates_remove_legacy_book_and_sentinel_logic():
    corpus = _template_corpus()

    forbidden_patterns = [
        r"\.active-book",
        r"\.story-deployed",
        r"discover_[A-Za-z0-9_]*book",
        r"/story-setup",
        r'"PostCompact"',
    ]
    for pattern in forbidden_patterns:
        assert not re.search(pattern, corpus), pattern


def test_common_and_sentinel_use_story_craft_project_contracts():
    common = (HOOKS_DIR / "lib" / "common.sh").read_text(encoding="utf-8")
    sentinel = (HOOKS_DIR / "lib" / "sentinel.sh").read_text(encoding="utf-8")

    assert ".story/state.json" in common
    assert "project_root()" in common
    assert ".story/contracts/deployment.json" in sentinel
    for field in ("agents_version", "project_type", "setup_skill_version", "target_cli"):
        assert field in sentinel or field in (HOOKS_DIR / "session-start.sh").read_text(encoding="utf-8")
    assert "python3" in sentinel
    assert "awk" not in sentinel


def test_session_and_gap_hooks_reference_project_views():
    session_start = (HOOKS_DIR / "session-start.sh").read_text(encoding="utf-8")
    pre_compact = (HOOKS_DIR / "pre-compact.sh").read_text(encoding="utf-8")
    post_compact = (HOOKS_DIR / "post-compact.sh").read_text(encoding="utf-8")
    gaps = (HOOKS_DIR / "detect-story-gaps.sh").read_text(encoding="utf-8")

    assert "/story-init" in session_start
    assert "agents_version" in session_start
    assert "追踪/上下文.md" in session_start
    assert "追踪/上下文.md" in pre_compact
    assert "追踪/上下文.md" in post_compact
    assert "设定" in gaps
    assert "大纲" in gaps
    assert "小节大纲.md" in gaps
    assert "project_type" in gaps


def test_settings_hooks_register_expected_events_and_commands():
    settings = json.loads(SETTINGS_HOOKS.read_text(encoding="utf-8"))
    hooks = settings["hooks"]

    assert set(hooks) == {"SessionStart", "SessionEnd", "PreToolUse", "PreCompact"}

    session_start_commands = _commands_for_event(hooks, "SessionStart")
    assert session_start_commands == [
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh',
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/detect-story-gaps.sh',
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/post-compact.sh',
    ]
    compact_entries = [entry for entry in hooks["SessionStart"] if entry.get("matcher") == "source=compact"]
    assert len(compact_entries) == 1
    assert _commands_for_entries(compact_entries) == [
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/post-compact.sh'
    ]

    assert _commands_for_event(hooks, "SessionEnd") == [
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-end.sh'
    ]
    assert _commands_for_event(hooks, "PreCompact") == [
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/pre-compact.sh'
    ]

    pre_tool = hooks["PreToolUse"][0]
    assert pre_tool["matcher"] == "Bash"
    assert pre_tool["hooks"][0]["command"] == (
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-story-commit.sh'
    )
    assert pre_tool["hooks"][0]["if"] == "Bash(git commit*)"


def _template_corpus() -> str:
    parts = [SETTINGS_HOOKS.read_text(encoding="utf-8")]
    for path in sorted(HOOKS_DIR.rglob("*.sh")):
        parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


def _commands_for_event(hooks: dict, event_name: str) -> list[str]:
    return _commands_for_entries(hooks[event_name])


def _commands_for_entries(entries: list[dict]) -> list[str]:
    commands: list[str] = []
    for entry in entries:
        for hook in entry["hooks"]:
            commands.append(hook["command"])
    return commands

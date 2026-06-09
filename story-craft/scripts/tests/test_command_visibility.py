from __future__ import annotations

from pathlib import Path

from tools.deployment import COMMAND_NAMES, deployment_manifest


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
COMMANDS_DIR = PLUGIN_ROOT / "commands"

COMMON_COMMANDS = {
    "story-init",
    "story-review",
    "story-deslop",
    "story-repair",
    "story-import",
    "story-query",
    "story-learn",
    "story-preflight",
}
LONG_COMMANDS = {
    "story-long-write",
    "story-long-plan",
    "story-long-analyze",
    "story-long-scan",
}
SHORT_COMMANDS = {"story-short-write"}


def test_command_track_counts_are_explicit():
    assert len(COMMON_COMMANDS) == 8
    assert len(LONG_COMMANDS) == 4
    assert len(SHORT_COMMANDS) == 1
    assert len(COMMON_COMMANDS | LONG_COMMANDS | SHORT_COMMANDS) == 13


def test_project_type_visible_command_matrix_matches_stage4_contract():
    long_visible = COMMON_COMMANDS | LONG_COMMANDS
    short_visible = COMMON_COMMANDS | SHORT_COMMANDS

    assert len(long_visible) == 12
    assert len(short_visible) == 9
    assert "story-short-write" not in long_visible
    assert LONG_COMMANDS.isdisjoint(short_visible)


def test_deployment_keeps_all_commands_available_for_both_tracks():
    actual_files = {path.stem for path in COMMANDS_DIR.glob("*.md")}
    deployed_names = {
        Path(asset.source).stem
        for asset in deployment_manifest("short")
        if asset.source.startswith("commands/")
    }

    assert actual_files == set(COMMAND_NAMES)
    assert deployed_names == actual_files
    assert {
        Path(asset.source).stem
        for asset in deployment_manifest("long")
        if asset.source.startswith("commands/")
    } == actual_files


def test_track_specific_commands_document_runtime_visibility_rules():
    for command_name in sorted(LONG_COMMANDS):
        text = (COMMANDS_DIR / f"{command_name}.md").read_text(encoding="utf-8")
        assert "当前为短篇项目" in text
        assert "不要把命令物理隐藏" in text

    for command_name in sorted(SHORT_COMMANDS):
        text = (COMMANDS_DIR / f"{command_name}.md").read_text(encoding="utf-8")
        assert "当前为长篇项目" in text
        assert "不要把命令物理隐藏" in text

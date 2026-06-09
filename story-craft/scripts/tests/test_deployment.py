from __future__ import annotations

from dataclasses import asdict

import pytest

from core.config import StoryCraftConfig
from tools.deployment import (
    AGENTS_VERSION,
    Asset,
    deployment_manifest,
    merge_claude_md,
    merge_settings,
    needs_redeploy,
    read_deployment,
    write_deployment,
)


def test_deployment_manifest_counts_short_and_long_assets():
    short_manifest = deployment_manifest("short")
    long_manifest = deployment_manifest("long")

    assert all(isinstance(asset, Asset) for asset in short_manifest)
    assert _count_sources(short_manifest, "agents/") == 4
    assert _count_sources(long_manifest, "agents/") == 9
    assert _count_sources(short_manifest, "commands/") == 13
    assert _count_sources(long_manifest, "commands/") == 13
    assert _count_targets(short_manifest, ".claude/hooks/") == 8
    assert any(asset.target == ".story/contracts/deployment.json" for asset in long_manifest)


def test_deployment_manifest_rejects_unknown_project_type():
    with pytest.raises(ValueError, match="project_type"):
        deployment_manifest("medium")


def test_deployment_manifest_assets_are_serializable():
    payload = [asdict(asset) for asset in deployment_manifest("short")]

    assert payload[0]["source"]
    assert payload[0]["target"]
    assert payload[0]["owner_class"] in {"managed", "user", "shared"}
    assert payload[0]["merge_mode"] in {"overwrite", "merge", "skip-if-exists"}
    assert payload[0]["validation"]


def test_merge_claude_md_overwrites_managed_and_preserves_user_sections():
    existing = """# Demo

## Story Craft

旧内容

## User Notes

保留这段
"""
    managed = {
        "Story Craft": "新部署说明",
        "Story Commands": "命令列表",
    }

    merged = merge_claude_md(existing, managed)

    assert "旧内容" not in merged
    assert "新部署说明" in merged
    assert "## User Notes" in merged
    assert "保留这段" in merged
    assert "## Story Commands" in merged
    assert merge_claude_md(merged, managed) == merged


def test_merge_claude_md_deduplicates_repeated_managed_sections():
    existing = """## Story Craft

旧1

## Story Craft

旧2
"""

    merged = merge_claude_md(existing, {"Story Craft": "新内容"})

    assert merged.count("## Story Craft") == 1
    assert "新内容" in merged
    assert "旧1" not in merged
    assert "旧2" not in merged


def test_merge_settings_deduplicates_hooks_by_command_and_preserves_user_keys():
    existing = {
        "permissions": {"allow": ["Bash(git status)"]},
        "env": {"A": "1"},
        "theme": "dark",
        "hooks": {
            "SessionStart": [
                {
                    "hooks": [
                        {"type": "command", "command": "bash user.sh", "timeout": 3},
                        {"type": "command", "command": "bash managed.sh", "timeout": 1},
                    ]
                }
            ]
        },
    }
    managed = {
        "hooks": {
            "SessionStart": [
                {
                    "hooks": [
                        {"type": "command", "command": "bash managed.sh", "timeout": 10},
                        {"type": "command", "command": "bash new.sh", "timeout": 5},
                    ]
                }
            ],
            "PreCompact": [
                {
                    "hooks": [
                        {"type": "command", "command": "bash pre-compact.sh", "timeout": 10}
                    ]
                }
            ],
        }
    }

    merged = merge_settings(existing, managed)
    commands = _commands_for_event(merged, "SessionStart")

    assert merged["permissions"] == existing["permissions"]
    assert merged["env"] == existing["env"]
    assert merged["theme"] == "dark"
    assert commands == ["bash user.sh", "bash managed.sh", "bash new.sh"]
    assert _timeout_for_command(merged, "SessionStart", "bash managed.sh") == 10
    assert _commands_for_event(merged, "PreCompact") == ["bash pre-compact.sh"]
    assert merge_settings(merged, managed) == merged


def test_deployment_sentinel_round_trip_and_redeploy_boundaries(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)

    assert read_deployment(config) == {}
    path = write_deployment(
        config,
        agents_version=AGENTS_VERSION,
        setup_skill_version="4.0.0",
        target_cli="claude-code",
        project_type="long",
        resolver_strategy="project-root-state-json",
        references_dir=".claude/story-craft/references",
    )

    payload = read_deployment(config)

    assert path == config.deployment_file
    assert payload["agents_version"] == AGENTS_VERSION
    assert payload["setup_skill_version"] == "4.0.0"
    assert payload["target_cli"] == "claude-code"
    assert payload["project_type"] == "long"
    assert not needs_redeploy(payload, AGENTS_VERSION)
    assert needs_redeploy({"agents_version": AGENTS_VERSION - 1}, AGENTS_VERSION)
    assert needs_redeploy({}, AGENTS_VERSION)
    assert not needs_redeploy({"agents_version": AGENTS_VERSION + 1}, AGENTS_VERSION)
    assert not needs_redeploy({"agents_version": f"{AGENTS_VERSION}.0.0"}, AGENTS_VERSION)


def test_write_deployment_rejects_unknown_project_type(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)

    with pytest.raises(ValueError, match="project_type"):
        write_deployment(
            config,
            agents_version=AGENTS_VERSION,
            setup_skill_version="4.0.0",
            target_cli="claude-code",
            project_type="medium",
            resolver_strategy="project-root-state-json",
            references_dir=".claude/story-craft/references",
        )


def _count_sources(manifest, prefix: str) -> int:
    return sum(1 for asset in manifest if asset.source.startswith(prefix))


def _count_targets(manifest, prefix: str) -> int:
    return sum(1 for asset in manifest if asset.target.startswith(prefix))


def _commands_for_event(settings, event_name: str) -> list[str]:
    commands: list[str] = []
    for entry in settings["hooks"][event_name]:
        for hook in entry["hooks"]:
            commands.append(hook["command"])
    return commands


def _timeout_for_command(settings, event_name: str, command: str) -> int:
    for entry in settings["hooks"][event_name]:
        for hook in entry["hooks"]:
            if hook["command"] == command:
                return hook["timeout"]
    raise AssertionError(command)

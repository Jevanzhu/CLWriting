from __future__ import annotations

import json
from pathlib import Path

from core.config import StoryCraftConfig
from tools.deployment import (
    AGENTS_VERSION,
    COMMAND_NAMES,
    HOOK_TEMPLATE_FILES,
    RESOLVER_STRATEGY,
    TARGET_CLI,
    deployment_manifest,
    merge_settings,
    read_deployment,
    write_deployment,
)


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SETTINGS_HOOKS = (
    PLUGIN_ROOT
    / "skills"
    / "story-init"
    / "references"
    / "templates"
    / "settings-hooks.json"
)


def test_deployment_manifest_sentinel_asset_contract_is_exact():
    sentinel_assets = [
        asset for asset in deployment_manifest("long") if asset.source == "deployment-sentinel"
    ]

    assert len(sentinel_assets) == 1
    sentinel = sentinel_assets[0]
    assert sentinel.target == ".story/contracts/deployment.json"
    assert sentinel.owner_class == "managed"
    assert sentinel.merge_mode == "overwrite"
    assert sentinel.validation == "json:deployment"


def test_deployment_manifest_commands_match_command_files():
    command_files = {path.stem for path in (PLUGIN_ROOT / "commands").glob("*.md")}
    manifest_commands = {
        Path(asset.source).stem
        for asset in deployment_manifest("short")
        if asset.source.startswith("commands/")
    }

    assert command_files == set(COMMAND_NAMES)
    assert manifest_commands == command_files
    assert {
        Path(asset.source).stem
        for asset in deployment_manifest("long")
        if asset.source.startswith("commands/")
    } == command_files


def test_deployment_manifest_hooks_match_template_files():
    template_files = {
        str(path.relative_to(PLUGIN_ROOT / "skills" / "story-init" / "references" / "templates" / "hooks"))
        for path in (
            PLUGIN_ROOT
            / "skills"
            / "story-init"
            / "references"
            / "templates"
            / "hooks"
        ).rglob("*")
        if path.is_file()
    }
    manifest_hooks = {
        asset.source.removeprefix("skills/story-init/references/templates/hooks/")
        for asset in deployment_manifest("short")
        if asset.source.startswith("skills/story-init/references/templates/hooks/")
    }

    assert template_files == set(HOOK_TEMPLATE_FILES)
    assert manifest_hooks == template_files
    assert {
        asset.source.removeprefix("skills/story-init/references/templates/hooks/")
        for asset in deployment_manifest("long")
        if asset.source.startswith("skills/story-init/references/templates/hooks/")
    } == template_files


def test_deployment_sentinel_payload_includes_all_contract_fields(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)

    write_deployment(
        config,
        agents_version=AGENTS_VERSION,
        setup_skill_version="4.0.0",
        target_cli=TARGET_CLI,
        project_type="short",
        resolver_strategy=RESOLVER_STRATEGY,
        references_dir=".claude/story-craft/references",
    )
    payload = read_deployment(config)

    assert payload == {
        "schema_version": "story-craft/deployment-v1",
        "agents_version": AGENTS_VERSION,
        "setup_skill_version": "4.0.0",
        "target_cli": TARGET_CLI,
        "project_type": "short",
        "resolver_strategy": RESOLVER_STRATEGY,
        "references_dir": ".claude/story-craft/references",
    }


def test_real_settings_hooks_merge_is_idempotent_and_preserves_user_entries():
    managed = json.loads(SETTINGS_HOOKS.read_text(encoding="utf-8"))
    existing = {
        "theme": "dark",
        "hooks": {
            "SessionStart": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "bash user-session.sh",
                            "timeout": 3,
                        }
                    ]
                }
            ],
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {
                            "type": "command",
                            "command": 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-story-commit.sh',
                            "timeout": 1,
                            "if": "Bash(git commit*)",
                        }
                    ],
                }
            ],
        },
    }

    merged = merge_settings(existing, managed)
    merged_again = merge_settings(merged, managed)

    assert merged == merged_again
    assert merged["theme"] == "dark"
    assert _commands_for_event(merged, "SessionStart")[0] == "bash user-session.sh"
    assert _timeouts_for_command(
        merged,
        "PreToolUse",
        'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-story-commit.sh',
    ) == 15


def _commands_for_event(settings: dict, event_name: str) -> list[str]:
    return [
        hook["command"]
        for entry in settings["hooks"][event_name]
        for hook in entry.get("hooks", [])
    ]


def _timeouts_for_command(settings: dict, event_name: str, command: str) -> int:
    for entry in settings["hooks"][event_name]:
        for hook in entry.get("hooks", []):
            if hook.get("command") == command:
                return hook["timeout"]
    raise AssertionError(command)

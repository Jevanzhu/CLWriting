from __future__ import annotations

import argparse
import re
from pathlib import Path

from cli.cli_args import build_parser


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = PLUGIN_ROOT / "agents"
SKILLS_DIR = PLUGIN_ROOT / "skills"
REPO_ROOT = PLUGIN_ROOT.parent


EXPECTED_AGENT_COUNT = 9
EXPECTED_SKILL_COUNT = 17
FRONTMATTER_RE = re.compile(r"---\n(.*?)\n---", re.DOTALL)
SUBAGENT_RE = re.compile(r'subagent_type:\s*"story-craft:([^"]+)"')
CLI_COMMAND_RE = re.compile(
    r"story_craft\.py\"?\s+"
    r"(?:--project-root\s+\"?\$\{PROJECT_ROOT\}\"?\s+)?"
    r"([a-z][\w-]*)"
)
AGENT_SUBCOMMAND_RE = re.compile(r"story_craft\.py\"?.*?\sagent\s+([a-z][\w-]*)")
REFERENCE_PATH_RE = re.compile(r"`?(references/[^\s`，。；;,)\]]+)`?")


def _frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    assert match, f"missing frontmatter: {path}"
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


def _root_commands() -> set[str]:
    parser = build_parser()
    subparser_actions = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]
    return set(subparser_actions[0].choices)


def _agent_subcommands() -> set[str]:
    parser = build_parser()
    root_subparsers = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ][0]
    agent_parser = root_subparsers.choices["agent"]
    agent_subparsers = [
        action
        for action in agent_parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ][0]
    return set(agent_subparsers.choices)


def test_stage3_has_nine_agents_and_seventeen_skills():
    agent_files = sorted(AGENTS_DIR.glob("*.md"))
    skill_files = sorted(SKILLS_DIR.glob("story-*/SKILL.md"))

    assert len(agent_files) == EXPECTED_AGENT_COUNT
    assert len(skill_files) == EXPECTED_SKILL_COUNT


def test_agent_frontmatter_fields_are_legal():
    for path in AGENTS_DIR.glob("*.md"):
        frontmatter = _frontmatter(path)
        assert frontmatter.get("name") == path.stem
        assert frontmatter.get("description")
        assert frontmatter.get("tools")
        assert frontmatter.get("model") in {"inherit", "haiku", "sonnet", "opus"}


def test_skill_frontmatter_fields_are_legal():
    for path in SKILLS_DIR.glob("story-*/SKILL.md"):
        frontmatter = _frontmatter(path)
        skill_name = path.parent.name
        assert frontmatter.get("name") == skill_name
        assert frontmatter.get("description")
        assert frontmatter.get("allowed-tools")


def test_skill_subagent_references_point_to_existing_agents():
    agent_names = {_frontmatter(path)["name"] for path in AGENTS_DIR.glob("*.md")}
    missing: list[str] = []

    for path in SKILLS_DIR.glob("story-*/SKILL.md"):
        text = path.read_text(encoding="utf-8")
        for subagent_name in SUBAGENT_RE.findall(text):
            if subagent_name not in agent_names:
                missing.append(f"{path.parent.name}: {subagent_name}")

    assert not missing


def test_skill_cli_commands_point_to_existing_subcommands():
    root_commands = _root_commands()
    missing: list[str] = []

    for path in SKILLS_DIR.glob("story-*/SKILL.md"):
        text = path.read_text(encoding="utf-8")
        for command in CLI_COMMAND_RE.findall(text):
            if command not in root_commands:
                missing.append(f"{path.parent.name}: {command}")

    assert not missing


def test_skill_agent_cli_subcommands_point_to_existing_subcommands():
    agent_subcommands = _agent_subcommands()
    missing: list[str] = []

    for path in SKILLS_DIR.glob("story-*/SKILL.md"):
        text = path.read_text(encoding="utf-8")
        for subcommand in AGENT_SUBCOMMAND_RE.findall(text):
            if subcommand not in agent_subcommands:
                missing.append(f"{path.parent.name}: agent {subcommand}")

    assert not missing


def test_reference_paths_used_by_agents_and_skills_exist():
    missing: list[str] = []
    for path in list(AGENTS_DIR.glob("*.md")) + list(SKILLS_DIR.glob("story-*/SKILL.md")):
        text = path.read_text(encoding="utf-8")
        for raw_reference in REFERENCE_PATH_RE.findall(text):
            reference = raw_reference.rstrip(".")
            if reference.startswith("references/templates/"):
                continue
            if not (PLUGIN_ROOT / reference).is_file():
                missing.append(f"{path.relative_to(PLUGIN_ROOT)}: {reference}")

    assert not missing


def test_stage3_cc_verification_doc_exists_and_keeps_boundaries_clear():
    text = (REPO_ROOT / "docs" / "stage3-cc-verification.md").read_text(encoding="utf-8")

    for phrase in (
        "已自动验证",
        "待 Claude Code 验证",
        "不得标为已通过",
        "agent spawn",
        "reviewer full/lean/solo",
        "5 场景分流",
        "story-deslop",
        "story-repair",
        "story-import",
    ):
        assert phrase in text

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
COMMANDS_DIR = PLUGIN_ROOT / "commands"
SKILLS_DIR = PLUGIN_ROOT / "skills"

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
EXPECTED_COMMANDS = COMMON_COMMANDS | LONG_COMMANDS | SHORT_COMMANDS
FORBIDDEN_COMMANDS = {
    "story-migrate",
    "story-cover",
    "story-dashboard",
    "story-short-analyze",
    "story-short-scan",
}


def test_stage4_has_exactly_thirteen_command_files():
    command_names = {path.stem for path in COMMANDS_DIR.glob("*.md")}

    assert command_names == EXPECTED_COMMANDS
    assert len(command_names) == 13
    assert not (command_names & FORBIDDEN_COMMANDS)


def test_commands_have_legal_frontmatter_and_delegate_to_existing_skills():
    for command_name in EXPECTED_COMMANDS:
        command_file = COMMANDS_DIR / f"{command_name}.md"
        text = command_file.read_text(encoding="utf-8")
        frontmatter = _frontmatter(text)

        assert frontmatter.get("description"), command_name
        assert "story-craft:" in text
        assert f"story-craft:{command_name}" in text
        assert (SKILLS_DIR / command_name / "SKILL.md").is_file()
        assert "委托到" in text


def test_common_commands_document_shared_project_type_scope():
    for command_name in COMMON_COMMANDS:
        text = (COMMANDS_DIR / f"{command_name}.md").read_text(encoding="utf-8")

        assert "project_type=short" in text
        assert "project_type=long" in text
        assert "共用命令" in text


def test_track_specific_commands_document_project_type_misuse_prompts():
    for command_name in LONG_COMMANDS:
        text = (COMMANDS_DIR / f"{command_name}.md").read_text(encoding="utf-8")

        assert "project_type=short" in text
        assert "当前为短篇项目" in text
        assert "不要把命令物理隐藏" in text
        assert "story_craft.py where" in text

    for command_name in SHORT_COMMANDS:
        text = (COMMANDS_DIR / f"{command_name}.md").read_text(encoding="utf-8")

        assert "project_type=long" in text
        assert "当前为长篇项目" in text
        assert "不要把命令物理隐藏" in text
        assert "story_craft.py where" in text


def test_commands_do_not_define_excluded_stage4_entries():
    corpus = "\n".join(path.read_text(encoding="utf-8") for path in COMMANDS_DIR.glob("*.md"))

    for forbidden in FORBIDDEN_COMMANDS:
        assert forbidden not in corpus


def _frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"---\n(.*?)\n---", text, re.DOTALL)
    assert match, "missing frontmatter"
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields

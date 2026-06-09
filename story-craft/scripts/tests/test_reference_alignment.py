from __future__ import annotations

import json
import re
from pathlib import Path

from conftest import create_planned_project, run_cli
from tools.agent_workflow import build_workflow_workspace


REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_ROOT = REPO_ROOT / "story-craft"
REFERENCES_DIR = PLUGIN_ROOT / "references"
SKILLS_DIR = PLUGIN_ROOT / "skills"
REFERENCE_PATH_RE = re.compile(r"`(references/(?:shared|short|long)/[^`]+)`")

SHORT_TRACK_SKILLS = {
    "story-short-write",
    "story-short-analyze",
    "story-short-scan",
}
LONG_TRACK_SKILLS = {
    "story-long-write",
    "story-long-plan",
    "story-long-analyze",
    "story-long-scan",
}


def extract_loading_map_skill_refs() -> dict[str, set[str]]:
    text = (REFERENCES_DIR / "index" / "reference-loading-map.md").read_text(
        encoding="utf-8"
    )
    skill_section = text.split("## Skill 映射", 1)[1].split("## Agent 映射", 1)[0]
    skill_refs: dict[str, set[str]] = {}
    current_skill: str | None = None

    for line in skill_section.splitlines():
        skill_match = re.match(r"- `/(story-[^`]+)`", line)
        if skill_match:
            current_skill = skill_match.group(1)
            skill_refs[current_skill] = set()
            continue
        if current_skill is None:
            continue
        skill_refs[current_skill].update(REFERENCE_PATH_RE.findall(line))

    return skill_refs


def extract_skill_reference_table_refs(skill_name: str) -> set[str]:
    text = (SKILLS_DIR / skill_name / "SKILL.md").read_text(encoding="utf-8")
    match = re.search(r"## 参考加载表\n(?P<body>.*?)(?:\n## |\Z)", text, re.DOTALL)
    assert match, f"missing reference loading table in {skill_name}"
    return set(REFERENCE_PATH_RE.findall(match.group("body")))


def test_workflow_workspace_manifest_matches_reference_boundary(tmp_path):
    project = create_planned_project(tmp_path)

    manifest = build_workflow_workspace(project, 1)

    workflow_dir = Path(manifest["workflow_dir"])
    assert workflow_dir.is_dir()
    assert workflow_dir.name == "ch_01"
    assert Path(manifest["files"]["manifest"]).is_file()
    assert Path(manifest["files"]["draft"]).name == "draft.md"
    for key in ("brief", "review", "repair", "polish", "delta", "write_result"):
        assert key in manifest["files"]

    assert manifest["agent_calls"]["context_agent"]["must_use_agent_tool"]
    assert (
        manifest["agent_calls"]["reviewer"]["subagent_type"]
        == "story-craft:reviewer"
    )
    assert "review.json 存在 blocking issue" in "\n".join(manifest["hard_rules"])
    assert "write" in manifest["cli_commands"]


def test_cli_agent_workflow_writes_manifest(tmp_path):
    project = create_planned_project(tmp_path)

    proc = run_cli(
        "--project-root",
        str(project),
        "agent",
        "workflow",
        "--chapter",
        "1",
    )

    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert Path(payload["files"]["manifest"]).is_file()
    manifest = json.loads(Path(payload["files"]["manifest"]).read_text(encoding="utf-8"))
    assert manifest["agent_calls"]["data_agent"]["subagent_type"] == "story-craft:data-agent"


def test_story_write_skill_requires_agent_tool_and_workflow_artifacts():
    skill = (REPO_ROOT / "story-craft/skills/story-write/SKILL.md").read_text(encoding="utf-8")

    assert "allowed-tools: Read Write Edit Grep Bash Agent" in skill
    assert "必须使用 `Agent` 工具调用指定 Agent" in skill
    assert ".story/workflows/ch_NN/" in skill
    assert "Agent(" in skill
    assert 'subagent_type: "story-craft:context-agent"' in skill
    assert 'subagent_type: "story-craft:reviewer"' in skill
    assert 'subagent_type: "story-craft:data-agent"' in skill
    assert "review.json 存在 blocking issue 时不得进入验收" in skill


def test_agents_accept_workflow_output_files_without_direct_state_writes():
    reviewer = (REPO_ROOT / "story-craft/agents/reviewer.md").read_text(encoding="utf-8")
    data_agent = (REPO_ROOT / "story-craft/agents/data-agent.md").read_text(encoding="utf-8")

    assert "output_file" in reviewer
    assert "tools: Read, Grep, Bash" in reviewer
    assert "output_file" in data_agent
    assert "tools: Read, Bash" in data_agent
    assert "不直接写 `.story/state.json`" in data_agent


def test_plugin_manifest_and_discovery_paths_are_documented():
    plugin_root = REPO_ROOT / "story-craft"
    plugin = json.loads((plugin_root / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
    development_doc = (REPO_ROOT / "docs/development.md").read_text(encoding="utf-8")

    assert plugin["name"] == "story-craft"
    assert (plugin_root / "skills").is_dir()
    assert (plugin_root / "agents").is_dir()
    assert "不写未确认 schema 的 `skills` / `agents` 路径字段" in development_doc
    assert "按目录自动发现 `story-craft/skills/` 和 `story-craft/agents/`" in development_doc


def test_skill_reference_tables_match_loading_map_and_files_exist():
    loading_map_refs = extract_loading_map_skill_refs()
    skill_names = {path.parent.name for path in SKILLS_DIR.glob("story-*/SKILL.md")}

    assert loading_map_refs.keys() == skill_names

    for skill_name, expected_refs in loading_map_refs.items():
        table_refs = extract_skill_reference_table_refs(skill_name)
        assert table_refs == expected_refs, skill_name
        for reference_path in table_refs:
            relative_path = reference_path.removeprefix("references/")
            assert (REFERENCES_DIR / relative_path).is_file(), reference_path


def test_short_track_skills_do_not_reference_long_material():
    loading_map_refs = extract_loading_map_skill_refs()

    for skill_name in SHORT_TRACK_SKILLS:
        table_refs = extract_skill_reference_table_refs(skill_name)
        assert not any(path.startswith("references/long/") for path in table_refs)
        assert not any(
            path.startswith("references/long/") for path in loading_map_refs[skill_name]
        )


def test_long_track_skills_have_embedded_fallback_quick_reference():
    for skill_name in LONG_TRACK_SKILLS:
        text = (SKILLS_DIR / skill_name / "SKILL.md").read_text(encoding="utf-8")

        assert "## Embedded Fallback 速查" in text
        assert "references 加载失败时不阻断" in text
        assert "rubric" in text
        assert "banned-words" in text

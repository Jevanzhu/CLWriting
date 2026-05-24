from __future__ import annotations

import json
from pathlib import Path

from conftest import create_planned_project, run_cli
from tools.agent_workflow import build_workflow_workspace


REPO_ROOT = Path(__file__).resolve().parents[3]


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

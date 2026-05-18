from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from tools.agent_workflow import build_workflow_workspace
from tools.init_project import init_project
from tools.outline_planner import plan_story


REPO_ROOT = SCRIPTS_DIR.parents[1]
SCRIPT = SCRIPTS_DIR / "story_craft.py"


def run_cli(*args: str, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def create_project(root: Path) -> Path:
    project = root / "demo"
    init_project(
        project,
        "暗室",
        "悬疑",
        word_count_target=30000,
        synopsis="法医收到亡友来信",
        protagonist_name="林墨",
        protagonist_desire="查清亡友死因",
        unique_advantage_desc="法医病理学",
        world_setting="近现代城市，证据必须可回溯",
    )
    plan_story(project, chapter_count=8)
    return project


class Phase18ReferenceAlignmentTests(unittest.TestCase):
    def test_workflow_workspace_manifest_matches_reference_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_project(Path(temp))

            manifest = build_workflow_workspace(project, 1)

            workflow_dir = Path(manifest["workflow_dir"])
            self.assertTrue(workflow_dir.is_dir())
            self.assertEqual(workflow_dir.name, "ch_01")
            self.assertTrue(Path(manifest["files"]["manifest"]).is_file())
            self.assertEqual(Path(manifest["files"]["draft"]).name, "draft.md")
            for key in ("brief", "review", "repair", "polish", "delta", "write_result"):
                self.assertIn(key, manifest["files"])

            self.assertTrue(manifest["agent_calls"]["context_agent"]["must_use_agent_tool"])
            self.assertEqual(
                manifest["agent_calls"]["reviewer"]["subagent_type"],
                "story-craft:reviewer",
            )
            self.assertIn("review.json 存在 blocking issue", "\n".join(manifest["hard_rules"]))
            self.assertIn("write", manifest["cli_commands"])

    def test_cli_agent_workflow_writes_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = create_project(Path(temp))

            proc = run_cli(
                "--project-root",
                str(project),
                "agent",
                "workflow",
                "--chapter",
                "1",
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertTrue(Path(payload["files"]["manifest"]).is_file())
            manifest = json.loads(Path(payload["files"]["manifest"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["agent_calls"]["data_agent"]["subagent_type"], "story-craft:data-agent")

    def test_story_write_skill_requires_agent_tool_and_workflow_artifacts(self) -> None:
        skill = (REPO_ROOT / "story-craft/skills/story-write/SKILL.md").read_text(encoding="utf-8")

        self.assertIn("allowed-tools: Read Write Edit Grep Bash Agent", skill)
        self.assertIn("必须使用 `Agent` 工具调用指定 Agent", skill)
        self.assertIn(".story/workflows/ch_NN/", skill)
        self.assertIn("Agent(", skill)
        self.assertIn("subagent_type: \"story-craft:context-agent\"", skill)
        self.assertIn("subagent_type: \"story-craft:reviewer\"", skill)
        self.assertIn("subagent_type: \"story-craft:data-agent\"", skill)
        self.assertIn("review.json 存在 blocking issue 时不得进入提交", skill)

    def test_agents_accept_workflow_output_files_without_direct_state_writes(self) -> None:
        reviewer = (REPO_ROOT / "story-craft/agents/reviewer.md").read_text(encoding="utf-8")
        data_agent = (REPO_ROOT / "story-craft/agents/data-agent.md").read_text(encoding="utf-8")

        self.assertIn("output_file", reviewer)
        self.assertIn("tools: Read, Grep, Bash", reviewer)
        self.assertIn("output_file", data_agent)
        self.assertIn("tools: Read, Bash", data_agent)
        self.assertIn("不直接写 `.story/state.json`", data_agent)


if __name__ == "__main__":
    unittest.main()

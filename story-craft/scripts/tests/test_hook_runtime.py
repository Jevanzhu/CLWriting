from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
HOOKS_DIR = (
    REPO_ROOT
    / "story-craft"
    / "skills"
    / "story-init"
    / "references"
    / "templates"
    / "hooks"
)
SETTINGS_HOOKS = HOOKS_DIR.parent / "settings-hooks.json"

EXPECTED_HOOK_FILES = {
    "session-start.sh",
    "session-end.sh",
    "pre-compact.sh",
    "post-compact.sh",
    "detect-story-gaps.sh",
    "validate-story-commit.sh",
    "lib/common.sh",
    "lib/sentinel.sh",
}


def test_hook_template_set_is_exact():
    actual = {
        str(path.relative_to(HOOKS_DIR))
        for path in HOOKS_DIR.rglob("*")
        if path.is_file()
    }

    assert actual == EXPECTED_HOOK_FILES


def test_settings_hook_timeouts_and_conditions_are_stable():
    settings = json.loads(SETTINGS_HOOKS.read_text(encoding="utf-8"))
    hooks = settings["hooks"]

    assert _timeouts_for_event(hooks, "SessionStart") == [10, 10, 10]
    assert _timeouts_for_event(hooks, "SessionEnd") == [5]
    assert _timeouts_for_event(hooks, "PreCompact") == [10]
    assert _timeouts_for_event(hooks, "PreToolUse") == [15]
    assert hooks["PreToolUse"][0]["matcher"] == "Bash"
    assert hooks["PreToolUse"][0]["hooks"][0]["if"] == "Bash(git commit*)"


def test_common_project_root_resolution_uses_nearest_story_state(tmp_path):
    project = tmp_path / "故事项目"
    child = project / "正文" / "卷一"
    (project / ".story").mkdir(parents=True)
    (project / ".story" / "state.json").write_text("{}", encoding="utf-8")
    child.mkdir(parents=True)

    result = _run_bash(
        f"source {HOOKS_DIR / 'lib' / 'common.sh'}; project_root",
        cwd=child,
        env={"CLAUDE_PROJECT_DIR": str(child)},
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(project)


def test_sentinel_reads_json_fields_and_handles_missing(tmp_path):
    deployment = tmp_path / "deployment.json"
    deployment.write_text(
        json.dumps(
            {
                "agents_version": 9,
                "project_type": "long",
                "active": True,
                "empty": None,
            }
        ),
        encoding="utf-8",
    )

    script = (
        f"source {HOOKS_DIR / 'lib' / 'sentinel.sh'}; "
        f"read_deployment_field agents_version {deployment}; "
        f"read_deployment_field project_type {deployment}; "
        f"read_deployment_field active {deployment}; "
        f"read_deployment_field missing {deployment}"
    )
    result = _run_bash(script, cwd=tmp_path)

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["9", "long", "true"]


def test_session_end_logs_only_when_enabled(tmp_path):
    project = tmp_path / "故事项目"
    (project / ".story").mkdir(parents=True)
    (project / ".story" / "state.json").write_text("{}", encoding="utf-8")
    (project / "追踪").mkdir()

    disabled = _run_hook("session-end.sh", project, env={"STORY_SESSION_LOG": "0"})
    assert disabled.returncode == 0, disabled.stderr
    assert not (project / "追踪" / "session-log.txt").exists()

    enabled = _run_hook("session-end.sh", project, env={"STORY_SESSION_LOG": "1"})
    assert enabled.returncode == 0, enabled.stderr
    assert "session ended" in (project / "追踪" / "session-log.txt").read_text(
        encoding="utf-8"
    )


def test_pre_and_post_compact_report_context_status(tmp_path):
    project = tmp_path / "故事项目"
    (project / ".story").mkdir(parents=True)
    (project / ".story" / "state.json").write_text("{}", encoding="utf-8")
    (project / "追踪").mkdir()
    (project / "追踪" / "上下文.md").write_text("一\n二\n", encoding="utf-8")

    pre = _run_hook("pre-compact.sh", project)
    post = _run_hook("post-compact.sh", project)

    assert pre.returncode == 0, pre.stderr
    assert "Writing context: 追踪/上下文.md (2 lines)" in pre.stdout
    assert "Git:" in pre.stdout
    assert post.returncode == 0, post.stderr
    assert "Read 追踪/上下文.md (2 lines)" in post.stdout


def _timeouts_for_event(hooks: dict, event_name: str) -> list[int]:
    return [
        hook["timeout"]
        for entry in hooks[event_name]
        for hook in entry.get("hooks", [])
    ]


def _run_hook(name: str, project: Path, env: dict[str, str] | None = None):
    return subprocess.run(
        ["bash", str(HOOKS_DIR / name)],
        cwd=project,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project), **(env or {})},
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )


def _run_bash(
    script: str,
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script],
        cwd=cwd,
        env={**os.environ, **(env or {})},
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )

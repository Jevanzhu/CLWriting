from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path

from cli.cli_args import build_parser
from core.event_projection_router import _WRITER_SPECS
from tools.scenario_router import (
    SCENARIO_DAILY_CONTINUE,
    SCENARIO_IMPORT_EXTERNAL,
    SCENARIO_MAJOR_REVISION,
    SCENARIO_NEW_VOLUME,
    SCENARIO_OPEN_BOOK,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_ROOT = REPO_ROOT / "story-craft"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "story-craft.yml"
PYPROJECT = REPO_ROOT / "pyproject.toml"
PLUGIN_MANIFEST = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"


def test_release_manifest_versions_are_bumped_and_aligned():
    pyproject = PYPROJECT.read_text(encoding="utf-8")
    plugin = json.loads(PLUGIN_MANIFEST.read_text(encoding="utf-8"))
    pyproject_version = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE)

    assert pyproject_version
    assert pyproject_version.group(1) == plugin["version"]
    assert plugin["version"] == "0.1.1"
    assert plugin["name"] == "story-craft"
    assert plugin["license"] == "GPL-3.0"


def test_release_asset_counts_match_phase_five_dod():
    assert len(list((PLUGIN_ROOT / "skills").glob("story-*/SKILL.md"))) == 17
    assert len(list((PLUGIN_ROOT / "commands").glob("*.md"))) == 13
    assert len(list((PLUGIN_ROOT / "agents").glob("*.md"))) == 9
    assert len(list(_hook_script_files())) == 6
    assert len(_root_commands()) == 20
    assert len(_WRITER_SPECS) == 6
    assert {
        SCENARIO_DAILY_CONTINUE,
        SCENARIO_IMPORT_EXTERNAL,
        SCENARIO_MAJOR_REVISION,
        SCENARIO_NEW_VOLUME,
        SCENARIO_OPEN_BOOK,
    } == {
        "daily_continue",
        "import_external",
        "major_revision",
        "new_volume",
        "open_book",
    }


def test_ci_workflow_runs_compile_pytest_and_cli_e2e_without_extras():
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "python3 -m compileall -q story-craft/scripts" in text
    assert "python3 -m pip install pytest" in text
    assert "python3 -m pytest story-craft/scripts/tests/ -q" in text
    assert "python3 -B story-craft/scripts/ci_e2e_smoke.py" in text
    assert "STORYCRAFT_ENABLE_EMBEDDING: \"0\"" in text
    assert "[rag]" not in text
    assert "[locking]" not in text
    assert "pip install -e" not in text


def test_ci_e2e_smoke_script_covers_required_cli_chain_and_projection_assertions():
    script = PLUGIN_ROOT / "scripts" / "ci_e2e_smoke.py"
    text = script.read_text(encoding="utf-8")
    calls = _run_cli_literal_calls(script)

    assert ("init",) in calls
    assert ("plan",) in calls
    assert ("agent", "workflow") in calls
    assert ("agent", "brief") in calls
    assert ("agent", "extract") in calls
    assert ("write",) in calls
    assert ("review",) in calls
    assert ("chapter-commit",) in calls
    assert ("rebuild-views",) in calls

    for projection in ("state", "memory", "summary", "index", "vector", "markdown_view"):
        assert f'"{projection}"' in text
    assert "embedding unavailable" in text
    assert "for chapter in (1, 2)" in text
    assert "chapter_{chapter:03d}.commit.json" in text


def _root_commands() -> set[str]:
    parser = build_parser()
    subparsers = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]
    return set(subparsers[0].choices)


def _hook_script_files() -> list[Path]:
    hooks_dir = (
        PLUGIN_ROOT
        / "skills"
        / "story-init"
        / "references"
        / "templates"
        / "hooks"
    )
    return sorted(path for path in hooks_dir.glob("*.sh") if path.is_file())


def _run_cli_literal_calls(path: Path) -> set[tuple[str, ...]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    calls: set[tuple[str, ...]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "run_cli":
            continue
        literals = [
            arg.value
            for arg in node.args
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
        ]
        commands = [
            item
            for item in literals
            if item
            and not item.startswith("-")
            and item not in {"1", "2", "10000", "CI冒烟故事", "悬疑"}
        ]
        calls.add(tuple(commands[:2] if commands[:1] == ["agent"] else commands[:1]))
    return calls

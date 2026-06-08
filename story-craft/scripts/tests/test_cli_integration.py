from __future__ import annotations

import argparse
import json
from pathlib import Path

from conftest import reviewer_issue, run_cli
from cli.cli_args import build_parser
from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.state_manager import StateManager


def _root_commands() -> set[str]:
    parser = build_parser()
    actions = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]
    return set(actions[0].choices)


def test_cli_help_lists_twenty_root_commands():
    expected = {
        "where",
        "preflight",
        "use",
        "init",
        "plan",
        "write",
        "agent",
        "review",
        "rebuild-views",
        "learn",
        "query",
        "index",
        "backup",
        "health",
        "outline-revision",
        "chapter-commit",
        "deslop",
        "repair",
        "placeholder-scan",
        "import",
    }

    assert _root_commands() == expected

    help_result = run_cli("--help")
    assert help_result.returncode == 0, help_result.stderr
    help_text = help_result.stdout
    for command in expected:
        assert command in help_text
    assert "maintain" not in help_text


def test_cli_init_preflight_query_learn_and_review_chain(tmp_path):
    project = tmp_path / "集成故事"

    init = run_cli(
        "init",
        str(project),
        "集成故事",
        "悬疑",
        "--project-type",
        "long",
        "--word-count-target",
        "30000",
        "--synopsis",
        "法医收到亡友来信",
        "--protagonist-name",
        "林墨",
        "--protagonist-desire",
        "查清真相",
        "--protagonist-flaw",
        "过度依赖证据",
        "--unique-advantage-type",
        "特殊知识",
        "--unique-advantage-desc",
        "法医病理学",
        "--unique-advantage-style",
        "克制",
        "--unique-advantage-visibility",
        "少数同事知道",
        "--unique-advantage-cost",
        "容易忽视情绪证词",
        "--antagonist-mirror",
        "反派同样追求完整真相",
        "--world-setting",
        "近现代城市",
    )
    assert init.returncode == 0, init.stderr
    init_payload = json.loads(init.stdout)
    assert Path(init_payload["state_file"]).is_file()
    assert StoryCraftConfig.from_project_root(project).project_type() == "long"

    preflight = run_cli("--project-root", str(project), "preflight", "--format", "json")
    assert preflight.returncode == 0, preflight.stderr
    preflight_payload = json.loads(preflight.stdout)
    assert preflight_payload["ok"]
    assert preflight_payload["project_exists"]

    memory = run_cli("--project-root", str(project), "query", "memory")
    assert memory.returncode == 0, memory.stderr
    memory_payload = json.loads(memory.stdout)
    assert memory_payload["characters"][0]["name"] == "林墨"

    genres = run_cli("--project-root", str(project), "query", "genres")
    assert genres.returncode == 0, genres.stderr
    assert "悬疑灵异" in json.loads(genres.stdout)["genres"]

    learn = run_cli(
        "--project-root",
        str(project),
        "learn",
        "--chapter",
        "1",
        "--pattern-type",
        "hook",
        "--description",
        "开篇慢",
        "--instruction",
        "前300字给异常",
    )
    assert learn.returncode == 0, learn.stderr
    assert json.loads(learn.stdout)["id"] == "pat_001"

    learning = run_cli(
        "--project-root",
        str(project),
        "query",
        "learning",
        "--pattern-type",
        "hook",
    )
    assert learning.returncode == 0, learning.stderr
    assert json.loads(learning.stdout)["patterns"][0]["pattern_type"] == "hook"

    review_results = tmp_path / "review.json"
    chapter_file = tmp_path / "chapter.md"
    report_file = project / "审查报告" / "第01章审查报告.md"
    review_results.write_text(
        json.dumps(
            {
                "issues": [
                    reviewer_issue(
                        severity="critical",
                        category="continuity",
                        location="第1段",
                        description="主角动机断裂",
                        evidence="主角突然放弃查清真相",
                        fix_hint="补足动机转折",
                        blocking=True,
                    )
                ],
                "summary": "存在阻断问题。",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    chapter_file.write_text("林墨站在雨里。", encoding="utf-8")
    review = run_cli(
        "--project-root",
        str(project),
        "review",
        "--chapter",
        "1",
        "--review-results",
        str(review_results),
        "--chapter-file",
        str(chapter_file),
        "--report-file",
        str(report_file),
    )
    assert review.returncode == 0, review.stderr
    assert "主角动机断裂" in report_file.read_text(encoding="utf-8")


def test_cli_init_project_type_and_from_config(tmp_path):
    config_file = tmp_path / "init-config.json"
    project = tmp_path / "配置故事"
    config_file.write_text(
        json.dumps(
            {
                "project_path": str(project),
                "title": "配置故事",
                "genre": "现实题材",
                "project_type": "long",
                "word_count_target": 90000,
                "synopsis": "记者追踪旧案。",
                "protagonist": {
                    "name": "周岚",
                    "desire": "查清真相",
                    "flaw": "过度自责",
                },
                "unique_advantage": {
                    "type": "职业能力",
                    "description": "调查报道经验",
                    "style": "交叉验证",
                    "visibility": "业内知名",
                    "cost": "树敌过多",
                },
                "world_setting": "近现代城市。",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    init = run_cli(
        "init",
        "--from-config",
        str(config_file),
        "--protagonist-name",
        "林墨",
    )
    assert init.returncode == 0, init.stderr
    payload = json.loads(init.stdout)

    config = StoryCraftConfig.from_project_root(project)
    master = json.loads(config.contracts_dir.joinpath("master.json").read_text(encoding="utf-8"))
    memory = json.loads(config.memory_file.read_text(encoding="utf-8"))
    state = json.loads(config.state_file.read_text(encoding="utf-8"))

    assert payload["master_file"] == str(config.contracts_dir / "master.json")
    assert config.project_type() == "long"
    assert master["project_type"] == "long"
    assert master["title"] == "配置故事"
    assert master["protagonist"]["name"] == "林墨"
    assert memory["characters"][0]["name"] == "林墨"
    assert state["project"]["word_count_target"] == 90000


def test_cli_stage_three_skeletons_and_placeholder_scan(tmp_path):
    draft = tmp_path / "draft.md"
    draft.write_text("正文\n[TODO:补线索]\n{待定结尾}\n", encoding="utf-8")

    scan = run_cli("placeholder-scan", str(draft))
    assert scan.returncode == 0, scan.stderr
    scan_payload = json.loads(scan.stdout)
    assert scan_payload["ok"]
    assert scan_payload["placeholder_count"] == 2

    for command in ("deslop", "repair", "import"):
        result = run_cli(command)
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["ok"]
        assert payload["command"] == command
        assert payload["status"] == "pending_phase_3"


def test_cli_write_requires_chapter_argument():
    write = run_cli("write")

    assert write.returncode == 2
    assert "--chapter" in write.stderr


def test_cli_rebuild_views_replays_commits_and_supports_only(tmp_path):
    project = tmp_path / "重建故事"
    init = run_cli("init", str(project), "重建故事", "悬疑", "--protagonist-name", "林墨")
    assert init.returncode == 0, init.stderr

    config = StoryCraftConfig.from_project_root(project)
    CommitStore(config).write(
        {
            "chapter": 1,
            "title": "开局",
            "status": "accepted",
            "word_count": 1800,
            "summary_text": "林墨收到亡友来信。",
            "chapter_summary": {
                "chapter": 1,
                "title": "开局",
                "summary": "林墨收到亡友来信。",
            },
            "accepted_events": [
                {
                    "event_type": "summary_recorded",
                    "payload": {
                        "chapter": 1,
                        "title": "开局",
                        "summary": "林墨收到亡友来信。",
                    },
                    "chapter": 1,
                }
            ],
            "dominant_strand": "quest",
        }
    )
    StateManager(config).update_progress(chapter=9, words_delta=9999, phase="broken")
    StateManager(config).flush()

    rebuilt = run_cli("--project-root", str(project), "rebuild-views")
    assert rebuilt.returncode == 0, rebuilt.stderr
    payload = json.loads(rebuilt.stdout)

    assert payload["ok"]
    assert set(payload["results"]) == {
        "state",
        "memory",
        "summary",
        "index",
        "vector",
        "markdown_view",
    }
    assert payload["results"]["state"]["detail"] == "replayed 1 accepted commits"
    assert payload["results"]["index"]["skipped"]
    assert StateManager(config).get_progress()["total_words"] == 1800
    assert "林墨收到亡友来信" in (
        config.summaries_dir / "ch0001.md"
    ).read_text(encoding="utf-8")

    selected = run_cli("--project-root", str(project), "rebuild-views", "--only", "summary")
    assert selected.returncode == 0, selected.stderr
    assert list(json.loads(selected.stdout)["results"]) == ["summary"]

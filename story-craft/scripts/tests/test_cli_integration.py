from __future__ import annotations

import json
from pathlib import Path

from conftest import reviewer_issue, run_cli
from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.state_manager import StateManager


def test_cli_init_preflight_query_learn_and_review_chain(tmp_path):
    project = tmp_path / "集成故事"

    init = run_cli(
        "init",
        str(project),
        "集成故事",
        "悬疑",
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

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from conftest import reviewer_issue, run_cli
from core.config import StoryCraftConfig
from core.chapter_record import ChapterRecordService
from core.memory_index import MemoryIndexService
from core.memory_manager import MemoryManager
from tools.backup_manager import BackupManager
from tools.context_ranker import rank_context_items
from tools.entity_linker import build_entity_graph
from tools.agent_workflow import normalize_reviewer_output
from tools.init_project import init_project
from tools.outline_reviser import OutlineReviser
from tools.quality_trend_report import QualityTrendReporter
from tools.status_reporter import StatusReporter
from tools.story_runtime_health import StoryRuntimeHealth


def seed_medium_project(project: Path) -> StoryCraftConfig:
    init_project(
        project,
        "长夜档案",
        "悬疑",
        word_count_target=90000,
        protagonist_name="林墨",
    )
    config = StoryCraftConfig.from_project_root(project)
    memory = MemoryManager(config)
    memory.apply_chapter_delta(
        {
            "chapter": 1,
            "entities_new": [
                {
                    "id": "char_su",
                    "name": "苏晚",
                    "role": "ally",
                    "tier": "核心",
                    "relationships": [
                        {
                            "target_id": "char_protagonist",
                            "type": "互相试探",
                            "description": "共享线索但互不完全信任",
                        }
                    ],
                }
            ],
            "entities_appeared": ["char_protagonist", "char_su"],
            "new_foreshadowing": [
                {
                    "id": "fh_001",
                    "content": "天台纸条写着周三",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                },
                {
                    "id": "fh_002",
                    "content": "尸检报告缺失一页",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 1,
                },
                {
                    "id": "fh_003",
                    "content": "苏晚隐瞒电话来源",
                    "status": "open",
                    "urgency": "high",
                    "planted_chapter": 2,
                },
            ],
            "new_world_rules": [{"id": "wr_001", "rule": "证据必须可回溯"}],
            "timeline_entry": {
                "chapter": 1,
                "time_marker": "周三傍晚",
                "location": "天台",
                "events": ["发现纸条"],
            },
            "chapter_summary": {
                "chapter": 1,
                "title": "天台纸条",
                "summary": "林墨发现第一条反常证据",
                "word_count": 2600,
            },
        }
    )
    memory.flush()
    service = ChapterRecordService(config)
    service.record(
        1,
        "天台纸条",
        2600,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        category="pacing",
                        description="开头稍慢",
                        evidence="首段解释偏多",
                        fix_hint="提前放入行动或异常",
                    )
                ],
                "summary": "可验收。",
            }
        ),
        {"chapter_summary": {"chapter": 1, "title": "天台纸条", "summary": "林墨发现纸条"}},
    )
    service.record(
        2,
        "缺页报告",
        2400,
        normalize_reviewer_output(
            {
                "issues": [
                    reviewer_issue(
                        category="continuity",
                        description="报告来源需明确",
                        evidence="正文只出现报告结论",
                        fix_hint="补充报告取得过程",
                    )
                ],
                "summary": "可验收。",
            }
        ),
        {
            "entities_appeared": ["char_protagonist", "char_su"],
            "chapter_summary": {"chapter": 2, "title": "缺页报告", "summary": "尸检报告缺页"},
            "timeline_entry": {"chapter": 2, "time_marker": "周四", "events": ["追查报告"]},
        },
    )
    return config


def test_memory_index_backup_status_and_health_services(tmp_path):
    config = seed_medium_project(tmp_path / "medium")

    index = MemoryIndexService(config).rebuild()
    assert Path(index["db_file"]).is_file()
    assert index["entry_count"] >= 7
    assert MemoryManager(config).use_sqlite

    matches = MemoryIndexService(config).query(text="纸条", limit=5)
    assert any(item["kind"] == "foreshadowing" for item in matches)

    backup = BackupManager(config).create_backup("阶段备份")
    backup_file = Path(str(backup["backup_file"]))
    assert backup_file.is_file()
    with zipfile.ZipFile(backup_file) as archive:
        assert ".story/state.json" in archive.namelist()

    status = StatusReporter(config).build()
    assert status["medium_mode"]["enabled"]
    assert status["progress"]["total_words"] > 0
    assert status["memory_counts"]["open_foreshadowing"] >= 3

    health = StoryRuntimeHealth(config).check()
    assert health["ok"]
    assert any("伏笔债" in item for item in health["warnings"])
    assert "runtime" in health
    assert "filelock_available" in health["runtime"]


def test_quality_ranker_entity_graph_and_outline_revision(tmp_path):
    config = seed_medium_project(tmp_path / "medium")
    memory = MemoryManager(config).load()

    quality = QualityTrendReporter(config).build()
    assert quality["chapter_count"] == 2
    assert quality["warning_categories"]["pacing"] == 1
    assert quality["warning_categories"]["continuity"] == 1

    ranked = rank_context_items(memory, chapter=3, budget=3)
    assert len(ranked["selected"]) == 3
    assert ranked["selected"][0]["kind"] == "foreshadowing"
    assert ranked["omitted_count"] > 0

    graph = build_entity_graph(memory)
    assert graph["node_count"] >= 2
    assert graph["orphan_edges"] == []

    revision = OutlineReviser(config).suggest(2, "中点前核对主线")
    revision_file = Path(str(revision["revision_file"]))
    assert revision_file.is_file()
    assert "中点前核对主线" in revision_file.read_text(encoding="utf-8")


def test_medium_cli_commands(tmp_path):
    seed_medium_project(tmp_path / "medium")

    index = run_cli("--project-root", str(tmp_path / "medium"), "index")
    assert index.returncode == 0, index.stderr
    assert json.loads(index.stdout)["entry_count"] > 0

    status = run_cli("--project-root", str(tmp_path / "medium"), "query", "status")
    assert status.returncode == 0, status.stderr
    assert json.loads(status.stdout)["medium_mode"]["enabled"]

    ranked = run_cli(
        "--project-root",
        str(tmp_path / "medium"),
        "query",
        "ranked-context",
        "--chapter",
        "3",
        "--budget",
        "2",
    )
    assert ranked.returncode == 0, ranked.stderr
    assert len(json.loads(ranked.stdout)["selected"]) == 2

    backup = run_cli(
        "--project-root",
        str(tmp_path / "medium"),
        "backup",
        "--label",
        "cli",
    )
    assert backup.returncode == 0, backup.stderr
    assert Path(json.loads(backup.stdout)["backup_file"]).is_file()

    health = run_cli("--project-root", str(tmp_path / "medium"), "health")
    assert health.returncode == 0, health.stderr
    health_payload = json.loads(health.stdout)
    assert health_payload["ok"]
    assert "runtime" in health_payload

    revision = run_cli(
        "--project-root",
        str(tmp_path / "medium"),
        "outline-revision",
        "--chapter",
        "2",
        "--note",
        "CLI 核对",
    )
    assert revision.returncode == 0, revision.stderr
    assert Path(json.loads(revision.stdout)["revision_file"]).is_file()

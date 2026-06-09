from __future__ import annotations

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.contract_store import ContractStore
from tools.scenario_router import detect_scenario


def test_detect_scenario_routes_open_book_without_master(tmp_path):
    result = detect_scenario(tmp_path, user_input="继续写")

    assert result["scenario"] == "open_book"
    assert result["signals"]["has_master"] is False
    assert result["signals"]["daily_ready"] is False
    assert "开书" in result["reasoning"]


def test_detect_scenario_missing_master_does_not_route_import(tmp_path):
    chapter_dir = tmp_path / "正文"
    chapter_dir.mkdir(parents=True)
    (chapter_dir / "第01章.md").write_text("旧稿", encoding="utf-8")

    result = detect_scenario(tmp_path, user_input="导入既有作品")

    assert result["scenario"] == "open_book"
    assert result["signals"]["has_master"] is False
    assert result["signals"]["keywords"]["import_external"] is True


def test_detect_scenario_routes_daily_when_project_has_content_and_tracking(tmp_path):
    config = _project(tmp_path, project_type="long")
    _write_commit(config, 1)
    config.tracking_dir.mkdir(parents=True)

    result = detect_scenario(tmp_path, user_input="继续写下一章")

    assert result["scenario"] == "daily_continue"
    assert result["signals"]["daily_ready"] is True
    assert result["signals"]["commit_count"] == 1
    assert result["signals"]["tracking_exists"] is True


def test_detect_scenario_routes_major_revision_by_priority(tmp_path):
    config = _project(tmp_path, project_type="long")
    _write_commit(config, 1)
    config.tracking_dir.mkdir(parents=True)

    result = detect_scenario(tmp_path, user_input="请重写并开新卷")

    assert result["scenario"] == "major_revision"
    assert result["signals"]["keywords"]["major_revision"] is True
    assert result["signals"]["keywords"]["new_volume"] is True


def test_detect_scenario_daily_has_highest_priority_when_ready(tmp_path):
    config = _project(tmp_path, project_type="long")
    _write_commit(config, 1)
    config.tracking_dir.mkdir(parents=True)

    result = detect_scenario(tmp_path, user_input="继续写，但重写第二章")

    assert result["scenario"] == "daily_continue"
    assert result["signals"]["keywords"]["daily"] is True
    assert result["signals"]["keywords"]["major_revision"] is True


def test_detect_scenario_routes_new_volume_for_long_project(tmp_path):
    config = _project(tmp_path, project_type="long")
    store = ContractStore(config)
    store.write_volume(
        {
            "contract_version": "v1",
            "volume": 1,
            "title": "第一卷",
            "chapter_range": [1, 2],
        }
    )
    _write_commit(config, 1)
    _write_commit(config, 2)

    result = detect_scenario(tmp_path, user_input="")

    assert result["scenario"] == "new_volume"
    assert result["signals"]["latest_volume_completed"] is True


def test_detect_scenario_short_project_does_not_route_new_volume(tmp_path):
    config = _project(tmp_path, project_type="short")
    _write_commit(config, 1)
    config.tracking_dir.mkdir(parents=True)

    result = detect_scenario(tmp_path, user_input="开新卷")

    assert result["scenario"] == "daily_continue"
    assert result["signals"]["project_type"] == "short"
    assert result["signals"]["keywords"]["new_volume"] is True


def test_detect_scenario_routes_import_for_empty_project_with_master(tmp_path):
    _project(tmp_path, project_type="long")

    result = detect_scenario(tmp_path, user_input="导入外部作品")

    assert result["scenario"] == "import_external"
    assert result["signals"]["has_master"] is True
    assert result["signals"]["chapter_file_count"] == 0
    assert result["signals"]["commit_count"] == 0
    assert result["signals"]["keywords"]["import_external"] is True


def test_detect_scenario_empty_project_with_master_still_routes_open_book(tmp_path):
    _project(tmp_path, project_type="long")

    result = detect_scenario(tmp_path, user_input="我要开始一个新故事")

    assert result["scenario"] == "open_book"
    assert result["signals"]["has_master"] is True
    assert result["signals"]["chapter_file_count"] == 0
    assert result["signals"]["commit_count"] == 0
    assert result["signals"]["keywords"]["import_external"] is False


def test_detect_scenario_routes_import_for_existing_project(tmp_path):
    _project(tmp_path, project_type="long")
    chapter_dir = tmp_path / "正文"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    (chapter_dir / "第01章.md").write_text("旧稿", encoding="utf-8")

    result = detect_scenario(tmp_path, user_input="导入既有作品")

    assert result["scenario"] == "import_external"
    assert result["signals"]["chapter_file_count"] == 1
    assert result["signals"]["keywords"]["import_external"] is True


def test_detect_scenario_is_read_only(tmp_path):
    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))

    detect_scenario(tmp_path, user_input="导入")

    after = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))
    assert after == before


def _project(tmp_path, *, project_type: str) -> StoryCraftConfig:
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    ContractStore(config).write_master(
        {
            "contract_version": "v1",
            "project_type": project_type,
            "title": "长夜",
            "genre": "悬疑",
        }
    )
    return config


def _write_commit(config: StoryCraftConfig, chapter: int) -> None:
    CommitStore(config).write(
        {
            "chapter": chapter,
            "title": f"第{chapter}章",
            "status": "accepted",
            "word_count": 2000,
            "summary_text": f"第{chapter}章摘要",
        }
    )

from __future__ import annotations

from core.chapter_paths import (
    commit_file_name,
    find_commit_file,
    iter_commit_files,
    summary_file_name,
    view_chapter_dir_name,
)
from core.config import StoryCraftConfig
from core.security_utils import atomic_write_json


def test_refactor_config_paths_and_lazy_artifacts(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)

    assert config.contracts_dir == tmp_path / ".story" / "contracts"
    assert config.volumes_dir == tmp_path / ".story" / "contracts" / "volumes"
    assert config.chapter_contracts_dir == tmp_path / ".story" / "contracts" / "chapters"
    assert config.review_contracts_dir == tmp_path / ".story" / "contracts" / "reviews"
    assert config.style_fingerprint_file == (
        tmp_path / ".story" / "contracts" / "style_fingerprint.yaml"
    )
    assert config.anti_patterns_file == tmp_path / ".story" / "contracts" / "anti_patterns.json"
    assert config.deployment_file == tmp_path / ".story" / "contracts" / "deployment.json"
    assert config.commits_dir == tmp_path / ".story" / "commits"
    assert config.summaries_dir == tmp_path / ".story" / "summaries"
    assert config.index_db == tmp_path / ".story" / "index.db"
    assert config.vector_db == tmp_path / ".story" / "vector.db"
    assert config.workflows_dir == tmp_path / ".story" / "workflows"
    assert config.tracking_dir == tmp_path / "追踪"
    assert config.settings_view_dir == tmp_path / "设定"

    config.ensure_dirs()

    assert config.contracts_dir.is_dir()
    assert config.volumes_dir.is_dir()
    assert config.chapter_contracts_dir.is_dir()
    assert config.review_contracts_dir.is_dir()
    assert config.commits_dir.is_dir()
    assert config.summaries_dir.is_dir()
    assert config.chapters_dir.is_dir()
    assert config.settings_dir.is_dir()
    assert not config.index_db.exists()
    assert not config.vector_db.exists()
    assert not config.tracking_dir.exists()
    assert not config.settings_view_dir.exists()


def test_project_type_prefers_master_contract_then_legacy_state(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()

    assert config.project_type() == "short"

    atomic_write_json(
        config.state_file,
        {"project": {"tier": "medium"}},
        use_lock=False,
        backup=False,
    )
    assert config.project_type() == "long"

    atomic_write_json(
        config.contracts_dir / "master.json",
        {"project_type": "short"},
        use_lock=False,
        backup=False,
    )
    assert config.project_type() == "short"

    atomic_write_json(
        config.contracts_dir / "master.json",
        {"project_type": "long"},
        use_lock=False,
        backup=False,
    )
    assert config.project_type() == "long"


def test_refactor_chapter_path_primitives_and_commit_lookup(tmp_path):
    config = StoryCraftConfig.from_project_root(tmp_path)
    config.ensure_dirs()

    assert commit_file_name(1) == "chapter_001.commit.json"
    assert summary_file_name(12) == "ch0012.md"
    assert view_chapter_dir_name(7) == "第007章"

    chapter_three = config.commits_dir / commit_file_name(3)
    chapter_one = config.commits_dir / commit_file_name(1)
    atomic_write_json(chapter_three, {"chapter": 3}, use_lock=False, backup=False)
    atomic_write_json(chapter_one, {"chapter": 1}, use_lock=False, backup=False)

    assert find_commit_file(1, config=config) == chapter_one
    assert iter_commit_files(config=config) == [chapter_one, chapter_three]

from __future__ import annotations

from core.contract_store import ContractStore


def test_contract_store_returns_empty_or_none_for_missing_contracts(tmp_path):
    store = ContractStore.from_project(tmp_path)

    assert store.read_master() is None
    assert store.read_volume(1) is None
    assert store.read_chapter(1) is None
    assert store.read_review(1) is None
    assert store.read_style_fingerprint() == {}
    assert store.read_anti_patterns() == {}
    assert store.read_deployment() == {}
    assert store.iter_volumes() == []


def test_contract_store_round_trips_json_contracts(tmp_path):
    store = ContractStore.from_project(tmp_path)

    master = {
        "contract_version": "v1",
        "project_type": "long",
        "title": "长夜",
        "genre": "现实题材",
        "route": "daily",
        "reasoning": "长线追踪",
    }
    volume_two = {
        "contract_version": "v1",
        "volume": 2,
        "title": "第二卷",
        "chapter_range": [11, 20],
        "must_cover": ["反转"],
    }
    volume_one = {
        "contract_version": "v1",
        "volume": 1,
        "title": "第一卷",
        "chapter_range": [1, 10],
        "must_cover": ["开局"],
    }
    chapter = {
        "contract_version": "v1",
        "chapter": 7,
        "title": "雨夜",
        "planned_word_count": 3200,
        "expected_strand": "quest",
        "forbidden_zones": ["提前揭底"],
    }
    review = {
        "contract_version": "v1",
        "chapter": 7,
        "mode": "full",
        "rubric_source": "genre",
        "strand_check": True,
        "quant_thresholds": {"logic": 80},
    }

    assert store.write_master(master).name == "master.json"
    assert store.write_volume(volume_two).name == "volume_002.json"
    assert store.write_volume(volume_one).name == "volume_001.json"
    assert store.write_chapter(chapter).name == "chapter_007.json"
    assert store.write_review(review).name == "chapter_007.review.json"

    assert store.read_master() == master
    assert store.read_volume(1) == volume_one
    assert store.read_volume(2) == volume_two
    assert store.iter_volumes() == [volume_one, volume_two]
    assert store.read_chapter(7) == chapter
    assert store.read_review(7) == review


def test_contract_store_round_trips_yaml_and_sentinel_files(tmp_path):
    store = ContractStore.from_project(tmp_path)

    style = {
        "cadence": "short",
        "lexicon": ["冷雨", "霓虹"],
        "tone": {"density": 0.8, "texture": "noir"},
    }
    anti_patterns = {
        "rules": ["不要总结式结尾", "不要解释设定"],
        "updated_by": "reviewer",
    }
    deployment = {
        "agents_version": "1.0.0",
        "skill_version": "1.0.0",
        "target_cli": "claude-code",
        "project_type": "long",
    }

    assert store.write_style_fingerprint(style).name == "style_fingerprint.yaml"
    assert store.write_anti_patterns(anti_patterns).name == "anti_patterns.json"
    assert store.write_deployment(deployment).name == "deployment.json"

    assert store.read_style_fingerprint() == style
    assert store.read_anti_patterns() == anti_patterns
    assert store.read_deployment() == deployment

    style_text = store.config.style_fingerprint_file.read_text(encoding="utf-8")
    assert "tone:" in style_text
    assert "density:" in style_text

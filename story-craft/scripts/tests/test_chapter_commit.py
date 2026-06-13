from __future__ import annotations

from core.chapter_commit_builder import (
    COMMIT_VERSION,
    build_chapter_commit,
    compute_dominant_strand,
    compute_strand_distribution,
    delta_to_events,
    derive_entity_deltas,
    derive_state_deltas,
)
from core.commit_store import CommitStore


def _review_result(blocking: bool = False):
    issue = {
        "severity": "critical" if blocking else "low",
        "category": "logic",
        "location": "全文",
        "description": "测试问题",
        "evidence": "测试证据",
        "fix_hint": "测试修复",
        "blocking": blocking,
    }
    return {
        "passed": not blocking,
        "issues": [issue],
        "blockers": [issue] if blocking else [],
        "warnings": [] if blocking else [issue],
        "summary": "审查摘要",
        "meta": {"source": "agent", "effective_mode": "lean"},
    }


def _legacy_delta():
    return {
        "chapter": 2,
        "entities_new": [
            {
                "suggested_id": "char_su",
                "name": "苏晚",
                "entity_type": "角色",
                "role": "ally",
                "tier": "核心",
            }
        ],
        "entities_appeared": ["char_lin"],
        "state_changes": [
            {
                "entity_id": "char_lin",
                "entity_type": "角色",
                "field": "current_status",
                "old": "调查中",
                "new": "发现纸条",
            }
        ],
        "new_foreshadowing": [{"id": "fh_2", "content": "旧楼灯光"}],
        "resolved_foreshadowing": [{"id": "fh_1", "resolution": "找到信源"}],
        "new_world_rules": [{"id": "wr_1", "rule": "证据必须可回溯"}],
        "timeline_entry": {"chapter": 2, "events": ["进入旧楼"]},
        "chapter_summary": {
            "chapter": 2,
            "title": "旧楼",
            "summary": "林墨进入旧楼",
            "word_count": 2100,
        },
        "scenes": [{"summary": "旧楼调查", "strand": "quest"}],
        "agent_calls": {"data": "agent"},
    }


def test_delta_to_events_covers_legacy_event_fields():
    events = delta_to_events(_legacy_delta())
    event_types = [event["event_type"] for event in events]

    assert event_types == [
        "entity_introduced",
        "entity_appeared",
        "state_changed",
        "open_loop_created",
        "open_loop_closed",
        "rule_revealed",
        "timeline_advanced",
        "summary_recorded",
    ]
    assert events[0]["entity_id"] == "char_su"
    assert events[0]["payload"]["suggested_id"] == "char_su"
    assert events[1]["entity_id"] == "char_lin"
    assert events[2]["field"] == "current_status"
    assert events[3]["payload"]["id"] == "fh_2"
    assert events[4]["payload"]["id"] == "fh_1"
    assert events[5]["payload"]["id"] == "wr_1"
    assert events[6]["payload"]["events"] == ["进入旧楼"]
    assert events[7]["payload"]["summary"] == "林墨进入旧楼"


def test_delta_to_events_backfills_timeline_events_for_agent_delta():
    """data-agent 直接提供 accepted_events 时，若 timeline_advanced 的 payload 未带 events、
    而 timeline_entry 顶层有因果事件，应回填 payload.events，避免时间线投影渲染成「未记录」。
    """
    delta = {
        "chapter": 1,
        "accepted_events": [
            {
                "event_type": "timeline_advanced",
                "payload": {"time_marker": "台风夜", "note": "无 events 字段"},
                "chapter": 1,
            }
        ],
        "timeline_entry": {"chapter": 1, "events": ["收到匿名邮包", "第九张照片现死者活影"]},
    }

    events = delta_to_events(delta)
    advanced = [event for event in events if event["event_type"] == "timeline_advanced"]

    assert len(advanced) == 1
    assert advanced[0]["payload"]["events"] == ["收到匿名邮包", "第九张照片现死者活影"]


def test_delta_to_events_synthesizes_timeline_advanced_when_agent_omits_it():
    """accepted_events 未含 timeline_advanced，但 timeline_entry 有因果事件时，
    从 timeline_entry 合成一个带 events 的 timeline_advanced，保证时间线投影可渲染。"""
    delta = {
        "chapter": 1,
        "accepted_events": [
            {
                "event_type": "entity_introduced",
                "entity_id": "char_zhou",
                "entity_type": "角色",
                "payload": {"id": "char_zhou", "name": "周慎"},
                "chapter": 1,
            }
        ],
        "timeline_entry": {"chapter": 1, "events": ["台风夜收到旧案邮包"]},
    }

    events = delta_to_events(delta)
    advanced = [event for event in events if event["event_type"] == "timeline_advanced"]

    assert len(advanced) == 1
    assert advanced[0]["payload"]["events"] == ["台风夜收到旧案邮包"]


def test_delta_to_events_keeps_existing_timeline_payload_events():
    """timeline_advanced 已自带 events 时，不被 timeline_entry 覆盖。"""
    delta = {
        "chapter": 1,
        "accepted_events": [
            {
                "event_type": "timeline_advanced",
                "payload": {"events": ["事件A", "事件B"]},
                "chapter": 1,
            }
        ],
        "timeline_entry": {"chapter": 1, "events": ["不应覆盖"]},
    }

    events = delta_to_events(delta)
    advanced = [event for event in events if event["event_type"] == "timeline_advanced"]

    assert advanced[0]["payload"]["events"] == ["事件A", "事件B"]


def test_build_chapter_commit_derives_projection_triggers():
    commit = build_chapter_commit(
        chapter=2,
        title="旧楼",
        word_count=2100,
        review_result=_review_result(),
        extraction_delta=_legacy_delta(),
    )

    assert commit["commit_version"] == COMMIT_VERSION
    assert commit["status"] == "accepted"
    assert commit["review_meta"]["effective_mode"] == "lean"
    assert commit["summary_text"] == "林墨进入旧楼"
    assert commit["entities_appeared"] == ["char_lin"]
    assert commit["scenes"][0]["embedding_text"] == "旧楼调查"
    assert commit["scenes"][0]["chunk_id"] == "ch002:scene:001"
    assert commit["state_deltas"][0]["field"] == "current_status"
    assert commit["entity_deltas"][0]["operation"] == "introduced"
    assert commit["dominant_strand"] == "quest"
    assert commit["strand_distribution"] == {"quest": 1}

    rejected = build_chapter_commit(
        chapter=2,
        title="旧楼",
        word_count=2100,
        review_result=_review_result(blocking=True),
        extraction_delta=_legacy_delta(),
    )
    assert rejected["status"] == "rejected"


def test_event_derivation_helpers_accept_direct_events():
    events = [
        {
            "event_type": "state_changed",
            "entity_id": "char_lin",
            "entity_type": "角色",
            "field": "mood",
            "old": "calm",
            "new": "tense",
            "chapter": 3,
            "strand": "fire",
        },
        {
            "event_type": "entity_appeared",
            "entity_id": "char_su",
            "entity_type": "角色",
            "payload": {"name": "苏晚"},
            "chapter": 3,
            "strand": "quest",
        },
        {
            "event_type": "relationship_changed",
            "entity_id": "char_lin",
            "target_id": "char_su",
            "field": "trust",
            "old": "low",
            "new": "medium",
            "payload": {"note": "共同发现线索"},
            "chapter": 3,
            "strand": "quest",
        },
    ]
    scenes = [{"summary": "追问", "strand": "fire"}]

    assert derive_state_deltas(events)[0]["new"] == "tense"
    assert derive_state_deltas(events)[1]["field"] == "trust"
    assert derive_entity_deltas(events)[1]["name"] == "苏晚"
    assert compute_strand_distribution(events, scenes) == {"fire": 2, "quest": 2}
    assert compute_dominant_strand(events, scenes) == "fire"
    assert delta_to_events({"accepted_events": events}) == events


def test_commit_store_uses_three_digit_names_and_latest_accepted(tmp_path):
    store = CommitStore.from_project(tmp_path)
    rejected = {
        "chapter": 3,
        "title": "退稿",
        "status": "rejected",
        "commit_version": COMMIT_VERSION,
    }
    accepted_one = {
        "chapter": 1,
        "title": "开局",
        "status": "accepted",
        "commit_version": COMMIT_VERSION,
    }
    accepted_two = {
        "chapter": 2,
        "title": "旧楼",
        "status": "accepted",
        "commit_version": COMMIT_VERSION,
    }

    assert store.write(rejected).name == "chapter_003.commit.json"
    assert store.write(accepted_one).name == "chapter_001.commit.json"
    assert store.write(accepted_two).name == "chapter_002.commit.json"

    assert store.exists(1)
    assert not store.exists(4)
    assert store.read(2) == accepted_two
    assert [commit["chapter"] for commit in store.iter_all()] == [1, 2, 3]
    assert store.latest()["chapter"] == 3
    assert store.latest_accepted()["chapter"] == 2

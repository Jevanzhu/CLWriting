from __future__ import annotations

from typing import get_args, get_type_hints

from core.types import (
    AcceptedEvent,
    ChapterCommit,
    ChapterContract,
    EntityDelta,
    EventType,
    ExtractionDelta,
    MasterContract,
    NormalizedReviewerResult,
    ReviewContract,
    ReviewerResult,
    SceneSlice,
    StateDelta,
    StrandLiteral,
    VolumeContract,
    WriteGateStage,
    WriteSuccess,
)


def test_phase1_contract_types_are_defined_with_core_fields():
    assert set(get_args(StrandLiteral)) == {"quest", "fire", "constellation"}
    assert set(get_args(EventType)) == {
        "entity_introduced",
        "entity_appeared",
        "state_changed",
        "relationship_changed",
        "open_loop_created",
        "open_loop_closed",
        "rule_revealed",
        "timeline_advanced",
        "summary_recorded",
    }

    assert {"event_type", "strand", "entity_id", "payload", "chapter"} <= set(
        AcceptedEvent.__annotations__
    )
    assert {"embedding_text", "chunk_id", "strand"} <= set(SceneSlice.__annotations__)
    assert {"entity_id", "field", "old", "new", "chapter"} <= set(
        StateDelta.__annotations__
    )
    assert {"entity_id", "operation", "relationships", "fields"} <= set(
        EntityDelta.__annotations__
    )


def test_phase1_commit_and_contract_types_keep_projection_triggers():
    commit_fields = set(ChapterCommit.__annotations__)
    assert {
        "accepted_events",
        "state_deltas",
        "entity_deltas",
        "entities_appeared",
        "summary_text",
        "chapter_summary",
        "scenes",
        "dominant_strand",
        "strand_distribution",
        "timeline_entry",
        "world_rules",
        "agent_calls",
    } <= commit_fields

    assert {"project_type", "title", "route", "reasoning"} <= set(
        MasterContract.__annotations__
    )
    assert {"volume", "chapter_range", "arc_goal", "must_cover"} <= set(
        VolumeContract.__annotations__
    )
    assert {"planned_word_count", "expected_strand", "forbidden_zones"} <= set(
        ChapterContract.__annotations__
    )
    assert {"mode", "rubric_source", "strand_check", "quant_thresholds"} <= set(
        ReviewContract.__annotations__
    )


def test_extraction_delta_preserves_legacy_fields_and_adds_events():
    fields = set(ExtractionDelta.__annotations__)
    assert {
        "state_changes",
        "new_foreshadowing",
        "resolved_foreshadowing",
        "new_world_rules",
    } <= fields
    assert {"accepted_events", "dominant_strand", "scenes"} <= fields

    hints = get_type_hints(ExtractionDelta)
    assert hints["scenes"] == list[SceneSlice]


def test_reviewer_meta_is_optional_and_write_stage_accepts_commit():
    assert "meta" in ReviewerResult.__optional_keys__
    assert "meta" in NormalizedReviewerResult.__optional_keys__
    assert "meta" not in NormalizedReviewerResult.__required_keys__
    assert {"passed", "issues", "blockers", "warnings", "summary"} <= (
        NormalizedReviewerResult.__required_keys__
    )

    assert "commit" in get_args(WriteGateStage)
    hints = get_type_hints(WriteSuccess)
    assert set(get_args(hints["stage"])) == {"record", "commit"}

#!/usr/bin/env python3
"""TypedDict boundaries for story-craft JSON payloads."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


StrandLiteral = Literal["quest", "fire", "constellation"]
ReviewStatus = Literal["provided", "skipped"]

EventType = Literal[
    "entity_introduced",
    "entity_appeared",
    "state_changed",
    "relationship_changed",
    "open_loop_created",
    "open_loop_closed",
    "rule_revealed",
    "timeline_advanced",
    "summary_recorded",
]


class ReviewerIssue(TypedDict, total=False):
    severity: str
    category: str
    location: str
    description: str
    message: str
    evidence: str
    fix_hint: str
    blocking: bool


class ReviewMeta(TypedDict, total=False):
    source: Literal["agent", "fallback"]
    requested_mode: str
    effective_mode: str
    rubric_source: str
    fallback_reason: str


class ReviewerResult(TypedDict, total=False):
    """Raw reviewer output before local normalization."""

    issues: list[ReviewerIssue]
    summary: str
    meta: ReviewMeta


class _NormalizedReviewerResultRequired(TypedDict):
    """Reviewer output after normalize_reviewer_output().

    blockers is the authoritative blocking source.
    """

    passed: bool
    issues: list[ReviewerIssue]
    blockers: list[ReviewerIssue]
    warnings: list[ReviewerIssue]
    summary: str


class NormalizedReviewerResult(_NormalizedReviewerResultRequired, total=False):
    meta: ReviewMeta


class TimelineEntry(TypedDict, total=False):
    chapter: int
    time_marker: str
    location: str
    events: list[str]
    source: str
    time_elapsed: str
    time_delta: str


class ChapterSummary(TypedDict, total=False):
    chapter: int
    title: str
    summary: str
    word_count: int
    key_events: list[str]
    characters_appeared: list[str]
    hook_type: str
    hook_strength: str


class AcceptedEvent(TypedDict, total=False):
    event_type: EventType
    strand: StrandLiteral
    entity_id: str
    entity_type: str
    target_id: str
    field: str
    old: Any
    new: Any
    payload: dict[str, Any]
    chapter: int
    source: str


class SceneSlice(TypedDict, total=False):
    index: int
    start_line: int
    end_line: int
    location: str
    summary: str
    characters: list[str]
    tone: str
    strand: StrandLiteral
    embedding_text: str
    chunk_id: str


class StateDelta(TypedDict, total=False):
    entity_id: str
    entity_type: str
    field: str
    old: Any
    new: Any
    chapter: int


class EntityDelta(TypedDict, total=False):
    entity_id: str
    name: str
    entity_type: str
    role: str
    tier: str
    operation: Literal["introduced", "appeared", "updated"]
    relationships: list[dict[str, Any]]
    fields: dict[str, Any]
    chapter: int


class ChapterCommit(TypedDict, total=False):
    chapter: int
    title: str
    status: Literal["accepted", "rejected"]
    word_count: int
    written_at: str
    commit_version: str
    review_meta: ReviewMeta
    accepted_events: list[AcceptedEvent]
    state_deltas: list[StateDelta]
    entity_deltas: list[EntityDelta]
    entities_appeared: list[str]
    summary_text: str
    chapter_summary: ChapterSummary
    scenes: list[SceneSlice]
    dominant_strand: StrandLiteral
    strand_distribution: dict[str, int]
    timeline_entry: TimelineEntry
    world_rules: list[dict[str, Any]]
    agent_calls: dict[str, str]


class ProjectionStatus(TypedDict):
    ok: bool
    skipped: bool
    detail: str


class MasterContract(TypedDict, total=False):
    contract_version: str
    project_type: Literal["short", "long"]
    title: str
    genre: str
    sub_genre: str
    word_count_target: int
    one_liner: str
    theme_statement: str
    tone: dict[str, Any]
    taboos: list[str]
    hard_constraints: list[str]
    ending_constraint: str
    protagonist: dict[str, Any]
    antagonist_mirror: str
    unique_advantage: dict[str, Any]
    route: str
    reasoning: str
    created_at: str
    updated_at: str


class VolumeContract(TypedDict, total=False):
    contract_version: str
    volume: int
    title: str
    volume_directive: str
    chapter_range: list[int]
    arc_goal: str
    key_turns: list[str]
    must_cover: list[str]
    created_at: str
    updated_at: str


class ChapterContract(TypedDict, total=False):
    contract_version: str
    chapter: int
    volume: int
    title: str
    chapter_directive: str
    must_cover: list[str]
    forbidden_zones: list[str]
    planned_word_count: int
    expected_strand: StrandLiteral
    open_loops_to_plant: list[str]
    open_loops_to_close: list[str]
    created_at: str
    updated_at: str


class ReviewContract(TypedDict, total=False):
    contract_version: str
    chapter: int
    mode: str
    rubric_source: str
    dimensions: list[str]
    severity_scheme: str
    categories: list[str]
    strand_check: bool
    quant_thresholds: dict[str, Any]
    created_at: str
    updated_at: str


class ExtractionDelta(TypedDict, total=False):
    chapter: int
    title: str
    entities_new: list[dict[str, Any]]
    entities_appeared: list[str | dict[str, Any]]
    state_changes: list[dict[str, Any]]
    new_foreshadowing: list[dict[str, Any]]
    resolved_foreshadowing: list[dict[str, Any]]
    new_world_rules: list[dict[str, Any]]
    accepted_events: list[AcceptedEvent]
    dominant_strand: StrandLiteral
    timeline_entry: TimelineEntry
    scenes: list[SceneSlice]
    chapter_summary: ChapterSummary
    agent_calls: dict[str, str]


WriteGateStage = Literal[
    "prewrite",
    "placeholder",
    "markdown",
    "word_count",
    "warnings",
    "delta_validation",
    "write_error",
    "commit",
]


class WriteSuccess(TypedDict):
    ok: Literal[True]
    stage: Literal["record", "commit"]
    review_status: ReviewStatus
    chapter: int
    title: str
    word_count: int
    chapter_file: str
    report_file: str
    record_file: str
    commit_file: str
    projections: dict[str, ProjectionStatus]
    status: Literal["accepted"]
    memory_updated: bool
    state_updated: bool
    warnings: list[str]
    word_count_check: dict[str, Any]


class WriteGateFailureBase(TypedDict):
    ok: Literal[False]
    stage: WriteGateStage
    blockers: list[str]
    warnings: list[str]
    chapter_file: str | None
    report_file: str | None
    record_file: str | None
    draft_file: str


class WriteGateFailure(WriteGateFailureBase, total=False):
    review_status: ReviewStatus
    word_count_check: dict[str, Any]
    placeholders: list[dict[str, str]]
    markdown_residue: dict[str, Any]
    chapter: int
    title: str
    word_count: int
    status: Literal["failed"]
    memory_updated: Literal[False]
    state_updated: Literal[False]


class WriteRejection(TypedDict):
    ok: Literal[False]
    stage: Literal["record"]
    review_status: ReviewStatus
    chapter: int
    title: str
    word_count: int
    chapter_file: None
    report_file: str
    record_file: str
    commit_file: str
    projections: dict[str, ProjectionStatus]
    status: Literal["rejected"]
    memory_updated: Literal[False]
    state_updated: Literal[False]
    warnings: list[str]
    word_count_check: dict[str, Any]


WriteFailure = WriteGateFailure | WriteRejection
WriteResult = WriteSuccess | WriteFailure


class WorkflowManifest(TypedDict, total=False):
    ok: bool
    chapter: int
    project_root: str
    workflow_dir: str
    files: dict[str, str]
    agent_calls: dict[str, dict[str, Any]]
    cli_commands: dict[str, str]
    steps: list[str]
    hard_rules: list[str]

#!/usr/bin/env python3
"""TypedDict boundaries for story-craft JSON payloads."""

from __future__ import annotations

from typing import Any, TypedDict


class ReviewerIssue(TypedDict, total=False):
    severity: str
    category: str
    location: str
    description: str
    message: str
    evidence: str
    fix_hint: str
    blocking: bool


class ReviewerResult(TypedDict, total=False):
    """Raw reviewer output before local normalization."""

    issues: list[ReviewerIssue]
    suggestions: list[ReviewerIssue]
    summary: str


class NormalizedReviewerResult(TypedDict):
    """Reviewer output after normalize_reviewer_output().

    blockers is the authoritative blocking source.
    """

    passed: bool
    issues: list[ReviewerIssue]
    blockers: list[ReviewerIssue]
    warnings: list[ReviewerIssue]
    suggestions: list[ReviewerIssue]
    summary: str


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


class ExtractionDelta(TypedDict, total=False):
    chapter: int
    title: str
    entities_new: list[dict[str, Any]]
    entities_appeared: list[str]
    state_changes: list[dict[str, Any]]
    new_foreshadowing: list[dict[str, Any]]
    resolved_foreshadowing: list[dict[str, Any]]
    new_world_rules: list[dict[str, Any]]
    timeline_entry: TimelineEntry
    scenes: list[dict[str, Any]]
    chapter_summary: ChapterSummary
    agent_calls: dict[str, str]


class WriteResult(TypedDict, total=False):
    ok: bool
    stage: str
    chapter: int
    title: str
    word_count: int
    chapter_file: str | None
    report_file: str | None
    commit_file: str | None
    draft_file: str
    status: str
    memory_updated: bool
    state_updated: bool
    blockers: list[str]
    warnings: list[str]
    word_count_check: dict[str, Any]


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

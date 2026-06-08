from __future__ import annotations

from conftest import reviewer_issue
from tools.repair_strength import (
    REPAIR_COMPLETE,
    REPAIR_PARTIAL,
    REPAIR_POLISH,
    build_repair_workflow,
    classify_repair_strength,
    repair_mode_from_counts,
)


def test_repair_mode_thresholds_are_deterministic():
    assert repair_mode_from_counts(critical=3, major=0) == REPAIR_COMPLETE
    assert repair_mode_from_counts(critical=0, major=5) == REPAIR_COMPLETE
    assert repair_mode_from_counts(critical=2, major=0) == REPAIR_PARTIAL
    assert repair_mode_from_counts(critical=0, major=4) == REPAIR_PARTIAL
    assert repair_mode_from_counts(critical=0, major=2, minor=8) == REPAIR_POLISH


def test_s1_s2_findings_drive_complete_rewrite():
    review = {
        "issues": [
            reviewer_issue(severity="S1", blocking=True),
            reviewer_issue(severity="S2", blocking=True),
            reviewer_issue(severity="critical", blocking=True),
        ],
        "summary": "多处阻断。",
    }

    result = classify_repair_strength(review)

    assert result["repair_mode"] == REPAIR_COMPLETE
    assert result["counts"]["critical"] == 3
    assert result["normalized_review"]["blockers"]


def test_major_findings_drive_partial_rewrite():
    review = {
        "issues": [
            reviewer_issue(severity="S3", blocking=False),
            reviewer_issue(severity="medium", blocking=False),
            reviewer_issue(severity="high", blocking=False),
        ],
        "summary": "需要局部重写。",
    }

    result = build_repair_workflow(review)

    assert result["repair_mode"] == REPAIR_PARTIAL
    assert result["counts"]["major"] == 3
    assert [step["name"] for step in result["steps"]] == [
        "diagnosis_report",
        "rewrite_chapter",
        "rewrite_delta",
    ]


def test_minor_findings_only_use_polish_mode():
    review = {
        "issues": [
            reviewer_issue(severity="S4", blocking=False),
            reviewer_issue(severity="low", blocking=False),
        ],
        "summary": "只需润色。",
    }

    result = classify_repair_strength(review)

    assert result["repair_mode"] == REPAIR_POLISH
    assert result["counts"] == {"critical": 0, "major": 0, "minor": 2}

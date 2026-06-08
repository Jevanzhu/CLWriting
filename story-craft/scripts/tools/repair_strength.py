#!/usr/bin/env python3
"""Deterministic repair strength classification for reviewer findings."""

from __future__ import annotations

from typing import Any

from tools.agent_workflow import normalize_reviewer_output


REPAIR_COMPLETE = "complete_rewrite"
REPAIR_PARTIAL = "partial_rewrite"
REPAIR_POLISH = "polish_only"


def classify_repair_strength(review_result: dict[str, Any]) -> dict[str, Any]:
    """Return repair mode from normalized reviewer issue counts."""
    normalized = normalize_reviewer_output(review_result)
    counts = count_repair_findings(normalized.get("issues", []))
    mode = repair_mode_from_counts(
        critical=counts["critical"],
        major=counts["major"],
        minor=counts["minor"],
    )
    return {
        "ok": True,
        "repair_mode": mode,
        "counts": counts,
        "rules": {
            "complete_rewrite": "critical>=3 或 major>=5",
            "partial_rewrite": "critical 1-2 或 major 3-4",
            "polish_only": "仅 minor 或无问题",
        },
        "normalized_review": normalized,
    }


def count_repair_findings(issues: list[dict[str, Any]]) -> dict[str, int]:
    """Count findings into critical/major/minor buckets."""
    counts = {"critical": 0, "major": 0, "minor": 0}
    for issue in issues:
        severity = str(issue.get("severity") or "").strip()
        blocking = bool(issue.get("blocking"))
        bucket = _bucket_for_issue(severity, blocking)
        counts[bucket] += 1
    return counts


def repair_mode_from_counts(*, critical: int, major: int, minor: int = 0) -> str:
    """Apply S3-07 repair strength thresholds."""
    if critical >= 3 or major >= 5:
        return REPAIR_COMPLETE
    if 1 <= critical <= 2 or 3 <= major <= 4:
        return REPAIR_PARTIAL
    return REPAIR_POLISH


def build_repair_workflow(review_result: dict[str, Any]) -> dict[str, Any]:
    """Build the three-part repair workflow expected by story-repair."""
    classified = classify_repair_strength(review_result)
    mode = classified["repair_mode"]
    return {
        "ok": True,
        "repair_mode": mode,
        "counts": classified["counts"],
        "steps": [
            {
                "name": "diagnosis_report",
                "instruction": "按 findings 聚合阻断点、证据和修复目标。",
            },
            {
                "name": "rewrite_chapter",
                "instruction": _rewrite_instruction(mode),
            },
            {
                "name": "rewrite_delta",
                "instruction": "列出新增、删除、改写的剧情事实，交 data-agent 复核。",
            },
        ],
        "normalized_review": classified["normalized_review"],
    }


def _bucket_for_issue(severity: str, blocking: bool) -> str:
    normalized = severity.upper()
    if normalized in {"S1", "CRITICAL"}:
        return "critical"
    if normalized == "S2":
        return "critical" if blocking else "major"
    if normalized in {"HIGH", "MAJOR"}:
        return "major"
    if normalized in {"S3", "MEDIUM"}:
        return "major"
    return "minor"


def _rewrite_instruction(mode: str) -> str:
    if mode == REPAIR_COMPLETE:
        return "完整重写章节，保留合同事实和必要伏笔，重建场景推进。"
    if mode == REPAIR_PARTIAL:
        return "局部重写阻断段落，保持未受影响段落的事实与语气。"
    return "只做表达、节奏和格式润色，不新增剧情事实。"

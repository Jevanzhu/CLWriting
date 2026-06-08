#!/usr/bin/env python3
"""Narrative strand balance diagnostics for story-craft."""

from __future__ import annotations

import math
from typing import Any


DEFAULT_EXPECTED_BALANCE = {
    "quest": 0.6,
    "fire": 0.2,
    "constellation": 0.2,
}


def evaluate_strand_balance(
    distribution: dict[str, int],
    *,
    expected: dict[str, float] = DEFAULT_EXPECTED_BALANCE,
    tolerance: float = 0.15,
) -> dict:
    """Compare an existing strand distribution with target ratios."""
    expected_ratios = _normalise_expected(expected)
    tolerance_value = _validate_tolerance(tolerance)
    counts = _positive_counts(distribution)
    if not counts:
        return {
            "balanced": False,
            "ratios": {strand: 0.0 for strand in expected_ratios},
            "diagnosis": ["没有可用叙事线数据，无法判断节奏平衡。"],
            "dominant": "",
        }

    total = sum(counts.values())
    strands = _ordered_strands(expected_ratios, counts)
    ratios = {strand: counts.get(strand, 0) / total for strand in strands}
    dominant = max(counts, key=counts.get)

    balanced = True
    diagnosis: list[str] = []
    for strand, target in expected_ratios.items():
        actual = ratios.get(strand, 0.0)
        delta = actual - target
        if abs(delta) > tolerance_value:
            balanced = False
            direction = "高于" if delta > 0 else "低于"
            diagnosis.append(f"{strand} 占比 {_percent(actual)}，{direction}目标 {_percent(target)}。")

    for strand in strands:
        if strand in expected_ratios:
            continue
        actual = ratios.get(strand, 0.0)
        if actual > 0:
            balanced = False
            diagnosis.append(f"未知叙事线 {strand} 占比 {_percent(actual)}，请确认映射。")

    if balanced:
        diagnosis.append("叙事线比例在目标容差内。")

    return {
        "balanced": balanced,
        "ratios": ratios,
        "diagnosis": diagnosis,
        "dominant": dominant,
    }


def _positive_counts(distribution: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for raw_strand, raw_count in distribution.items():
        strand = str(raw_strand or "").strip()
        if not strand:
            continue
        try:
            count = int(raw_count or 0)
        except (TypeError, ValueError):
            continue
        if count > 0:
            counts[strand] = counts.get(strand, 0) + count
    return counts


def _normalise_expected(expected: dict[str, float]) -> dict[str, float]:
    if not expected:
        raise ValueError("expected must not be empty")

    targets: dict[str, float] = {}
    for raw_strand, raw_ratio in expected.items():
        strand = str(raw_strand or "").strip()
        if not strand:
            raise ValueError("expected strand must not be empty")
        try:
            ratio = float(raw_ratio or 0)
        except (TypeError, ValueError):
            raise ValueError(f"expected ratio for {strand} must be numeric") from None
        if not math.isfinite(ratio) or ratio < 0:
            raise ValueError(f"expected ratio for {strand} must be finite and non-negative")
        targets[strand] = ratio

    total = sum(targets.values())
    if total <= 0:
        raise ValueError("expected ratios must sum to a positive number")
    return {strand: ratio / total for strand, ratio in targets.items()}


def _ordered_strands(expected: dict[str, float], counts: dict[str, int]) -> list[str]:
    strands = list(expected)
    strands.extend(strand for strand in counts if strand not in expected)
    return strands


def _validate_tolerance(value: object) -> float:
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        raise ValueError("tolerance must be numeric") from None
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1:
        raise ValueError("tolerance must be a finite number between 0 and 1")
    return parsed


def _percent(value: float) -> str:
    return f"{value:.0%}"

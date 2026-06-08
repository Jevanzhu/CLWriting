from __future__ import annotations

import pytest

from conftest import reviewer_issue
from tools.agent_workflow import normalize_reviewer_output
from tools.review_pipeline import build_review_report
from tools.strand_calculator import evaluate_strand_balance


def _review_results():
    return normalize_reviewer_output(
        {
            "issues": [
                reviewer_issue(
                    severity="low",
                    category="pacing",
                    location="第1段",
                    description="节奏略慢",
                    evidence="铺垫偏长",
                    fix_hint="提前异常事件",
                    blocking=False,
                )
            ],
            "summary": "可提交。",
        }
    )


def test_evaluate_strand_balance_accepts_balanced_distribution():
    result = evaluate_strand_balance(
        {"quest": 6, "fire": 2, "constellation": 2},
    )

    assert result["balanced"]
    assert result["dominant"] == "quest"
    assert result["ratios"] == {
        "quest": 0.6,
        "fire": 0.2,
        "constellation": 0.2,
    }
    assert sum(result["ratios"].values()) == 1.0
    assert result["diagnosis"] == ["叙事线比例在目标容差内。"]


def test_evaluate_strand_balance_reports_single_strand_dominance():
    result = evaluate_strand_balance({"fire": 10})

    assert not result["balanced"]
    assert result["dominant"] == "fire"
    assert result["ratios"]["fire"] == 1.0
    assert result["ratios"]["quest"] == 0.0
    assert sum(result["ratios"].values()) == 1.0
    assert any("fire 占比 100%" in item for item in result["diagnosis"])
    assert any("quest 占比 0%" in item for item in result["diagnosis"])


def test_evaluate_strand_balance_handles_empty_and_unknown_distribution():
    empty = evaluate_strand_balance({})

    assert not empty["balanced"]
    assert empty["dominant"] == ""
    assert empty["ratios"] == {
        "quest": 0.0,
        "fire": 0.0,
        "constellation": 0.0,
    }
    assert "没有可用叙事线数据" in empty["diagnosis"][0]

    unknown = evaluate_strand_balance({"quest": 3, "mystery": 1, "fire": 0})

    assert not unknown["balanced"]
    assert unknown["dominant"] == "quest"
    assert set(unknown["ratios"]) == {"quest", "fire", "constellation", "mystery"}
    assert round(sum(unknown["ratios"].values()), 6) == 1.0
    assert any("未知叙事线 mystery" in item for item in unknown["diagnosis"])


def test_evaluate_strand_balance_normalises_custom_expected_and_ignores_bad_counts():
    result = evaluate_strand_balance(
        {"quest": "2", "fire": "bad", "constellation": -1},
        expected={"quest": 2, "fire": 1, "constellation": 1},
        tolerance=0.5,
    )

    assert result["dominant"] == "quest"
    assert result["ratios"]["quest"] == 1.0
    assert round(sum(result["ratios"].values()), 6) == 1.0
    assert result["balanced"]


def test_evaluate_strand_balance_tolerance_boundary_is_inclusive():
    result = evaluate_strand_balance(
        {"quest": 2},
        expected={"quest": 1, "fire": 1},
        tolerance=0.5,
    )

    assert result["balanced"]
    assert result["diagnosis"] == ["叙事线比例在目标容差内。"]


def test_evaluate_strand_balance_rejects_invalid_expected_and_tolerance():
    with pytest.raises(ValueError):
        evaluate_strand_balance({"quest": 1}, expected={})

    with pytest.raises(ValueError):
        evaluate_strand_balance({"quest": 1}, expected={"quest": -1})

    with pytest.raises(ValueError):
        evaluate_strand_balance({"quest": 1}, tolerance=1.5)


def test_build_review_report_default_output_stays_unchanged():
    review_results = _review_results()
    legacy = build_review_report(1, review_results, "正文内容")
    with_default = build_review_report(1, review_results, "正文内容", strand_diagnosis=None)

    assert with_default == legacy
    assert "## 叙事线节奏" not in legacy


def test_build_review_report_renders_strand_diagnosis_when_provided():
    report = build_review_report(
        1,
        _review_results(),
        "正文内容",
        strand_diagnosis=evaluate_strand_balance({"quest": 1, "fire": 4}),
    )

    assert "## 叙事线节奏" in report
    assert "- 状态：失衡" in report
    assert "- 主导叙事线：fire" in report
    assert "- 当前占比：quest 20%，fire 80%，constellation 0%" in report
    assert "fire 占比 80%" in report

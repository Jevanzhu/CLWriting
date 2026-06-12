from __future__ import annotations

from core.text_utils import build_heuristic_summary


def test_heuristic_summary_picks_first_signal_and_last():
    text = (
        "林墨走进解剖室。\n\n"
        "她例行检查了器械。\n\n"
        "她突然发现信封上有一道刮痕。\n\n"
        "那道刮痕像一个被擦去的门牌号。"
    )

    summary = build_heuristic_summary(text, max_length=120)

    assert "林墨走进解剖室" in summary
    assert "突然发现" in summary
    assert "门牌号" in summary
    assert "例行检查" not in summary
    assert len(summary) <= 120


def test_heuristic_summary_picks_question_as_middle_signal():
    text = "林墨推开档案室。柜门没有上锁。是谁提前来过？窗外传来警笛。"

    summary = build_heuristic_summary(text, max_length=120)

    assert "林墨推开档案室" in summary
    assert "是谁提前来过" in summary
    assert "窗外传来警笛" in summary


def test_heuristic_summary_handles_empty_outline_and_single_sentence():
    assert build_heuristic_summary("") == ""
    assert build_heuristic_summary("", outline_hint="第01章：葬礼后的信") == "第01章：葬礼后的信"

    summary = build_heuristic_summary("只有一句话。")

    assert "只有一句话" in summary


def test_heuristic_summary_ignores_markdown_heading():
    text = "# 第01章 葬礼后的信\n\n林墨站在雨里。亡友的信没有邮戳。她决定回到解剖室。"

    summary = build_heuristic_summary(text, max_length=120)

    assert "第01章" not in summary
    assert "林墨站在雨里" in summary
    assert "决定回到解剖室" in summary


def test_heuristic_summary_respects_max_length():
    text = (
        "林墨站在很长很长的雨夜里等待一封迟到多年的信。"
        "她突然发现信封背面藏着一串陌生编号。"
        "那串编号最终指向被封存的地下档案室。"
    )

    summary = build_heuristic_summary(text, max_length=30)

    assert len(summary) <= 30
    assert summary.endswith("…")

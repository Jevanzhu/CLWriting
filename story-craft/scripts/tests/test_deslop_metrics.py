from __future__ import annotations

from tools.deslop_metrics import (
    analyze_deslop_metrics,
    apply_deslop_whitelist,
    average_paragraph_sentences,
    banned_word_density,
    dialogue_tag_density,
    markdown_residue,
    parallel_paragraph_run,
    psychological_word_ratio,
    repetitive_description_density,
)


def test_deslop_metrics_empty_text_is_zero():
    result = analyze_deslop_metrics("")

    assert result["overall_level"] == "none"
    for gate in result["gates"].values():
        assert gate["value"] == 0.0
        assert gate["level"] == "none"


def test_banned_word_density_thresholds_are_deterministic():
    text = "缓缓" * 2 + "林墨" * 100

    metric = banned_word_density(text)
    result = analyze_deslop_metrics(text)

    assert metric["value"] >= 8
    assert result["gates"]["banned_word_density"]["level"] == "medium"
    assert "缓缓:2" in result["gates"]["banned_word_density"]["evidence"]


def test_deslop_whitelist_removes_project_level_exemptions():
    text = "缓缓" * 2 + "林墨" * 100

    cleaned = apply_deslop_whitelist(text, ["缓缓"])
    result = analyze_deslop_metrics(text, whitelist=["缓缓", ""])

    assert "缓缓" not in cleaned
    assert result["whitelist_applied"] == ["缓缓"]
    assert result["gates"]["banned_word_density"]["level"] == "none"


def test_parallel_paragraph_run_uses_consecutive_openers():
    text = "\n".join(
        [
            "林墨推开门。",
            "林墨看见信。",
            "林墨停住脚。",
            "周晚低声提醒。",
        ]
    )

    metric = parallel_paragraph_run(text)

    assert metric["value"] == 3.0
    assert metric["evidence"] == ["林墨"]


def test_psychological_word_ratio_counts_hits_per_sentence():
    text = "林墨感觉门后有风。他觉得线索不对。他意识到有人撒谎。"

    metric = psychological_word_ratio(text)
    result = analyze_deslop_metrics(text)

    assert metric["value"] == 1.0
    assert result["gates"]["psychological_word_ratio"]["level"] == "heavy"


def test_dialogue_tag_density_uses_dialogue_lines_as_denominator():
    text = "“你来晚了。”林墨说道\n“门没锁。”周晚问道\n“先看监控。”"

    metric = dialogue_tag_density(text)

    assert metric["value"] == 0.667
    assert len(metric["evidence"]) == 2


def test_average_paragraph_sentences_threshold_boundary():
    text = "。".join(["行动"] * 6) + "。\n\n短句。"

    metric = average_paragraph_sentences(text)
    result = analyze_deslop_metrics(text)

    assert metric["value"] == 3.5
    assert result["gates"]["average_paragraph_sentences"]["level"] == "none"

    long_paragraph = "。".join(["行动"] * 8) + "。"
    long_result = analyze_deslop_metrics(long_paragraph)
    assert long_result["gates"]["average_paragraph_sentences"]["level"] == "heavy"


def test_repetitive_description_density_counts_repeats_beyond_first_use():
    text = "昏黄" * 4 + "林墨" * 100

    metric = repetitive_description_density(text)
    result = analyze_deslop_metrics(text)

    assert metric["value"] >= 12
    assert result["gates"]["repetitive_description_density"]["level"] == "heavy"
    assert "昏黄:3" in result["gates"]["repetitive_description_density"]["evidence"]


def test_markdown_residue_flags_markup_and_clean_prose_is_none():
    clean = "她把门推开。\n外面下着雨。\n“你来了。”"
    dirty = "\n".join(
        [
            "###1.",
            "**重点**在这里。",
            "这句有*斜体*残留。",
            "这句有_斜体_残留。",
            "---",
            "> 引用句",
            "- 列表项",
            "[链接](http://x)",
            "`代码`",
        ]
    )

    assert markdown_residue(clean)["value"] == 0.0
    assert markdown_residue("这句有*斜体*残留。")["value"] == 1.0
    assert markdown_residue("这句有_斜体_残留。")["value"] == 1.0

    dirty_metric = markdown_residue(dirty)
    result = analyze_deslop_metrics(dirty)
    assert dirty_metric["value"] >= 6
    assert result["gates"]["markdown_residue"]["level"] == "heavy"
    assert result["gates"]["markdown_residue"]["evidence"]


def test_markdown_residue_cannot_be_suppressed_by_whitelist():
    text = "###1.\n正文里有**重点**。"

    result = analyze_deslop_metrics(text, whitelist=["###", "**"])

    assert result["whitelist_applied"] == ["###", "**"]
    assert result["gates"]["markdown_residue"]["value"] == 2.0
    assert result["gates"]["markdown_residue"]["level"] == "light"

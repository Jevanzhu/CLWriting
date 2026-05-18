#!/usr/bin/env python3
"""Lightweight style sampling and drift detection."""

from __future__ import annotations

import re
from collections import Counter

from core.text_utils import count_chinese_chars


SENTENCE_RE = re.compile(r"[^。！？!?]+[。！？!?]?")
ACTION_WORDS = {"走", "跑", "推", "拉", "看", "听", "拿", "放", "转身", "抬头", "低头"}
DESCRIPTION_WORDS = {"像", "仿佛", "颜色", "光", "影", "气味", "声音", "冷", "热", "潮湿"}


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in SENTENCE_RE.findall(text or "") if item.strip()]


def extract_style_sample(chapter_text: str, chapter: int) -> dict:
    """Extract coarse style features from one chapter."""
    text = chapter_text or ""
    sentences = _sentences(text)
    total_chars = max(count_chinese_chars(text), 1)
    dialogue_chars = sum(
        count_chinese_chars(match) for match in re.findall(r"[“\"]([^”\"]+)[”\"]", text)
    )
    action_hits = sum(text.count(word) for word in ACTION_WORDS)
    description_hits = sum(text.count(word) for word in DESCRIPTION_WORDS)
    starters = [sentence[:2] for sentence in sentences if len(sentence) >= 2]
    avg_sentence_length = (
        round(sum(count_chinese_chars(sentence) for sentence in sentences) / len(sentences), 2)
        if sentences
        else 0.0
    )

    if avg_sentence_length >= 32:
        vocabulary_tier = "literary"
    elif avg_sentence_length <= 16:
        vocabulary_tier = "simple"
    else:
        vocabulary_tier = "standard"

    action_ratio = min(action_hits / max(len(sentences), 1), 1.0)
    description_ratio = min(description_hits / max(len(sentences), 1), 1.0)

    return {
        "chapter": int(chapter),
        "avg_sentence_length": avg_sentence_length,
        "dialogue_ratio": round(dialogue_chars / total_chars, 3),
        "description_ratio": round(description_ratio, 3),
        "action_ratio": round(action_ratio, 3),
        "common_sentence_starters": [item for item, _count in Counter(starters).most_common(5)],
        "vocabulary_tier": vocabulary_tier,
    }


def detect_style_drift(current: dict, baseline: dict) -> list[str]:
    """Detect simple style drift against a baseline sample."""
    warnings: list[str] = []
    current_avg = float(current.get("avg_sentence_length") or 0)
    baseline_avg = float(baseline.get("avg_sentence_length") or 0)
    if baseline_avg and abs(current_avg - baseline_avg) >= 10:
        warnings.append("平均句长偏离基准超过10字")

    for key, label in (
        ("dialogue_ratio", "对白占比"),
        ("description_ratio", "描写占比"),
        ("action_ratio", "动作占比"),
    ):
        current_value = float(current.get(key) or 0)
        baseline_value = float(baseline.get(key) or 0)
        if abs(current_value - baseline_value) >= 0.25:
            warnings.append(f"{label}偏离基准超过25%")

    if current.get("vocabulary_tier") != baseline.get("vocabulary_tier"):
        warnings.append("词汇层级与基准不一致")
    return warnings

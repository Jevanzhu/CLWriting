#!/usr/bin/env python3
"""Deterministic 6-Gate anti-AI-flavor metrics plus a publish-ready Markdown-residue gate."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from core.text_utils import count_chinese_chars, split_sentences


LEVELS = ("none", "light", "medium", "heavy")
BANNED_WORDS = (
    "缓缓",
    "淡淡",
    "微微",
    "眸中闪过",
    "心中一凛",
    "下意识",
    "一瞬间",
    "仿佛",
    "似乎",
    "空气凝固",
    "说不出的感觉",
    "眼神复杂",
)
PSYCHOLOGICAL_WORDS = (
    "心想",
    "觉得",
    "感觉",
    "感到",
    "意识到",
    "心里",
    "内心",
    "情绪",
    "害怕",
    "愤怒",
    "悲伤",
    "震惊",
    "不安",
    "痛苦",
    "绝望",
    "希望",
)
DESCRIPTION_WORDS = (
    "昏黄",
    "冰冷",
    "潮湿",
    "沉默",
    "压抑",
    "破旧",
    "刺眼",
    "空荡",
    "寂静",
    "阴影",
    "雨声",
    "灯光",
)
DIALOGUE_TAG_RE = re.compile(
    r"[“\"][^”\"\n]{1,80}[”\"]\s*(?:他|她|我|你|林墨|[一-龥]{1,4})?"
    r"(?:说|说道|问|问道|答|答道|喊|喊道|低声|冷冷|淡淡|喃喃)"
)
DIALOGUE_LINE_RE = re.compile(r"[“\"][^”\"\n]{1,120}[”\"]")
CHINESE_PREFIX_RE = re.compile(r"^[^\u4e00-\u9fff]*([\u4e00-\u9fff]{1,2})")
MARKDOWN_PATTERNS = (
    ("heading", re.compile(r"(?m)^[ \t]{0,3}#{1,6}")),
    ("bold", re.compile(r"\*\*[^\s*][^*]*\*\*|__[^\s_][^_]*__")),
    (
        "italic",
        re.compile(
            r"(?<![A-Za-z0-9_*])\*(?!\*)(?=[^\s*\n])[^*\n]*?[^\s*\n]\*(?![A-Za-z0-9_*])"
            r"|(?<![A-Za-z0-9_*])_(?!_)(?=[^\s_\n])[^_\n]*?[^\s_\n]_(?![A-Za-z0-9_*])"
        ),
    ),
    ("rule", re.compile(r"(?m)^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$")),
    ("list", re.compile(r"(?m)^[ \t]{0,3}[-+*][ \t]+")),
    ("quote", re.compile(r"(?m)^[ \t]{0,3}>[ \t]?")),
    ("link", re.compile(r"\[[^\]\n]+\]\([^)\n]+\)")),
    ("code", re.compile(r"`[^`\n]+`|```")),
)


GATE_THRESHOLDS: dict[str, tuple[float, float, float]] = {
    "banned_word_density": (3.0, 8.0, 15.0),
    "parallel_paragraph_run": (2.0, 3.0, 5.0),
    "psychological_word_ratio": (0.15, 0.30, 0.50),
    "dialogue_tag_density": (0.35, 0.60, 0.85),
    "average_paragraph_sentences": (4.0, 6.0, 8.0),
    "repetitive_description_density": (4.0, 8.0, 12.0),
    "markdown_residue": (1.0, 3.0, 6.0),
}


def analyze_deslop_metrics(text: str, whitelist: list[str] | None = None) -> dict[str, Any]:
    """Return all 6-Gate metrics and an overall level for text."""
    cleaned_text = apply_deslop_whitelist(text, whitelist)
    payload = {
        "banned_word_density": banned_word_density(cleaned_text),
        "parallel_paragraph_run": parallel_paragraph_run(cleaned_text),
        "psychological_word_ratio": psychological_word_ratio(cleaned_text),
        "dialogue_tag_density": dialogue_tag_density(cleaned_text),
        "average_paragraph_sentences": average_paragraph_sentences(cleaned_text),
        "repetitive_description_density": repetitive_description_density(cleaned_text),
        "markdown_residue": markdown_residue(text),
    }
    gates = {
        name: {
            "value": metric["value"],
            "level": _level(name, metric["value"]),
            "evidence": metric["evidence"],
        }
        for name, metric in payload.items()
    }
    return {
        "gates": gates,
        "overall_level": _max_level(item["level"] for item in gates.values()),
        "whitelist_applied": sorted(set(_normalize_whitelist(whitelist))),
    }


def apply_deslop_whitelist(text: str, whitelist: list[str] | None = None) -> str:
    """Remove project-level exempt phrases before deterministic 6-Gate analysis."""
    cleaned = str(text or "")
    for phrase in _normalize_whitelist(whitelist):
        cleaned = cleaned.replace(phrase, "")
    return cleaned


def banned_word_density(text: str) -> dict[str, Any]:
    """Count banned/template words per 1000 Chinese characters."""
    total_chars = max(count_chinese_chars(text), 1)
    hits = Counter({word: str(text or "").count(word) for word in BANNED_WORDS})
    total_hits = sum(hits.values())
    return {
        "value": round(total_hits / total_chars * 1000, 3),
        "evidence": _top_hits(hits),
    }


def parallel_paragraph_run(text: str) -> dict[str, Any]:
    """Find the longest consecutive run with the same two-character opener."""
    max_run = 0
    current_run = 0
    current_signature = ""
    evidence: list[str] = []
    for paragraph in _paragraphs(text):
        signature = _paragraph_signature(paragraph)
        if not signature:
            current_signature = ""
            current_run = 0
            continue
        if signature == current_signature:
            current_run += 1
        else:
            current_signature = signature
            current_run = 1
        if current_run > max_run:
            max_run = current_run
            evidence = [signature]
    return {"value": float(max_run), "evidence": evidence}


def psychological_word_ratio(text: str) -> dict[str, Any]:
    """Count psychological-label hits per sentence."""
    sentences = max(len(split_sentences(text)), 1)
    hits = Counter({word: str(text or "").count(word) for word in PSYCHOLOGICAL_WORDS})
    total_hits = sum(hits.values())
    return {
        "value": round(total_hits / sentences, 3),
        "evidence": _top_hits(hits),
    }


def dialogue_tag_density(text: str) -> dict[str, Any]:
    """Count explicit dialogue tags relative to dialogue lines."""
    dialogue_lines = DIALOGUE_LINE_RE.findall(text or "")
    if not dialogue_lines:
        return {"value": 0.0, "evidence": []}
    tag_hits = DIALOGUE_TAG_RE.findall(text or "")
    return {
        "value": round(len(tag_hits) / len(dialogue_lines), 3),
        "evidence": tag_hits[:5],
    }


def average_paragraph_sentences(text: str) -> dict[str, Any]:
    """Average sentence count per non-empty paragraph."""
    paragraphs = _paragraphs(text)
    if not paragraphs:
        return {"value": 0.0, "evidence": []}
    counts = [len(split_sentences(paragraph)) for paragraph in paragraphs]
    average = sum(counts) / len(counts)
    return {
        "value": round(average, 3),
        "evidence": [f"max={max(counts)}", f"paragraphs={len(paragraphs)}"],
    }


def repetitive_description_density(text: str) -> dict[str, Any]:
    """Count repeated descriptive words beyond first use per 1000 Chinese chars."""
    total_chars = max(count_chinese_chars(text), 1)
    hits = Counter({word: str(text or "").count(word) for word in DESCRIPTION_WORDS})
    repeated = Counter({word: count - 1 for word, count in hits.items() if count > 1})
    repeated_total = sum(repeated.values())
    return {
        "value": round(repeated_total / total_chars * 1000, 3),
        "evidence": _top_hits(repeated),
    }


def markdown_residue(text: str) -> dict[str, Any]:
    """Count residual Markdown markup that must not appear in publish-ready prose."""
    source = str(text or "")
    hits: list[str] = []
    total = 0
    for label, pattern in MARKDOWN_PATTERNS:
        found = pattern.findall(source)
        if not found:
            continue
        total += len(found)
        for item in found[:2]:
            sample = (item if isinstance(item, str) else str(item)).strip()
            if sample:
                hits.append(f"{label}:{sample[:12]}")
    return {
        "value": float(total),
        "evidence": hits[:5],
    }


def _level(name: str, value: float) -> str:
    light, medium, heavy = GATE_THRESHOLDS[name]
    if value >= heavy:
        return "heavy"
    if value >= medium:
        return "medium"
    if value >= light:
        return "light"
    return "none"


def _max_level(levels: Any) -> str:
    order = {level: index for index, level in enumerate(LEVELS)}
    return max((str(level) for level in levels), key=lambda item: order.get(item, 0))


def _paragraphs(text: str) -> list[str]:
    return [item.strip() for item in str(text or "").splitlines() if item.strip()]


def _paragraph_signature(paragraph: str) -> str:
    match = CHINESE_PREFIX_RE.search(paragraph.strip())
    return match.group(1) if match else ""


def _top_hits(counter: Counter[str], limit: int = 5) -> list[str]:
    return [f"{word}:{count}" for word, count in counter.most_common(limit) if count > 0]


def _normalize_whitelist(whitelist: list[str] | None) -> list[str]:
    return [str(item).strip() for item in whitelist or [] if str(item).strip()]

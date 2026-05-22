#!/usr/bin/env python3
"""Shared text helpers for story-craft."""

from __future__ import annotations

import re


CHINESE_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")


def count_chinese_chars(text: str) -> int:
    """Count CJK characters as the project word-count proxy."""
    return len(CHINESE_CHAR_RE.findall(text or ""))


def compact_line(text: str, max_length: int = 120, fallback: str = "") -> str:
    compact = " ".join(str(text or "").split())
    if not compact:
        return fallback
    if len(compact) <= max_length:
        return compact
    return compact[: max_length - 1] + "…"


def outline_value(outline_text: str, label: str) -> str:
    for raw_line in str(outline_text or "").splitlines():
        line = raw_line.strip().lstrip("-").strip()
        prefix = f"{label}："
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""


def first_int(text: str) -> int:
    match = re.search(r"\d+", str(text or ""))
    return int(match.group(0)) if match else 0


CHINESE_SENTENCE_RE = re.compile(r"[^。！？!?]+[。！？!?]?")


def split_sentences(text: str) -> list[str]:
    return [item.strip() for item in CHINESE_SENTENCE_RE.findall(text or "") if item.strip()]

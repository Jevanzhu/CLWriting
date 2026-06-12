#!/usr/bin/env python3
"""Shared text helpers for story-craft."""

from __future__ import annotations

import re
from typing import Any


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

# 中文小说里标志冲突、转折、揭示、钩子的信号词，用于无 LLM 摘要选句。
_SUMMARY_SIGNAL_WORDS = (
    "却",
    "但",
    "突然",
    "竟",
    "竟然",
    "原来",
    "发现",
    "其实",
    "没想到",
    "真相",
    "秘密",
    "死",
    "杀",
    "血",
    "不是",
    "并非",
    "为什么",
    "谁",
    "决定",
    "终于",
    "警报",
    "消失",
    "背叛",
    "可是",
    "然而",
)


def split_sentences(text: str) -> list[str]:
    return [item.strip() for item in CHINESE_SENTENCE_RE.findall(text or "") if item.strip()]


def _summary_source_text(text: str) -> str:
    body_lines = []
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            body_lines.append(line)
    return "\n".join(body_lines) or str(text or "")


def build_heuristic_summary(
    text: str,
    *,
    outline_hint: str = "",
    max_length: int = 120,
) -> str:
    """无 LLM 的启发式章节摘要：首句 + 关键转折句 + 末句。"""
    source = _summary_source_text(text)
    sentences = split_sentences(source)
    if not sentences:
        return compact_line(source or outline_hint, max_length=max_length)

    last_index = len(sentences) - 1
    middle_hits = []
    for index in range(1, last_index):
        sentence = sentences[index]
        if "？" in sentence or "?" in sentence or any(
            word in sentence for word in _SUMMARY_SIGNAL_WORDS
        ):
            middle_hits.append(index)

    picked_indexes = {0, last_index, *middle_hits[:2]}
    ordered = [sentences[index] for index in sorted(picked_indexes)]
    return compact_line("；".join(ordered), max_length=max_length)


def split_paragraph_chunks(text: str, *, min_chars: int = 80) -> list[dict[str, Any]]:
    """把正文按自然段切成段落块，返回 [{start_line, end_line, text}]。

    过短的段落（少于 min_chars 个中文字）并入前一段，避免碎片化降低召回质量。
    供向量检索的段落级 chunk 切分共用（write 兜底与 agent extract 两条路径），
    保持 commit 仍是唯一真源、投影只从 commit 重建。
    """
    lines = text.splitlines()
    paragraphs: list[dict[str, Any]] = []
    buffer: list[str] = []
    start_line = 1
    for line_no, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if stripped and not stripped.startswith("#"):
            if not buffer:
                start_line = line_no
            buffer.append(stripped)
        elif buffer:
            paragraphs.append(
                {"start_line": start_line, "end_line": line_no - 1, "text": "".join(buffer)}
            )
            buffer = []
    if buffer:
        paragraphs.append(
            {"start_line": start_line, "end_line": len(lines), "text": "".join(buffer)}
        )

    merged: list[dict[str, Any]] = []
    for para in paragraphs:
        if merged and count_chinese_chars(str(merged[-1]["text"])) < min_chars:
            merged[-1]["end_line"] = para["end_line"]
            merged[-1]["text"] = str(merged[-1]["text"]) + str(para["text"])
        else:
            merged.append(dict(para))
    return merged

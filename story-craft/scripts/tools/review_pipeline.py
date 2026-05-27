#!/usr/bin/env python3
"""Review report generation for story-craft."""

from __future__ import annotations

from typing import Any

from core.text_utils import count_chinese_chars
from core.types import NormalizedReviewerResult


def _issue_line(issue: Any) -> str:
    if isinstance(issue, dict):
        severity = issue.get("severity") or issue.get("level") or "unknown"
        category = issue.get("category") or "general"
        description = issue.get("description") or issue.get("message") or str(issue)
        location = issue.get("location")
        suffix = f"（{location}）" if location else ""
        return f"- [{severity}] {category}: {description}{suffix}"
    return f"- {issue}"


def build_review_report(
    chapter: int,
    review_results: NormalizedReviewerResult,
    chapter_text: str,
) -> str:
    """Convert normalized reviewer output to a Markdown report."""
    blockers = list(review_results.get("blockers") or [])
    warnings = list(review_results.get("warnings") or [])
    passed = not blockers
    word_count = count_chinese_chars(chapter_text)
    lines = [
        f"# 第{int(chapter):02d}章审查报告",
        "",
        "## 摘要",
        "",
        f"- 结果：{'通过' if passed else '未通过'}",
        f"- 阻断项：{len(blockers)}",
        f"- 警告项：{len(warnings)}",
        f"- 估算中文字符数：{word_count}",
        "",
        "## 阻断项",
        "",
    ]
    lines.extend([_issue_line(item) for item in blockers] or ["- 无"])
    lines.extend(["", "## 警告项", ""])
    lines.extend([_issue_line(item) for item in warnings] or ["- 无"])
    return "\n".join(lines) + "\n"

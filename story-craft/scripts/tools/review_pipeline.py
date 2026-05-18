#!/usr/bin/env python3
"""Review report generation for story-craft."""

from __future__ import annotations

from typing import Any

from core.text_utils import count_chinese_chars


def _issue_line(issue: Any) -> str:
    if isinstance(issue, dict):
        severity = issue.get("severity") or issue.get("level") or "unknown"
        category = issue.get("category") or "general"
        description = issue.get("description") or issue.get("message") or str(issue)
        location = issue.get("location")
        suffix = f"（{location}）" if location else ""
        return f"- [{severity}] {category}: {description}{suffix}"
    return f"- {issue}"


def _split_issues(review_results: dict) -> tuple[list[Any], list[Any]]:
    blockers = list(review_results.get("blockers") or [])
    warnings = list(review_results.get("warnings") or [])
    if blockers or warnings:
        return blockers, warnings

    for issue in review_results.get("issues") or []:
        if not isinstance(issue, dict):
            warnings.append(issue)
            continue
        severity = str(issue.get("severity") or "").lower()
        if issue.get("blocking") or severity in {"critical", "blocker"}:
            blockers.append(issue)
        else:
            warnings.append(issue)
    return blockers, warnings


def build_review_report(
    chapter: int,
    review_results: dict,
    chapter_text: str,
) -> str:
    """Convert structured reviewer output to a Markdown report."""
    blockers, warnings = _split_issues(review_results)
    passed = bool(review_results.get("passed", not blockers)) and not blockers
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
    if review_results.get("suggestions"):
        lines.extend(["", "## 修改建议", ""])
        lines.extend([_issue_line(item) for item in review_results["suggestions"]])
    return "\n".join(lines) + "\n"

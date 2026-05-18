#!/usr/bin/env python3
"""Placeholder scanner for draft text."""

from __future__ import annotations

import re


PLACEHOLDER_RE = re.compile(
    r"(\[(?:待定|待补充|TODO|TBD|XXX|FIXME)[^\]]*\]|\{[^{}\n]*(?:待定|TODO|TBD|XXX|FIXME)[^{}\n]*\})",
    re.IGNORECASE,
)


def _line_col(text: str, index: int) -> tuple[int, int]:
    line = text.count("\n", 0, index) + 1
    line_start = text.rfind("\n", 0, index) + 1
    return line, index - line_start + 1


def scan_placeholders(text: str) -> list[dict[str, str]]:
    """Scan text for obvious placeholders."""
    results: list[dict[str, str]] = []
    for match in PLACEHOLDER_RE.finditer(text or ""):
        start, end = match.span()
        line, col = _line_col(text, start)
        context_start = max(0, start - 30)
        context_end = min(len(text), end + 30)
        results.append(
            {
                "pattern": match.group(0),
                "location": f"第{line}行第{col}列",
                "context": text[context_start:context_end].replace("\n", " "),
            }
        )
    return results

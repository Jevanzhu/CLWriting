#!/usr/bin/env python3
"""Deterministic external story import parser."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from core.text_utils import count_chinese_chars


SUPPORTED_IMPORT_SUFFIXES = {".txt", ".md", ".docx"}
CHAPTER_HEADING_RE = re.compile(
    r"^\s*(?:#{1,3}\s*)?(第\s*[0-9零一二三四五六七八九十百千]+\s*[章节回卷集][^\n\r]*|Chapter\s+\d+[^\n\r]*)\s*$",
    re.IGNORECASE,
)


def parse_import_source(source: str | Path) -> dict[str, Any]:
    """Parse one file or a directory of external txt/md/docx files."""
    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(str(path))

    files = _collect_import_files(path)
    if not files:
        raise ValueError("未找到可导入的 txt/md/docx 文件")

    chapters: list[dict[str, Any]] = []
    for file_path in files:
        text = read_import_text(file_path)
        parsed = split_import_chapters(text, source_file=file_path)
        for chapter in parsed:
            chapter["chapter"] = len(chapters) + 1
            chapters.append(chapter)

    if not chapters:
        raise ValueError("导入文本未解析出章节")

    return {
        "ok": True,
        "source": str(path),
        "file_count": len(files),
        "chapter_count": len(chapters),
        "chapters": chapters,
        "next_steps": [
            "chapter-extractor 生成 accepted_events 与章节合同",
            "写入 chapter commit 真源后运行 rebuild-views",
            "人工确认参考拆解只保留 narrative_techniques/do_not_copy/differentiation",
        ],
    }


def read_import_text(path: str | Path) -> str:
    """Read supported import file as text."""
    file_path = Path(path).expanduser().resolve()
    suffix = file_path.suffix.lower()
    if suffix not in SUPPORTED_IMPORT_SUFFIXES:
        raise ValueError(f"不支持的导入格式：{suffix or '<none>'}")
    if suffix == ".docx":
        return _read_docx_text(file_path)
    return file_path.read_text(encoding="utf-8-sig")


def split_import_chapters(text: str, source_file: str | Path | None = None) -> list[dict[str, Any]]:
    """Split imported text into chapter records with stable metadata."""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    sections: list[tuple[str, list[str]]] = []
    current_title = ""
    current_lines: list[str] = []

    for line in normalized.splitlines():
        if CHAPTER_HEADING_RE.match(line):
            if current_lines or current_title:
                sections.append((current_title, current_lines))
            current_title = line.strip().lstrip("#").strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines or current_title:
        sections.append((current_title, current_lines))

    if not sections and normalized.strip():
        sections = [("", normalized.splitlines())]

    chapters = []
    for index, (title, lines) in enumerate(sections, start=1):
        body = "\n".join(lines).strip()
        if not body:
            continue
        chapter_title = title or f"导入章节{index:03d}"
        chapters.append(
            {
                "chapter": index,
                "title": chapter_title,
                "source_file": str(Path(source_file).resolve()) if source_file else "",
                "word_count": count_chinese_chars(body),
                "content_preview": _preview(body),
                "body": body,
            }
        )
    return chapters


def _collect_import_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(
        file_path
        for file_path in path.rglob("*")
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_IMPORT_SUFFIXES
    )


def _read_docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            payload = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError("docx 文件无法读取正文 document.xml") from exc

    root = ElementTree.fromstring(payload)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for paragraph in root.findall(".//w:p", namespace):
        texts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
        line = "".join(texts).strip()
        if line:
            paragraphs.append(line)
    return "\n".join(paragraphs)


def _preview(text: str, max_length: int = 120) -> str:
    compact = " ".join(str(text or "").split())
    return compact if len(compact) <= max_length else compact[: max_length - 1] + "…"

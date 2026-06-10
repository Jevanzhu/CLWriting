#!/usr/bin/env python3
"""Read-only chapter impact analysis."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core.commit_store import CommitStore
from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager


def analyze_chapter_impact(project_root: str | Path, chapter: int) -> dict[str, Any]:
    """Analyze which projected story records may be affected by changing a chapter."""
    config = StoryCraftConfig.from_project_root(project_root)
    commit_store = CommitStore(config)
    commit = commit_store.read(int(chapter))
    if not commit:
        return {
            "ok": False,
            "chapter": int(chapter),
            "blockers": [f"缺少第 {int(chapter):03d} 章 commit 真源。"],
            "next_steps": ["先完成该章验收，或确认章节号是否正确。"],
        }

    memory = MemoryManager(config).load()
    later_commits = [
        item for item in commit_store.iter_all() if int(item.get("chapter") or 0) > int(chapter)
    ]
    characters = _chapter_related_characters(commit, memory, int(chapter))
    character_details = _character_details(memory, characters)
    foreshadowing = _foreshadowing_impact(commit, memory, int(chapter))
    timeline = _timeline_impact(commit, memory, int(chapter))
    later_chapters = _later_chapters(
        later_commits,
        characters,
        character_details,
        foreshadowing["ids"],
        foreshadowing["items"],
    )

    warnings: list[str] = []
    if commit.get("status") != "accepted":
        warnings.append("目标章 commit 不是 accepted，影响分析只供定位问题。")
    if not later_chapters:
        warnings.append("当前未发现后续 commit 直接引用目标章角色或伏笔。")

    return {
        "ok": True,
        "chapter": int(chapter),
        "commit": {
            "title": str(commit.get("title") or ""),
            "status": str(commit.get("status") or ""),
            "word_count": int(commit.get("word_count") or 0),
            "summary": _commit_summary(commit),
            "dominant_strand": str(commit.get("dominant_strand") or ""),
        },
        "characters": characters,
        "character_details": character_details,
        "foreshadowing": {
            "planted": foreshadowing["planted"],
            "resolved": foreshadowing["resolved"],
            "related_open": foreshadowing["related_open"],
        },
        "timeline": timeline,
        "later_chapters": later_chapters,
        "suggested_checks": _suggested_checks(characters, foreshadowing, timeline, later_chapters),
        "warnings": warnings,
        "next_steps": [
            "修改目标章后重新运行 reviewer，并用 chapter-commit 重新写入 commit 真源。",
            "如影响后续章节，逐章复查 later_chapters 中列出的摘要和角色/伏笔引用。",
        ],
    }


def render_chapter_impact_markdown(payload: dict[str, Any]) -> str:
    """Render chapter impact analysis as a human-readable rewrite checklist."""
    chapter = int(payload.get("chapter") or 0)
    lines = [f"# 第{chapter:03d}章影响分析", ""]

    if not payload.get("ok"):
        lines.extend(_markdown_list_section("阻断", payload.get("blockers", []) or ["影响分析不可用。"]))
        lines.extend(_markdown_list_section("下一步", payload.get("next_steps", [])))
        return "\n".join(lines).rstrip() + "\n"

    commit = payload.get("commit") if isinstance(payload.get("commit"), dict) else {}
    lines.extend(
        [
            "## 目标章",
            f"- 标题：{_display(commit.get('title'))}",
            f"- 状态：{_display(commit.get('status'))}",
            f"- 字数：{int(commit.get('word_count') or 0)}",
            f"- 摘要：{_display(commit.get('summary'))}",
            f"- 主导叙事线：{_display(commit.get('dominant_strand'))}",
            "",
        ]
    )

    lines.extend(_character_markdown(payload.get("characters", []), payload.get("character_details", [])))
    lines.extend(_foreshadowing_markdown(payload.get("foreshadowing", {})))
    lines.extend(_timeline_markdown(payload.get("timeline", {})))
    lines.extend(_later_chapters_markdown(payload.get("later_chapters", [])))
    lines.extend(_checklist_markdown(payload.get("suggested_checks", [])))
    lines.extend(_markdown_list_section("警告", payload.get("warnings", [])))
    lines.extend(_markdown_list_section("下一步", payload.get("next_steps", [])))
    return "\n".join(lines).rstrip() + "\n"


def _character_markdown(characters: Any, details: Any) -> list[str]:
    lines = ["## 相关角色"]
    if not isinstance(characters, list) or not characters:
        return lines + ["- 未发现直接相关角色。", ""]

    detail_lookup: dict[str, dict[str, Any]] = {}
    if isinstance(details, list):
        for detail in details:
            if not isinstance(detail, dict):
                continue
            for key in (detail.get("id"), detail.get("name")):
                if key:
                    detail_lookup[str(key)] = detail

    for character in characters:
        character_id = str(character or "")
        detail = detail_lookup.get(character_id, {})
        name = str(detail.get("name") or "")
        label = f"{character_id}（{name}）" if name and name != character_id else character_id
        extra = _join_non_empty(
            [
                f"身份：{detail.get('role')}" if detail.get("role") else "",
                f"层级：{detail.get('tier')}" if detail.get("tier") else "",
                _appearance_range(detail),
                f"状态：{detail.get('current_status')}" if detail.get("current_status") else "",
            ]
        )
        lines.append(f"- {label}" + (f"；{extra}" if extra else ""))
    return lines + [""]


def _appearance_range(detail: dict[str, Any]) -> str:
    first = detail.get("first_appearance_chapter")
    last = detail.get("last_appearance_chapter")
    if first and last:
        return f"出场：第{int(first):03d}章-第{int(last):03d}章"
    if first:
        return f"首次出场：第{int(first):03d}章"
    if last:
        return f"最近出场：第{int(last):03d}章"
    return ""


def _foreshadowing_markdown(foreshadowing: Any) -> list[str]:
    lines = ["## 伏笔影响"]
    if not isinstance(foreshadowing, dict):
        return lines + ["- 未发现相关伏笔。", ""]

    sections = (
        ("本章埋设", foreshadowing.get("planted", [])),
        ("本章回收", foreshadowing.get("resolved", [])),
        ("仍未回收", foreshadowing.get("related_open", [])),
    )
    has_items = False
    for title, items in sections:
        rows = items if isinstance(items, list) else []
        if not rows:
            continue
        has_items = True
        lines.append(f"- {title}：")
        for item in rows:
            if not isinstance(item, dict):
                continue
            suffix = _join_non_empty(
                [
                    f"状态：{item.get('status')}" if item.get("status") else "",
                    f"紧急度：{item.get('urgency')}" if item.get("urgency") else "",
                    (
                        f"计划第{int(item['planned_resolution_chapter']):03d}章回收"
                        if item.get("planned_resolution_chapter")
                        else ""
                    ),
                    (
                        f"已在第{int(item['resolved_chapter']):03d}章回收"
                        if item.get("resolved_chapter")
                        else ""
                    ),
                ]
            )
            content = _display(item.get("content"))
            lines.append(f"  - {item.get('id') or 'unknown'}：{content}" + (f"；{suffix}" if suffix else ""))
    if not has_items:
        lines.append("- 未发现相关伏笔。")
    return lines + [""]


def _timeline_markdown(timeline: Any) -> list[str]:
    lines = ["## 时间线"]
    if not isinstance(timeline, dict):
        return lines + ["- 未发现时间线记录。", ""]

    commit_entry = timeline.get("commit_entry") if isinstance(timeline.get("commit_entry"), dict) else {}
    projected_entries = timeline.get("projected_entries") if isinstance(timeline.get("projected_entries"), list) else []
    if not commit_entry and not projected_entries:
        return lines + ["- 未发现时间线记录。", ""]
    if commit_entry:
        lines.append(f"- commit：{_timeline_entry_label(commit_entry)}")
    for entry in projected_entries:
        if isinstance(entry, dict):
            lines.append(f"- memory：{_timeline_entry_label(entry)}")
    return lines + [""]


def _timeline_entry_label(entry: dict[str, Any]) -> str:
    events = entry.get("events")
    if isinstance(events, list):
        events_text = "、".join(str(item) for item in events if item)
    else:
        events_text = str(events or "")
    parts = [
        f"第{int(entry.get('chapter') or 0):03d}章" if entry.get("chapter") else "",
        str(entry.get("time_marker") or ""),
        str(entry.get("location") or ""),
        events_text,
    ]
    return _join_non_empty(parts, separator=" / ") or "未记录细节"


def _later_chapters_markdown(later_chapters: Any) -> list[str]:
    lines = ["## 后续章节引用"]
    rows = later_chapters if isinstance(later_chapters, list) else []
    if not rows:
        return lines + ["- 未发现后续 commit 直接引用目标章角色或伏笔。", ""]
    for row in rows:
        if not isinstance(row, dict):
            continue
        matched_characters = [str(item) for item in row.get("matched_characters", []) or []]
        matched_foreshadowing = [str(item) for item in row.get("matched_foreshadowing", []) or []]
        matches = _join_non_empty(
            [
                "角色 " + "、".join(matched_characters) if matched_characters else "",
                "伏笔 " + "、".join(matched_foreshadowing) if matched_foreshadowing else "",
            ]
        )
        summary = _display(row.get("summary"))
        lines.append(
            f"- 第{int(row.get('chapter') or 0):03d}章《{_display(row.get('title'))}》："
            f"{summary}" + (f"；命中：{matches}" if matches else "")
        )
    return lines + [""]


def _checklist_markdown(checks: Any) -> list[str]:
    rows = checks if isinstance(checks, list) else []
    if not rows:
        rows = ["复查本章 summary、timeline_entry 和 accepted_events 是否仍成立。"]
    return ["## 改稿复查清单"] + [f"- [ ] {item}" for item in rows if item] + [""]


def _markdown_list_section(title: str, items: Any) -> list[str]:
    rows = items if isinstance(items, list) else []
    if not rows:
        return []
    return [f"## {title}"] + [f"- {item}" for item in rows if item] + [""]


def _join_non_empty(values: list[str], *, separator: str = "；") -> str:
    return separator.join(str(value).strip() for value in values if str(value or "").strip())


def _display(value: Any) -> str:
    text = str(value or "").strip()
    return text if text else "未记录"


def _commit_summary(commit: dict[str, Any]) -> str:
    chapter_summary = commit.get("chapter_summary") if isinstance(commit.get("chapter_summary"), dict) else {}
    return str(
        chapter_summary.get("summary")
        or commit.get("summary_text")
        or commit.get("summary")
        or ""
    )


def _commit_characters(commit: dict[str, Any]) -> list[str]:
    values: list[str] = []
    values.extend(str(item) for item in commit.get("entities_appeared", []) or [] if item)
    chapter_summary = commit.get("chapter_summary")
    if isinstance(chapter_summary, dict):
        values.extend(str(item) for item in chapter_summary.get("characters_appeared", []) or [] if item)
    for scene in commit.get("scenes", []) or []:
        if isinstance(scene, dict):
            values.extend(str(item) for item in scene.get("characters", []) or [] if item)
    for event in commit.get("accepted_events", []) or []:
        if not isinstance(event, dict):
            continue
        for key in ("entity_id", "target_id"):
            if event.get(key):
                values.append(str(event[key]))
        payload = event.get("payload")
        if isinstance(payload, dict):
            for key in ("id", "name", "entity_id", "target_id"):
                if payload.get(key):
                    values.append(str(payload[key]))
    return values


def _chapter_related_characters(
    commit: dict[str, Any],
    memory: dict[str, Any],
    chapter: int,
) -> list[str]:
    """Merge commit entities with memory projection ranges for older commits."""
    direct = _unique(_commit_characters(commit))
    direct_lookup = set(direct)
    related: list[str] = list(direct)

    for summary in memory.get("chapter_summaries", []) or []:
        if not isinstance(summary, dict) or _as_int(summary.get("chapter")) != chapter:
            continue
        related.extend(str(item) for item in summary.get("characters_appeared", []) or [] if item)

    for char in memory.get("characters", []) or []:
        if not isinstance(char, dict):
            continue
        aliases = _character_aliases(char)
        identifier = aliases[0] if aliases else ""
        if not identifier:
            continue
        first = _as_int(char.get("first_appearance_chapter"))
        last = _as_int(char.get("last_appearance_chapter"))
        if any(alias in direct_lookup for alias in aliases) or _chapter_hits_range(chapter, first, last):
            related.append(identifier)
    return _unique(related)


def _character_details(memory: dict[str, Any], characters: list[str]) -> list[dict[str, Any]]:
    lookup = set(characters)
    details: list[dict[str, Any]] = []
    for char in memory.get("characters", []) or []:
        if not isinstance(char, dict):
            continue
        aliases = _character_aliases(char)
        if not any(alias in lookup for alias in aliases):
            continue
        details.append(
            {
                "id": str(char.get("id") or char.get("name") or ""),
                "name": str(char.get("name") or ""),
                "role": str(char.get("role") or ""),
                "tier": str(char.get("tier") or ""),
                "first_appearance_chapter": _as_int(char.get("first_appearance_chapter")),
                "last_appearance_chapter": _as_int(char.get("last_appearance_chapter")),
                "current_status": str(char.get("current_status") or ""),
            }
        )
    return details


def _character_aliases(char: dict[str, Any]) -> list[str]:
    return _unique(
        [
            str(char.get("id") or ""),
            str(char.get("suggested_id") or ""),
            str(char.get("name") or ""),
        ]
    )


def _chapter_hits_range(chapter: int, first: int | None, last: int | None) -> bool:
    if first == chapter or last == chapter:
        return True
    if first is not None and last is not None:
        return first <= chapter <= last
    return False


def _foreshadowing_impact(
    commit: dict[str, Any],
    memory: dict[str, Any],
    chapter: int,
) -> dict[str, Any]:
    planted: list[dict[str, Any]] = []
    resolved: list[dict[str, Any]] = []
    ids: list[str] = []
    for event in commit.get("accepted_events", []) or []:
        if not isinstance(event, dict):
            continue
        event_type = event.get("event_type")
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event_type == "open_loop_created":
            planted.append(_foreshadowing_item(payload))
            if payload.get("id"):
                ids.append(str(payload["id"]))
        elif event_type == "open_loop_closed":
            resolved.append(_foreshadowing_item(payload))
            if payload.get("id"):
                ids.append(str(payload["id"]))

    related_open: list[dict[str, Any]] = []
    for item in memory.get("foreshadowing", []) or []:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "")
        planted_chapter = _as_int(item.get("planted_chapter"))
        resolved_chapter = _as_int(item.get("resolved_chapter"))
        if item_id in ids or planted_chapter == chapter or resolved_chapter == chapter:
            normalized = _foreshadowing_item(item)
            if planted_chapter == chapter:
                planted.append(normalized)
            if resolved_chapter == chapter:
                resolved.append(normalized)
            if item.get("status") != "resolved":
                related_open.append(normalized)
            if item_id and item_id not in ids:
                ids.append(item_id)
    return {
        "planted": _unique_dicts(planted),
        "resolved": _unique_dicts(resolved),
        "related_open": _unique_dicts(related_open),
        "ids": _unique(ids),
        "items": _unique_dicts(planted + resolved + related_open),
    }


def _foreshadowing_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or ""),
        "content": str(item.get("content") or item.get("title") or ""),
        "status": str(item.get("status") or ""),
        "urgency": str(item.get("urgency") or ""),
        "planned_resolution_chapter": _as_int(item.get("planned_resolution_chapter")),
        "resolved_chapter": _as_int(item.get("resolved_chapter")),
    }


def _timeline_impact(commit: dict[str, Any], memory: dict[str, Any], chapter: int) -> dict[str, Any]:
    commit_entry = commit.get("timeline_entry") if isinstance(commit.get("timeline_entry"), dict) else {}
    projected = [
        item
        for item in memory.get("timeline", []) or []
        if isinstance(item, dict) and _as_int(item.get("chapter")) == chapter
    ]
    return {
        "commit_entry": commit_entry,
        "projected_entries": projected,
    }


def _later_chapters(
    later_commits: list[dict[str, Any]],
    characters: list[str],
    character_details: list[dict[str, Any]],
    foreshadowing_ids: list[str],
    foreshadowing_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for commit in later_commits:
        search_text = _commit_search_text(commit)
        matched_characters = _matched_characters(commit, search_text, characters, character_details)
        matched_loops = _matched_foreshadowing(
            commit,
            search_text,
            foreshadowing_ids,
            foreshadowing_items,
        )
        if not matched_characters and not matched_loops:
            continue
        rows.append(
            {
                "chapter": int(commit.get("chapter") or 0),
                "title": str(commit.get("title") or ""),
                "summary": _commit_summary(commit),
                "matched_characters": matched_characters,
                "matched_foreshadowing": matched_loops,
            }
        )
    return rows


def _matched_characters(
    commit: dict[str, Any],
    search_text: str,
    characters: list[str],
    character_details: list[dict[str, Any]],
) -> list[str]:
    matched = set(_commit_characters(commit)).intersection(characters)
    for detail in character_details:
        identifier = str(detail.get("id") or detail.get("name") or "")
        if not identifier:
            continue
        for token in (identifier, str(detail.get("name") or "")):
            if token and token in search_text:
                matched.add(identifier)
    return sorted(matched)


def _matched_foreshadowing(
    commit: dict[str, Any],
    search_text: str,
    foreshadowing_ids: list[str],
    foreshadowing_items: list[dict[str, Any]],
) -> list[str]:
    matched = set(_commit_foreshadowing_ids(commit)).intersection(foreshadowing_ids)
    for item in foreshadowing_items:
        item_id = str(item.get("id") or "")
        if not item_id:
            continue
        content = str(item.get("content") or "")
        if item_id in search_text or _rough_text_hit(content, search_text):
            matched.add(item_id)
    return sorted(matched)


def _commit_foreshadowing_ids(commit: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for event in commit.get("accepted_events", []) or []:
        if not isinstance(event, dict):
            continue
        payload = event.get("payload")
        if isinstance(payload, dict) and payload.get("id"):
            ids.append(str(payload["id"]))
    return ids


def _commit_search_text(commit: dict[str, Any]) -> str:
    parts = [
        str(commit.get("title") or ""),
        _commit_summary(commit),
        _stringify(commit.get("chapter_summary")),
        _stringify(commit.get("timeline_entry")),
        _stringify(commit.get("scenes")),
        _stringify(commit.get("accepted_events")),
    ]
    return "\n".join(part for part in parts if part)


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return "\n".join(_stringify(item) for item in value.values())
    if isinstance(value, list):
        return "\n".join(_stringify(item) for item in value)
    return str(value)


def _rough_text_hit(needle: str, haystack: str) -> bool:
    needle = str(needle or "").strip()
    haystack = str(haystack or "")
    if not needle or not haystack:
        return False
    if needle in haystack:
        return True
    chars = {char for char in needle if not char.isspace()}
    if len(chars) < 4:
        return False
    overlap = len(chars.intersection(set(haystack)))
    return overlap >= 4 and overlap / max(1, len(chars)) >= 0.45


def _suggested_checks(
    characters: list[str],
    foreshadowing: dict[str, Any],
    timeline: dict[str, Any],
    later_chapters: list[dict[str, Any]],
) -> list[str]:
    checks = ["复查本章 summary、timeline_entry 和 accepted_events 是否仍成立。"]
    if characters:
        checks.append("复查相关角色状态、关系和后续出场是否需要同步。")
    if foreshadowing["planted"] or foreshadowing["resolved"] or foreshadowing["related_open"]:
        checks.append("复查伏笔的埋设、回收章节和紧急度是否需要更新。")
    if timeline.get("commit_entry") or timeline.get("projected_entries"):
        checks.append("复查时间线顺序、地点和时间标记是否与后续章节一致。")
    if later_chapters:
        checks.append("优先复查 later_chapters 中列出的后续章节。")
    return checks


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        value = str(value or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _unique_dicts(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in values:
        key = str(item.get("id") or item)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

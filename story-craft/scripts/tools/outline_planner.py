#!/usr/bin/env python3
"""Deterministic outline planning for story-craft projects."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.memory_manager import MemoryManager
from core.state_manager import StateManager
from core.text_utils import compact_line


REQUIRED_SETTING_FILES = (
    "世界观.md",
    "主角卡.md",
    "独特优势.md",
)


SEGMENT_NAMES = ("开篇段", "发展段", "高潮段", "结尾段")


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _choose_chapter_count(word_count_target: int) -> int:
    target = int(word_count_target or 0)
    if target <= 30000:
        return _clamp(round(target / 2500), 8, 12)
    if target <= 50000:
        return _clamp(round(target / 3000), 12, 18)
    return _clamp(round(target / 3500), 18, 30)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _main_character(memory: dict[str, Any]) -> str:
    for character in memory.get("characters", []):
        if character.get("role") == "protagonist":
            return str(character.get("name") or "主角")
    return "主角"


def _segment_for_chapter(chapter: int, chapter_count: int) -> str:
    ratio = chapter / max(chapter_count, 1)
    if ratio <= 0.25:
        return SEGMENT_NAMES[0]
    if ratio <= 0.5:
        return SEGMENT_NAMES[1]
    if ratio <= 0.75:
        return SEGMENT_NAMES[2]
    return SEGMENT_NAMES[3]


def _segment_intent(segment: str) -> str:
    return {
        "开篇段": "建立人物处境、核心异常和主线承诺",
        "发展段": "放大阻力，推动角色付出代价并埋下关键伏笔",
        "高潮段": "让线索集中碰撞，暴露真相前的最大误判",
        "结尾段": "回收伏笔，完成选择、反转或情绪落点",
    }[segment]


def _hook_type(segment: str) -> str:
    return {
        "开篇段": "异常钩",
        "发展段": "压力钩",
        "高潮段": "真相钩",
        "结尾段": "回收钩",
    }[segment]


def _build_chapter_plan(
    *,
    chapter: int,
    chapter_count: int,
    words_per_chapter: int,
    protagonist: str,
    genre: str,
    ending_constraint: str,
) -> dict[str, Any]:
    segment = _segment_for_chapter(chapter, chapter_count)
    is_last = chapter == chapter_count
    is_mid = chapter == max(1, round(chapter_count / 2))
    if chapter == 1:
        title = "开篇异常"
        goal = f"让{protagonist}遇到无法忽视的{genre}异常，明确主线问题。"
        conflict = "日常秩序与异常证据正面冲突。"
        foreshadowing = "埋设核心谜面或情绪债。"
    elif is_mid:
        title = "中点误判"
        goal = "让已知线索发生反转，迫使主角改变行动策略。"
        conflict = "主角原有判断被事实击穿。"
        foreshadowing = "回收早期线索的一半，留下更深层问题。"
    elif is_last:
        title = "终局回收"
        goal = ending_constraint or "完成主线选择，并兑现开篇承诺。"
        conflict = "真相、代价与角色欲望同时抵达临界点。"
        foreshadowing = "回收核心伏笔并保留必要余韵。"
    else:
        title = f"{segment}推进"
        goal = _segment_intent(segment)
        conflict = f"{protagonist}的主动行动遭遇新的信息阻力。"
        foreshadowing = "新增或推进一条可在后续回收的线索。"

    return {
        "chapter": chapter,
        "title": title,
        "segment": segment,
        "target_words": words_per_chapter,
        "goal": goal,
        "conflict": conflict,
        "characters": [protagonist],
        "time_marker": f"故事时间线节点 {chapter}",
        "foreshadowing": foreshadowing,
        "hook_type": _hook_type(segment),
    }


def _build_outline_markdown(
    *,
    state: dict[str, Any],
    memory: dict[str, Any],
    world_text: str,
    protagonist_text: str,
    unique_advantage_text: str,
    chapter_plans: list[dict[str, Any]],
) -> str:
    project = state["project"]
    constraints = state.get("creative_constraints", {})
    title = project.get("title") or "未命名故事"
    genre = project.get("genre") or "未定题材"
    target = int(project.get("word_count_target") or 0)
    protagonist = _main_character(memory)
    total_planned_words = sum(item["target_words"] for item in chapter_plans)
    mid_chapter = max(1, round(len(chapter_plans) / 2))

    lines = [
        f"# {title}",
        "",
        "## 一句话梗概",
        "",
        constraints.get("one_liner") or "围绕主角的核心处境展开短篇/中篇故事。",
        "",
        "## 规划摘要",
        "",
        f"- 题材：{genre}",
        f"- 目标字数：{target}",
        f"- 预计章数：{len(chapter_plans)}",
        f"- 规划总字数：{total_planned_words}",
        f"- 主角：{protagonist}",
        "",
        "## 设定基线",
        "",
        f"- 世界观依据：{compact_line(world_text, max_length=80, fallback='未补充')}",
        f"- 主角依据：{compact_line(protagonist_text, max_length=80, fallback='未补充')}",
        f"- 独特优势依据：{compact_line(unique_advantage_text, max_length=80, fallback='未补充')}",
        "",
        "## 分段结构",
        "",
    ]
    for segment in SEGMENT_NAMES:
        chapters = [item for item in chapter_plans if item["segment"] == segment]
        if not chapters:
            continue
        first = chapters[0]["chapter"]
        last = chapters[-1]["chapter"]
        words = sum(item["target_words"] for item in chapters)
        lines.extend(
            [
                f"### {segment}（第{first:02d}-{last:02d}章，约{words}字）",
                "",
                _segment_intent(segment),
                "",
            ]
        )

    lines.extend(
        [
            "## 时间线主干",
            "",
            f"- 第01章：开篇时间锚点，抛出异常与主线承诺。",
            f"- 第{mid_chapter:02d}章：中点转折，旧判断失效。",
            f"- 第{max(1, len(chapter_plans) - 1):02d}章：高潮前压迫，所有线索逼近答案。",
            f"- 第{len(chapter_plans):02d}章：结尾回收，完成代价、选择和情绪落点。",
            "",
            "## 章节大纲",
            "",
        ]
    )

    for item in chapter_plans:
        lines.extend(
            [
                f"### 第{item['chapter']:02d}章 {item['title']}",
                "",
                f"- 所属段落：{item['segment']}",
                f"- 预计字数：{item['target_words']}",
                f"- 本章目标：{item['goal']}",
                f"- 核心冲突：{item['conflict']}",
                f"- 角色出场：{'、'.join(item['characters'])}",
                f"- 时间锚点：{item['time_marker']}",
                f"- 伏笔计划：{item['foreshadowing']}",
                f"- 章末钩子类型：{item['hook_type']}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _update_memory_plan(
    *,
    config: StoryCraftConfig,
    memory: dict[str, Any],
    chapter_plans: list[dict[str, Any]],
    world_text: str,
) -> None:
    existing_timeline = [
        item for item in memory.get("timeline", []) if not item.get("planned")
    ]
    planned_timeline = [
        {
            "chapter": item["chapter"],
            "time_marker": item["time_marker"],
            "events": [item["goal"]],
            "planned": True,
            "segment": item["segment"],
        }
        for item in chapter_plans
    ]
    memory["timeline"] = existing_timeline + planned_timeline
    memory.setdefault("world_rules", [])
    if world_text and not any(rule.get("id") == "wr_story_baseline" for rule in memory["world_rules"]):
        memory["world_rules"].append(
            {
                "id": "wr_story_baseline",
                "rule": compact_line(world_text, max_length=120, fallback="未补充"),
                "source": "story-plan",
            }
        )
    MemoryManager(config).save(memory)


def plan_story(
    project_root: str | Path,
    *,
    chapter_count: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Generate a story-level outline and update planning metadata."""
    config = StoryCraftConfig.from_project_root(project_root)
    state_manager = StateManager(config)
    memory_manager = MemoryManager(config)
    state = state_manager.get_full_state()
    memory = memory_manager.load()

    blockers: list[str] = []
    if not config.state_file.exists():
        blockers.append("缺少 .story/state.json")
    if not config.memory_file.exists():
        blockers.append("缺少 .story/memory.json")
    for filename in REQUIRED_SETTING_FILES:
        path = config.settings_dir / filename
        if not path.exists():
            blockers.append(f"缺少设定文件：设定集/{filename}")

    project = state.get("project", {})
    if not project.get("title"):
        blockers.append("state.project.title 为空")
    if not project.get("genre"):
        blockers.append("state.project.genre 为空")
    if not int(project.get("word_count_target") or 0):
        blockers.append("state.project.word_count_target 为空")

    if blockers:
        return {"ok": False, "blockers": blockers, "warnings": []}

    world_text = _read_text(config.settings_dir / "世界观.md")
    protagonist_text = _read_text(config.settings_dir / "主角卡.md")
    unique_advantage_text = _read_text(config.settings_dir / "独特优势.md")
    target = int(project.get("word_count_target") or 0)
    chosen_chapters = int(chapter_count or _choose_chapter_count(target))
    chosen_chapters = _clamp(chosen_chapters, 1, 30)
    words_per_chapter = max(800, round(target / chosen_chapters))
    protagonist = _main_character(memory)
    genre = str(project.get("genre") or "未定题材")
    ending_constraint = str(
        state.get("creative_constraints", {}).get("ending_constraint") or ""
    )
    chapter_plans = [
        _build_chapter_plan(
            chapter=index,
            chapter_count=chosen_chapters,
            words_per_chapter=words_per_chapter,
            protagonist=protagonist,
            genre=genre,
            ending_constraint=ending_constraint,
        )
        for index in range(1, chosen_chapters + 1)
    ]
    outline = _build_outline_markdown(
        state=state,
        memory=memory,
        world_text=world_text,
        protagonist_text=protagonist_text,
        unique_advantage_text=unique_advantage_text,
        chapter_plans=chapter_plans,
    )
    total_planned_words = sum(item["target_words"] for item in chapter_plans)
    warnings: list[str] = []
    if total_planned_words > int(target * 1.1):
        warnings.append("规划总字数超过目标字数 110%，建议减少章数或单章字数。")

    if not dry_run:
        _write_text(config.outline_dir / "总纲.md", outline)
        _update_memory_plan(
            config=config,
            memory=memory,
            chapter_plans=chapter_plans,
            world_text=world_text,
        )
        state_manager.update_progress(phase="plan")
        state_manager.mark_file_generated("outline")
        state_manager.flush()

    return {
        "ok": True,
        "outline_file": str(config.outline_dir / "总纲.md"),
        "chapter_count": chosen_chapters,
        "target_words": target,
        "planned_words": total_planned_words,
        "dry_run": dry_run,
        "warnings": warnings,
        "next": "story-write",
    }

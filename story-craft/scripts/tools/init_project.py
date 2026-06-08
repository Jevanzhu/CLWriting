#!/usr/bin/env python3
"""Project initialization for story-craft."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from core.config import StoryCraftConfig
from core.contract_store import ContractStore
from core.memory_manager import default_memory
from core.security_utils import atomic_write_json
from core.state_manager import default_state
from core.time_utils import now_utc_iso


def _write_text_if_missing(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8")


def init_project(
    project_root: str | Path,
    title: str,
    genre: str,
    *,
    word_count_target: int = 30000,
    sub_genre: Optional[str] = None,
    synopsis: str = "",
    protagonist_name: str = "",
    protagonist_desire: str = "",
    protagonist_flaw: str = "",
    unique_advantage_type: str = "",
    unique_advantage_desc: str = "",
    unique_advantage_style: str = "",
    unique_advantage_visibility: str = "",
    unique_advantage_cost: str = "",
    golden_finger: str = "",
    antagonist_mirror: str = "",
    world_setting: str = "",
    narrative_meta: Optional[dict[str, Any]] = None,
    creative_constraints: Optional[dict[str, Any]] = None,
    project_type: Optional[str] = None,
) -> dict[str, Any]:
    """Initialize a story-craft project directory."""
    root = Path(project_root).expanduser().resolve()
    config = StoryCraftConfig.from_project_root(root)
    config.ensure_dirs()

    state = default_state(
        title=title,
        genre=genre,
        sub_genre=sub_genre,
        word_count_target=word_count_target,
    )
    if creative_constraints:
        state["creative_constraints"].update(creative_constraints)
    if narrative_meta:
        state["narrative_meta"].update(narrative_meta)
    state["creative_constraints"]["one_liner"] = (
        state["creative_constraints"].get("one_liner") or synopsis
    )
    state["creative_constraints"]["protagonist_flaw"] = (
        state["creative_constraints"].get("protagonist_flaw") or protagonist_flaw
    )
    state["creative_constraints"]["antagonist_mirror"] = (
        state["creative_constraints"].get("antagonist_mirror") or antagonist_mirror
    )

    state["generated_files"].update(
        {
            "outline": True,
            "worldbuilding": True,
            "protagonist_card": True,
            "antagonist_design": bool(antagonist_mirror),
            "unique_advantage": True,
            "golden_finger": bool(golden_finger),
        }
    )

    memory = default_memory()
    if protagonist_name:
        memory["characters"].append(
            {
                "id": "char_protagonist",
                "name": protagonist_name,
                "type": "角色",
                "role": "protagonist",
                "tier": "核心",
                "description": "",
                "traits": [],
                "unique_advantage": {
                    "type": unique_advantage_type,
                    "description": unique_advantage_desc,
                    "style": unique_advantage_style,
                    "visibility": unique_advantage_visibility,
                    "cost": unique_advantage_cost,
                },
                "golden_finger": golden_finger,
                "current_status": "初始化阶段",
                "emotional_state": "",
                "relationships": [],
                "first_appearance_chapter": 0,
                "last_appearance_chapter": 0,
            }
        )

    atomic_write_json(config.state_file, state, use_lock=True, backup=False)
    atomic_write_json(config.memory_file, memory, use_lock=True, backup=False)
    atomic_write_json(config.learning_file, {"patterns": []}, use_lock=True, backup=False)
    master_file = None
    if project_type:
        timestamp = now_utc_iso()
        master_file = ContractStore(config).write_master(
            {
                "contract_version": "story-craft/contract-v1",
                "project_type": project_type,
                "title": title,
                "genre": genre,
                "sub_genre": sub_genre or "",
                "word_count_target": word_count_target,
                "one_liner": synopsis,
                "protagonist": {
                    "name": protagonist_name,
                    "desire": protagonist_desire,
                    "flaw": protagonist_flaw,
                },
                "antagonist_mirror": antagonist_mirror,
                "unique_advantage": {
                    "type": unique_advantage_type,
                    "description": unique_advantage_desc,
                    "style": unique_advantage_style,
                    "visibility": unique_advantage_visibility,
                    "cost": unique_advantage_cost,
                },
                "route": "init",
                "reasoning": "created by init --project-type",
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        )

    _write_text_if_missing(
        config.outline_dir / "总纲.md",
        f"# {title}\n\n## 一句话梗概\n\n{synopsis or '（待补充）'}\n\n## 分段结构\n\n（待规划）\n",
    )
    _write_text_if_missing(
        config.settings_dir / "世界观.md",
        f"# 世界观\n\n## 题材\n\n{genre}\n\n## 核心设定\n\n{world_setting or '（待补充）'}\n",
    )
    _write_text_if_missing(
        config.settings_dir / "主角卡.md",
        f"# 主角卡\n\n- 姓名：{protagonist_name or '（待补充）'}\n- 欲望：{protagonist_desire or '（待补充）'}\n- 缺陷：{protagonist_flaw or '（待补充）'}\n",
    )
    _write_text_if_missing(
        config.settings_dir / "独特优势.md",
        "\n".join(
            [
                "# 独特优势",
                "",
                f"- 类型：{unique_advantage_type or '（待补充）'}",
                f"- 描述：{unique_advantage_desc or '（待补充）'}",
                f"- 风格：{unique_advantage_style or '（待补充）'}",
                f"- 可见度：{unique_advantage_visibility or '（待补充）'}",
                f"- 代价或限制：{unique_advantage_cost or '（待补充）'}",
                "",
            ]
        ),
    )
    if golden_finger:
        _write_text_if_missing(
            config.settings_dir / "金手指.md",
            f"# 金手指\n\n{golden_finger}\n",
        )
    if antagonist_mirror:
        _write_text_if_missing(
            config.settings_dir / "反派设计.md",
            f"# 反派设计\n\n## 镜像关系\n\n{antagonist_mirror}\n",
        )

    return {
        "project_root": str(root),
        "state_file": str(config.state_file),
        "memory_file": str(config.memory_file),
        "learning_file": str(config.learning_file),
        "master_file": str(master_file) if master_file else None,
    }

#!/usr/bin/env python3
"""Internal CLI entrypoint for story-craft."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from cli.cli_args import build_parser
from cli.cli_output import print_error, print_info, print_json, print_kv
from core.context_manager import ContextManager
from core.event_projection_router import EventProjectionRouter
from core.memory_index import MemoryIndexService
from core.memory_manager import MemoryManager
from core.project_locator import (
    locate_project_root,
    resolve_project_root,
    write_current_project_pointer,
)
from core.runtime_compat import enable_windows_utf8_stdio
from core.security_utils import AtomicWriteError, atomic_write_text
from core.log import setup_logging
from tools.genre_profile_builder import list_all_genres
from tools.init_project import init_project
from tools.agent_workflow import (
    build_extraction_delta,
    build_polish_plan,
    build_repair_plan,
    build_workflow_workspace,
    build_writing_brief,
    normalize_reviewer_output,
)
from tools.backup_manager import BackupManager
from tools.chapter_workflow import record_chapter_workflow
from tools.context_ranker import rank_context_items
from tools.deslop_metrics import analyze_deslop_metrics
from tools.entity_linker import build_entity_graph
from tools.import_parser import parse_import_source
from tools.outline_planner import plan_story
from tools.outline_reviser import OutlineReviser
from tools.placeholder_scanner import scan_placeholders
from tools.project_memory import append_learning_pattern, get_learning_patterns
from tools.quality_trend_report import QualityTrendReporter
from tools.repair_strength import build_repair_workflow
from tools.review_pipeline import build_review_report
from tools.status_reporter import StatusReporter
from tools.story_runtime_health import StoryRuntimeHealth


def _script_root() -> Path:
    return Path(__file__).resolve().parent


def _plugin_root() -> Path:
    return _script_root().parent


def cmd_where(args) -> int:
    root = resolve_project_root(
        args.project_root,
        cwd=Path.cwd(),
        allow_fallback=True,
    )
    print(root)
    return 0


def cmd_preflight(args) -> int:
    plugin_root = _plugin_root()
    scripts_dir = _script_root()

    project_root = None
    project_source = None
    project_exists = False
    error = None
    try:
        project_root, project_source = locate_project_root(
            args.project_root,
            cwd=Path.cwd(),
            allow_fallback=True,
        )
        project_exists = (project_root / ".story" / "state.json").is_file()
    except FileNotFoundError as exc:
        error = str(exc)

    payload = {
        "ok": error is None,
        "cwd": str(Path.cwd().resolve()),
        "plugin_root": str(plugin_root),
        "scripts_dir": str(scripts_dir),
        "project_root": str(project_root) if project_root else None,
        "project_source": project_source,
        "project_exists": project_exists,
        "error": error,
    }

    if args.format == "json":
        print_json(payload)
    else:
        print_kv(
            (
                ("ok", payload["ok"]),
                ("cwd", payload["cwd"]),
                ("plugin_root", payload["plugin_root"]),
                ("scripts_dir", payload["scripts_dir"]),
                ("project_root", payload["project_root"]),
                ("project_source", payload["project_source"]),
                ("project_exists", payload["project_exists"]),
            )
        )
        if payload["error"]:
            print_error(payload["error"])
    return 0 if error is None else 1


def cmd_use(args) -> int:
    target = Path(args.target).expanduser().resolve()
    try:
        pointer = write_current_project_pointer(target)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    if pointer is None:
        print_error("绑定失败：未找到包含 .claude 的 Claude Code 工作区。")
        return 1
    print_info(f"已绑定故事项目：{target}")
    print_info(f"指针文件：{pointer}")
    return 0


def cmd_init(args) -> int:
    try:
        init_values = _resolve_init_values(args)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as exc:
        _print_file_error("初始化项目", exc)
        return 2

    result = init_project(
        init_values["project_path"],
        init_values["title"],
        init_values["genre"],
        project_type=init_values["project_type"],
        word_count_target=init_values["word_count_target"],
        sub_genre=init_values["sub_genre"],
        synopsis=init_values["synopsis"],
        protagonist_name=init_values["protagonist_name"],
        protagonist_desire=init_values["protagonist_desire"],
        protagonist_flaw=init_values["protagonist_flaw"],
        unique_advantage_type=init_values["unique_advantage_type"],
        unique_advantage_desc=init_values["unique_advantage_desc"],
        unique_advantage_style=init_values["unique_advantage_style"],
        unique_advantage_visibility=init_values["unique_advantage_visibility"],
        unique_advantage_cost=init_values["unique_advantage_cost"],
        golden_finger=init_values["golden_finger"],
        antagonist_mirror=init_values["antagonist_mirror"],
        world_setting=init_values["world_setting"],
    )
    print_json(result)
    return 0


def _resolve_init_values(args) -> dict[str, Any]:
    config = _read_init_config(args.from_config)
    values = {
        "project_path": _init_value(args, config, "project_path"),
        "title": _init_value(args, config, "title"),
        "genre": _init_value(args, config, "genre"),
        "project_type": _init_value(args, config, "project_type"),
        "word_count_target": _init_value(args, config, "word_count_target", 30000),
        "sub_genre": _init_value(args, config, "sub_genre"),
        "synopsis": _init_value(args, config, "synopsis", ""),
        "protagonist_name": _init_value(args, config, "protagonist_name", ""),
        "protagonist_desire": _init_value(args, config, "protagonist_desire", ""),
        "protagonist_flaw": _init_value(args, config, "protagonist_flaw", ""),
        "unique_advantage_type": _init_value(args, config, "unique_advantage_type", ""),
        "unique_advantage_desc": _init_value(args, config, "unique_advantage_desc", ""),
        "unique_advantage_style": _init_value(args, config, "unique_advantage_style", ""),
        "unique_advantage_visibility": _init_value(
            args,
            config,
            "unique_advantage_visibility",
            "",
        ),
        "unique_advantage_cost": _init_value(args, config, "unique_advantage_cost", ""),
        "golden_finger": _init_value(args, config, "golden_finger", ""),
        "antagonist_mirror": _init_value(args, config, "antagonist_mirror", ""),
        "world_setting": _init_value(args, config, "world_setting", ""),
    }

    missing = [key for key in ("project_path", "title", "genre") if not values[key]]
    if missing:
        raise ValueError(f"缺少必需初始化参数：{', '.join(missing)}")

    if values["project_type"] not in {None, "", "short", "long"}:
        raise ValueError("project_type 必须是 short 或 long")
    values["project_type"] = values["project_type"] or None

    try:
        values["word_count_target"] = int(values["word_count_target"])
    except (TypeError, ValueError):
        raise ValueError("word_count_target 必须是整数") from None
    return values


def _read_init_config(config_file: str | None) -> dict[str, Any]:
    if not config_file:
        return {}
    payload = json.loads(Path(config_file).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("--from-config 必须指向 JSON 对象")
    return payload


def _init_value(args, config: dict[str, Any], key: str, default: Any = None) -> Any:
    cli_value = getattr(args, key, None)
    if cli_value is not None:
        return cli_value
    value = _config_value(config, key)
    return default if value is None else value


def _config_value(config: dict[str, Any], key: str) -> Any:
    if key in config:
        return config[key]

    protagonist = config.get("protagonist")
    if isinstance(protagonist, dict):
        protagonist_map = {
            "protagonist_name": "name",
            "protagonist_desire": "desire",
            "protagonist_flaw": "flaw",
        }
        nested_key = protagonist_map.get(key)
        if nested_key and nested_key in protagonist:
            return protagonist[nested_key]

    unique_advantage = config.get("unique_advantage")
    if isinstance(unique_advantage, dict):
        unique_map = {
            "unique_advantage_type": "type",
            "unique_advantage_desc": "description",
            "unique_advantage_style": "style",
            "unique_advantage_visibility": "visibility",
            "unique_advantage_cost": "cost",
        }
        nested_key = unique_map.get(key)
        if nested_key and nested_key in unique_advantage:
            return unique_advantage[nested_key]
    return None


def _require_project_root(args) -> Path:
    return resolve_project_root(
        args.project_root,
        cwd=Path.cwd(),
        allow_fallback=False,
    )


def _print_project_root_error(exc: FileNotFoundError) -> None:
    print_error(f"项目定位失败：{exc}")
    print_error("下一步：先运行 init 创建项目，或使用 --project-root 指定已有故事项目目录。")


def _print_file_error(action: str, exc: Exception) -> None:
    if isinstance(exc, FileNotFoundError):
        print_error(f"{action}失败：找不到文件或目录：{exc.filename or exc}")
    elif isinstance(exc, json.JSONDecodeError):
        print_error(f"{action}失败：JSON 格式错误：{exc}")
    else:
        print_error(f"{action}失败：{exc}")


def _resolve_chapter_arg(args) -> int:
    chapter = getattr(args, "chapter", None)
    chapter_arg = getattr(args, "chapter_arg", None)
    if chapter is None:
        chapter = chapter_arg
    if chapter is None:
        raise ValueError("缺少章节号：请写成命令后接章节号，或使用 --chapter 指定。")
    try:
        val = int(chapter)
    except (ValueError, TypeError):
        raise ValueError(f"章节号必须为正整数，收到：{chapter!r}")
    if val < 1:
        raise ValueError("章节号必须从 1 开始。")
    return val


def cmd_review(args) -> int:
    try:
        chapter = _resolve_chapter_arg(args)
    except ValueError as exc:
        print_error(str(exc))
        return 1
    try:
        review_results = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
        chapter_text = Path(args.chapter_file).read_text(encoding="utf-8")
        normalized_review = normalize_reviewer_output(review_results)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as exc:
        _print_file_error("生成审查报告", exc)
        return 1
    report = build_review_report(chapter, normalized_review, chapter_text)
    report_file = Path(args.report_file)
    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(report, encoding="utf-8")
    print_json({"report_file": str(report_file.resolve())})
    return 0


def cmd_learn(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    pattern = append_learning_pattern(
        project_root,
        args.pattern_type,
        args.description,
        args.example,
        args.instruction,
        args.chapter,
    )
    print_json(pattern)
    return 0


def cmd_query(args) -> int:
    if args.target == "genres":
        print_json({"genres": list_all_genres()})
        return 0

    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    if args.target == "context":
        print_json(ContextManager.from_project(project_root).build_context(args.chapter))
    elif args.target == "memory":
        print_json(MemoryManager.from_project(project_root).load())
    elif args.target == "learning":
        print_json({"patterns": get_learning_patterns(project_root, args.pattern_type)})
    elif args.target == "status":
        print_json(StatusReporter.from_project(project_root).build())
    elif args.target == "quality":
        print_json(QualityTrendReporter.from_project(project_root).build())
    elif args.target == "index":
        service = MemoryIndexService.from_project(project_root)
        if args.text or args.kind:
            print_json(
                {
                    "entries": service.query(
                        kind=args.kind,
                        text=args.text,
                        limit=args.limit,
                    )
                }
            )
        else:
            print_json(service.stats())
    elif args.target == "entity-graph":
        print_json(build_entity_graph(MemoryManager.from_project(project_root).load()))
    elif args.target == "ranked-context":
        print_json(
            rank_context_items(
                MemoryManager.from_project(project_root).load(),
                chapter=args.chapter,
                budget=args.budget,
            )
        )
    else:
        print_error(f"未知查询目标：{args.target}")
        return 1
    return 0


def cmd_plan(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    result = plan_story(
        project_root,
        chapter_count=args.chapter_count,
        dry_run=args.dry_run,
    )
    print_json(result)
    return 0 if result.get("ok") else 1


def cmd_write(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    try:
        chapter = _resolve_chapter_arg(args)
    except ValueError as exc:
        print_error(str(exc))
        return 1
    try:
        result = record_chapter_workflow(
            project_root,
            chapter=chapter,
            title=args.title,
            draft_file=args.draft_file,
            review_results=args.review_results,
            extraction_delta=args.delta_file,
            output_file=args.output_file,
            report_file=args.report_file,
            allow_warnings=not args.strict_warnings,
        )
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as exc:
        _print_file_error("记录章节", exc)
        return 1
    if args.result_file:
        try:
            result_file = Path(args.result_file).expanduser().resolve()
            atomic_write_text(
                result_file,
                json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                backup=True,
            )
        except (AtomicWriteError, OSError) as exc:
            _print_file_error("写入验收结果", exc)
            return 1
    print_json(result)
    return 0 if result.get("ok") else 1


def cmd_rebuild_views(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1

    results = EventProjectionRouter.from_project(project_root).rebuild(only=args.only)
    payload = {
        "ok": all(result.ok for result in results.values()),
        "project_root": str(project_root),
        "results": {
            name: {
                "ok": result.ok,
                "skipped": result.skipped,
                "detail": result.detail,
            }
            for name, result in results.items()
        },
    }
    print_json(payload)
    return 0 if payload["ok"] else 1


def _print_or_write_json(payload: dict, output_file: str | None = None) -> None:
    if output_file:
        path = Path(output_file).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print_json({"output_file": str(path), "ok": payload.get("ok", True)})
    else:
        print_json(payload)


def cmd_agent(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    try:
        chapter = _resolve_chapter_arg(args)
    except ValueError as exc:
        print_error(str(exc))
        return 1

    try:
        if args.agent_command == "brief":
            payload = build_writing_brief(project_root, chapter)
        elif args.agent_command == "repair":
            review_result = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
            payload = build_repair_plan(
                project_root,
                chapter,
                review_result,
                draft_file=args.draft_file,
            )
        elif args.agent_command == "polish":
            review_result = None
            if args.review_results:
                review_result = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
            payload = build_polish_plan(
                project_root,
                chapter,
                args.draft_file,
                review_result=review_result,
            )
        elif args.agent_command == "extract":
            payload = build_extraction_delta(
                project_root,
                chapter,
                args.chapter_file,
                title=args.title,
            )
        elif args.agent_command == "workflow":
            payload = build_workflow_workspace(project_root, chapter)
        else:
            print_error(f"未知 agent 子命令：{args.agent_command}")
            return 1
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as exc:
        _print_file_error("生成 Agent payload", exc)
        return 1

    _print_or_write_json(payload, args.output_file)
    return 0 if payload.get("ok", True) else 1


def _maintenance_project_root(args) -> Path | None:
    try:
        return _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return None


def cmd_index(args) -> int:
    project_root = _maintenance_project_root(args)
    if project_root is None:
        return 1
    print_json(MemoryIndexService.from_project(project_root).rebuild())
    return 0


def cmd_backup(args) -> int:
    project_root = _maintenance_project_root(args)
    if project_root is None:
        return 1
    print_json(BackupManager.from_project(project_root).create_backup(args.label))
    return 0


def cmd_health(args) -> int:
    project_root = _maintenance_project_root(args)
    if project_root is None:
        return 1
    print_json(StoryRuntimeHealth.from_project(project_root).check())
    return 0


def cmd_outline_revision(args) -> int:
    project_root = _maintenance_project_root(args)
    if project_root is None:
        return 1
    print_json(OutlineReviser.from_project(project_root).suggest(args.chapter, args.note))
    return 0


def cmd_deslop(args) -> int:
    try:
        draft_path = Path(args.draft_file).expanduser().resolve()
        text = draft_path.read_text(encoding="utf-8")
        whitelist = _read_deslop_whitelist(args, draft_path)
    except OSError as exc:
        _print_file_error("运行去 AI 味检测", exc)
        return 1

    payload = analyze_deslop_metrics(text, whitelist=whitelist)
    payload.update(
        {
            "ok": True,
            "command": "deslop",
            "draft_file": str(draft_path),
            "recommendation": _deslop_recommendation(payload["overall_level"]),
        }
    )
    _print_or_write_json(payload, args.output_file)
    return 0


def cmd_repair_entry(args) -> int:
    try:
        review_result = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
        payload = build_repair_workflow(review_result)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as exc:
        _print_file_error("生成修复计划", exc)
        return 1

    payload.update(
        {
            "command": "repair",
            "chapter": args.chapter,
            "review_results": str(Path(args.review_results).expanduser().resolve()),
            "draft_file": str(Path(args.draft_file).expanduser().resolve()) if args.draft_file else None,
        }
    )
    _print_or_write_json(payload, args.output_file)
    return 0


def cmd_placeholder_scan(args) -> int:
    target_file = args.input_file or args.target_file
    if not target_file:
        print_error("缺少扫描文件：请提供 target_file 或 --input-file。")
        return 1
    try:
        path = Path(target_file).expanduser().resolve()
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        _print_file_error("扫描占位符", exc)
        return 1

    placeholders = scan_placeholders(text)
    print_json(
        {
            "ok": True,
            "file": str(path),
            "placeholder_count": len(placeholders),
            "placeholders": placeholders,
        }
    )
    return 0


def cmd_import_project(args) -> int:
    try:
        payload = parse_import_source(args.source)
    except (FileNotFoundError, ValueError, OSError) as exc:
        _print_file_error("解析外部作品", exc)
        return 1

    payload.update(
        {
            "command": "import",
            "is_v1_migration": False,
            "rebuild_command": "rebuild-views",
        }
    )
    _print_or_write_json(payload, args.output_file)
    return 0


def _read_deslop_whitelist(args, draft_path: Path) -> list[str]:
    whitelist_path = _deslop_whitelist_path(args, draft_path)
    if not whitelist_path or not whitelist_path.is_file():
        return []
    return [
        line.strip()
        for line in whitelist_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _deslop_whitelist_path(args, draft_path: Path) -> Path | None:
    if args.whitelist_file:
        return Path(args.whitelist_file).expanduser().resolve()
    try:
        project_root, _source = locate_project_root(args.project_root, cwd=draft_path.parent)
    except FileNotFoundError:
        if args.project_root:
            raise
        return None
    return project_root / ".deslop-whitelist"


def _deslop_recommendation(level: str) -> str:
    if level == "heavy":
        return "先进入 story-deslop 或 story-repair，处理 heavy gate 后再审查。"
    if level == "medium":
        return "建议局部降 AI 味，再进入 reviewer。"
    if level == "light":
        return "可在润色阶段处理轻微模板化表达。"
    return "无需额外 deslop。"


def main() -> int:
    setup_logging()
    enable_windows_utf8_stdio(skip_in_pytest=True)
    parser = build_parser()
    args = parser.parse_args()

    handlers = {
        "where": cmd_where,
        "preflight": cmd_preflight,
        "use": cmd_use,
        "init": cmd_init,
        "plan": cmd_plan,
        "write": cmd_write,
        "chapter-commit": cmd_write,
        "rebuild-views": cmd_rebuild_views,
        "agent": cmd_agent,
        "review": cmd_review,
        "learn": cmd_learn,
        "query": cmd_query,
        "index": cmd_index,
        "backup": cmd_backup,
        "health": cmd_health,
        "outline-revision": cmd_outline_revision,
        "deslop": cmd_deslop,
        "repair": cmd_repair_entry,
        "placeholder-scan": cmd_placeholder_scan,
        "import": cmd_import_project,
    }
    handler = handlers[args.command]
    try:
        return handler(args)
    except Exception as exc:
        print_error(f"内部错误：{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

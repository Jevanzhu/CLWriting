#!/usr/bin/env python3
"""Internal CLI entrypoint for story-craft."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from cli.cli_args import build_parser
from cli.cli_output import print_error, print_info, print_json, print_kv
from core.context_manager import ContextManager
from core.memory_index import MemoryIndexService
from core.memory_manager import MemoryManager
from core.project_locator import (
    locate_project_root,
    resolve_project_root,
    write_current_project_pointer,
)
from core.runtime_compat import enable_windows_utf8_stdio
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
from tools.chapter_workflow import commit_chapter_workflow
from tools.context_ranker import rank_context_items
from tools.entity_linker import build_entity_graph
from tools.outline_planner import plan_story
from tools.outline_reviser import OutlineReviser
from tools.project_memory import append_learning_pattern, get_learning_patterns
from tools.quality_trend_report import QualityTrendReporter
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
    result = init_project(
        args.project_path,
        args.title,
        args.genre,
        word_count_target=args.word_count_target,
        sub_genre=args.sub_genre,
        synopsis=args.synopsis,
        protagonist_name=args.protagonist_name,
        protagonist_desire=args.protagonist_desire,
        protagonist_flaw=args.protagonist_flaw,
        unique_advantage_type=args.unique_advantage_type,
        unique_advantage_desc=args.unique_advantage_desc,
        unique_advantage_style=args.unique_advantage_style,
        unique_advantage_visibility=args.unique_advantage_visibility,
        unique_advantage_cost=args.unique_advantage_cost,
        golden_finger=args.golden_finger,
        antagonist_mirror=args.antagonist_mirror,
        world_setting=args.world_setting,
    )
    print_json(result)
    return 0


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
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        _print_file_error("生成审查报告", exc)
        return 1
    report = build_review_report(chapter, normalize_reviewer_output(review_results), chapter_text)
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
        result = commit_chapter_workflow(
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
        _print_file_error("提交章节", exc)
        return 1
    if args.result_file:
        result_file = Path(args.result_file).expanduser().resolve()
        result_file.parent.mkdir(parents=True, exist_ok=True)
        result_file.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print_json(result)
    return 0 if result.get("ok") else 1


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
        if args.agent_command == "brief":
            payload = build_writing_brief(project_root, args.chapter)
        elif args.agent_command == "repair":
            review_result = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
            payload = build_repair_plan(
                project_root,
                args.chapter,
                review_result,
                draft_file=args.draft_file,
            )
        elif args.agent_command == "polish":
            review_result = None
            if args.review_results:
                review_result = json.loads(Path(args.review_results).read_text(encoding="utf-8"))
            payload = build_polish_plan(
                project_root,
                args.chapter,
                args.draft_file,
                review_result=review_result,
            )
        elif args.agent_command == "extract":
            payload = build_extraction_delta(
                project_root,
                args.chapter,
                args.chapter_file,
                title=args.title,
            )
        elif args.agent_command == "workflow":
            payload = build_workflow_workspace(project_root, args.chapter)
        else:
            print_error(f"未知 agent 子命令：{args.agent_command}")
            return 1
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        _print_file_error("生成 Agent payload", exc)
        return 1

    _print_or_write_json(payload, args.output_file)
    return 0 if payload.get("ok", True) else 1


def cmd_maintain(args) -> int:
    try:
        project_root = _require_project_root(args)
    except FileNotFoundError as exc:
        _print_project_root_error(exc)
        return 1
    if args.target == "index":
        print_json(MemoryIndexService.from_project(project_root).rebuild())
    elif args.target == "backup":
        print_json(BackupManager.from_project(project_root).create_backup(args.label))
    elif args.target == "health":
        print_json(StoryRuntimeHealth.from_project(project_root).check())
    elif args.target == "outline-revision":
        print_json(OutlineReviser.from_project(project_root).suggest(args.chapter, args.note))
    else:
        print_error(f"未知维护目标：{args.target}")
        return 1
    return 0


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
        "agent": cmd_agent,
        "review": cmd_review,
        "learn": cmd_learn,
        "query": cmd_query,
        "maintain": cmd_maintain,
    }
    handler = handlers[args.command]
    try:
        return handler(args)
    except Exception as exc:
        print_error(f"内部错误：{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

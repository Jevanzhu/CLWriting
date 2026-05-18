#!/usr/bin/env python3
"""Argument parsing for story-craft CLI."""

from __future__ import annotations

import argparse


ARGPARSE_TRANSLATIONS = {
    "usage: ": "用法: ",
    "positional arguments": "位置参数",
    "options": "选项",
    "show this help message and exit": "显示帮助信息并退出",
    "the following arguments are required: %s": "缺少必需参数：%s",
    "invalid choice: %(value)r (choose from %(choices)s)": "无效选项：%(value)r（可选：%(choices)s）",
}


def _localize_argparse() -> None:
    argparse._ = lambda message: ARGPARSE_TRANSLATIONS.get(message, message)


def build_parser() -> argparse.ArgumentParser:
    _localize_argparse()
    parser = argparse.ArgumentParser(
        prog="story_craft.py",
        description=(
            "story-craft 内部 CLI。用于创建中文短篇/中篇项目、生成大纲、"
            "提交章节、查询故事记忆，并为 Claude Code Skill/Agent 提供工具层。"
        ),
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help="显式指定故事项目根目录。未指定时会尝试从当前目录定位 .story。",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("where", help="打印当前解析到的故事项目根目录")

    preflight = subparsers.add_parser(
        "preflight",
        help="检查 CLI、插件目录和项目定位状态",
        description="检查 story-craft CLI、插件目录和项目根目录定位状态。",
    )
    preflight.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="输出格式：text 便于阅读，json 便于脚本消费。",
    )

    use_parser = subparsers.add_parser("use", help="把当前 Claude 工作区绑定到指定故事项目")
    use_parser.add_argument("target", help="要绑定的故事项目根目录")

    init_parser = subparsers.add_parser(
        "init",
        help="初始化一个故事项目",
        description="初始化一个可被 story-craft plan/write/query 使用的故事项目。",
    )
    init_parser.add_argument("project_path", help="要创建的故事项目目录")
    init_parser.add_argument("title", help="故事标题")
    init_parser.add_argument("genre", help="主类型，例如 悬疑、现实题材、知乎短篇")
    init_parser.add_argument(
        "--word-count-target",
        type=int,
        default=30000,
        help="目标总字数，默认 30000。",
    )
    init_parser.add_argument("--sub-genre", default=None, help="可选子类型，例如 都市旧案、家庭反击")
    init_parser.add_argument("--synopsis", default="", help="一句话梗概")
    init_parser.add_argument("--protagonist-name", default="", help="主角姓名")
    init_parser.add_argument("--protagonist-desire", default="", help="主角核心欲望")
    init_parser.add_argument("--protagonist-flaw", default="", help="主角缺陷或盲点")
    init_parser.add_argument("--unique-advantage-type", default="", help="独特优势类型，例如 职业能力、资源、人脉")
    init_parser.add_argument("--unique-advantage-desc", default="", help="独特优势说明")
    init_parser.add_argument("--unique-advantage-style", default="", help="独特优势的使用方式")
    init_parser.add_argument("--unique-advantage-visibility", default="", help="独特优势在故事中的可见程度")
    init_parser.add_argument("--unique-advantage-cost", default="", help="独特优势的代价或限制")
    init_parser.add_argument("--golden-finger", default="", help="可选金手指；没有则留空")
    init_parser.add_argument("--antagonist-mirror", default="", help="反派与主角的镜像关系")
    init_parser.add_argument("--world-setting", default="", help="世界观和事实约束摘要")

    plan_parser = subparsers.add_parser(
        "plan",
        help="生成或刷新故事总纲",
        description="读取设定和项目记忆，生成或刷新故事总纲与 planned timeline。",
    )
    plan_parser.add_argument(
        "--chapter-count",
        type=int,
        default=None,
        help="覆盖自动推断的章节数，范围由工具限制在 1-30。",
    )
    plan_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只计算规划结果，不写入大纲、state 或 memory。",
    )

    write_parser = subparsers.add_parser(
        "write",
        help="提交一章草稿并更新故事记忆",
        description=(
            "提交一章草稿并更新故事记忆。可写成 write 3 或 write --chapter 3；"
            "会检查上一章 commit、占位符、字数闸门和 reviewer 阻断。"
        ),
    )
    write_parser.add_argument(
        "chapter_arg",
        nargs="?",
        type=int,
        help="要提交的章节号，从 1 开始。等价于 --chapter。",
    )
    write_parser.add_argument("--chapter", type=int, default=None, help="要提交的章节号，从 1 开始。")
    write_parser.add_argument("--title", default="", help="可选章节标题；未提供时从草稿一级标题推断。")
    write_parser.add_argument(
        "--draft-file",
        required=True,
        help="Markdown 草稿文件。通过字数、占位符、reviewer 后会复制到 正文/。",
    )
    write_parser.add_argument(
        "--review-results",
        default=None,
        help="可选 reviewer JSON。未提供时只执行本地轻量检查。",
    )
    write_parser.add_argument(
        "--delta-file",
        default=None,
        help="可选 data-agent 事实抽取 JSON。未提供时生成最小兜底 delta。",
    )
    write_parser.add_argument(
        "--output-file",
        default=None,
        help="可选正文输出路径；默认写入项目 正文/ 目录。",
    )
    write_parser.add_argument(
        "--report-file",
        default=None,
        help="可选审查报告输出路径；默认写入项目 审查报告/ 目录。",
    )
    write_parser.add_argument(
        "--result-file",
        default=None,
        help="可选 write 结果 JSON 输出路径；用于工作台恢复。",
    )
    write_parser.add_argument(
        "--strict-warnings",
        action="store_true",
        help="把写前校验和字数偏差 warning 也视为阻断。",
    )

    agent_parser = subparsers.add_parser(
        "agent",
        help="生成 story-write 协作所需的本地 Agent payload",
        description="生成 story-write 协作所需的任务书、修复计划、润色计划或 data-agent 兜底 delta。",
    )
    agent_subparsers = agent_parser.add_subparsers(dest="agent_command", required=True)

    brief_parser = agent_subparsers.add_parser(
        "brief",
        help="生成 context-agent 兼容写作任务书",
    )
    brief_parser.add_argument("--chapter", type=int, required=True, help="目标章节号")
    brief_parser.add_argument("--output-file", default=None, help="可选输出 JSON 文件")

    repair_parser = agent_subparsers.add_parser(
        "repair",
        help="归一化 reviewer 输出并生成修复/重试计划",
    )
    repair_parser.add_argument("--chapter", type=int, required=True, help="目标章节号")
    repair_parser.add_argument("--review-results", required=True, help="reviewer JSON 文件")
    repair_parser.add_argument("--draft-file", default=None, help="可选草稿文件，用于同时扫描占位符")
    repair_parser.add_argument("--output-file", default=None, help="可选输出 JSON 文件")

    polish_parser = agent_subparsers.add_parser(
        "polish",
        help="生成事实保真润色计划",
    )
    polish_parser.add_argument("--chapter", type=int, required=True, help="目标章节号")
    polish_parser.add_argument("--draft-file", required=True, help="要润色的草稿文件")
    polish_parser.add_argument("--review-results", default=None, help="可选 reviewer JSON 文件")
    polish_parser.add_argument("--output-file", default=None, help="可选输出 JSON 文件")

    extract_parser = agent_subparsers.add_parser(
        "extract",
        help="从正文生成 data-agent 兼容兜底 delta",
    )
    extract_parser.add_argument("--chapter", type=int, required=True, help="目标章节号")
    extract_parser.add_argument("--chapter-file", required=True, help="已完成正文文件")
    extract_parser.add_argument("--title", default="", help="可选章节标题")
    extract_parser.add_argument("--output-file", default=None, help="可选输出 JSON 文件")

    workflow_parser = agent_subparsers.add_parser(
        "workflow",
        help="准备 /story-write 半自动 Agent 工作台",
    )
    workflow_parser.add_argument("--chapter", type=int, required=True, help="目标章节号")
    workflow_parser.add_argument("--output-file", default=None, help="可选输出 JSON 文件")

    review_parser = subparsers.add_parser(
        "review",
        help="把 reviewer JSON 转为 Markdown 审查报告",
        description="把 reviewer JSON 转为 Markdown 审查报告。可写成 review 3 或 review --chapter 3。",
    )
    review_parser.add_argument(
        "chapter_arg",
        nargs="?",
        type=int,
        help="目标章节号。等价于 --chapter。",
    )
    review_parser.add_argument("--chapter", type=int, default=None, help="目标章节号")
    review_parser.add_argument("--review-results", required=True, help="reviewer JSON 文件")
    review_parser.add_argument("--chapter-file", required=True, help="正文 Markdown 文件")
    review_parser.add_argument("--report-file", required=True, help="审查报告输出路径")

    learn_parser = subparsers.add_parser(
        "learn",
        help="记录可复用写作经验",
        description="把可复用写作经验写入项目学习记忆，供后续章节使用。",
    )
    learn_parser.add_argument("--chapter", type=int, required=True, help="来源章节号")
    learn_parser.add_argument(
        "--pattern-type",
        choices=("hook", "pacing", "dialogue", "payoff", "emotion", "format", "other"),
        default="other",
        help="经验类型",
    )
    learn_parser.add_argument("--description", required=True, help="经验描述")
    learn_parser.add_argument("--example", default="", help="可选原文例子")
    learn_parser.add_argument("--instruction", required=True, help="后续写作应遵守的具体指令")

    query_parser = subparsers.add_parser(
        "query",
        help="查询故事状态、上下文和记忆",
        description="查询故事状态、上下文、项目记忆、实体关系、质量趋势或索引。",
    )
    query_parser.add_argument(
        "target",
        choices=(
            "context",
            "memory",
            "learning",
            "genres",
            "status",
            "quality",
            "index",
            "entity-graph",
            "ranked-context",
        ),
        help="查询目标",
    )
    query_parser.add_argument("--chapter", type=int, default=1, help="目标章节号，默认 1")
    query_parser.add_argument("--pattern-type", default=None, help="learning 查询的经验类型过滤")
    query_parser.add_argument("--kind", default=None, help="index 查询的条目类型过滤")
    query_parser.add_argument("--text", default="", help="index 查询文本")
    query_parser.add_argument("--limit", type=int, default=20, help="查询结果数量上限")
    query_parser.add_argument("--budget", type=int, default=20, help="ranked-context 上下文预算")

    maintain_parser = subparsers.add_parser(
        "maintain",
        help="运行索引、备份、健康检查等维护任务",
        description="运行索引重建、备份、健康检查和中期大纲修正建议。",
    )
    maintain_parser.add_argument(
        "target",
        choices=("index", "backup", "health", "outline-revision"),
        help="维护目标",
    )
    maintain_parser.add_argument("--label", default="manual", help="备份标签")
    maintain_parser.add_argument("--chapter", type=int, default=1, help="目标章节号")
    maintain_parser.add_argument("--note", default="", help="大纲修正触发说明")

    return parser

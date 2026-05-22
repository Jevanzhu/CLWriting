# CLWriting

面向中文短篇/中篇小说（1-10 万字）的 Claude Code 插件。

让作者在 Claude Code 中完成从构思到成稿的全流程：初始化项目、生成大纲、逐章写作、自动审查、事实抽取和写作经验积累。内置 37 个题材模板和 6 个流派知识库，覆盖悬疑、言情、修仙、科幻、知乎短篇等主流品类。

主入口是 Claude Code 对话里的 `/story-*` 命令；Python CLI 是底层支撑工具，用于校验、生成工作台、提交章节和运维查询，不提供独立的 `story-craft <subcommand>` 命令封装。

**核心特色：**

- **Agent 协作写作** — 每章由三个专职 Agent 分工完成，主流程编排、不伪造输出
- **结构化审查闸门** — reviewer 原始输出只接受 `issues` / `summary`，围绕设定、时间线、连续性、角色、逻辑、节奏、格式和 AI 味输出结构化问题，阻断项未修复前不提交
- **自动记忆维护** — 每章提交后自动提取角色出场、状态变化、伏笔埋设/回收、时间线，跨章记忆持续累积
- **字数闸门** — 低于规划字数 60% 阻断提交，低于 80% 或超出 135% 发出警告
- **中篇模式** — 超过 5 万字的项目自动启用 SQLite 索引、备份快照、质量趋势分析和上下文裁剪

**内置 Agent：**

| Agent | 职责 |
|-------|------|
| `context-agent` | 搜集项目上下文（大纲、记忆、设定），输出本章创作任务书 |
| `reviewer` | 审查正文，检查设定一致性、时间线、角色动机、逻辑因果和 AI 味，输出结构化问题清单 |
| `data-agent` | 从已写正文中提取角色、伏笔、时间线等事实，生成章节增量数据 |
| `deconstruction-agent` | 拆解参考短篇，提取可迁移的创作模式，不污染故事数据 |

## 快速开始

在 Claude Code 中使用 `/story-*` 命令完成一本书的完整流程：

```text
/story-init          # 初始化故事项目
/story-plan          # 生成故事总纲
/story-write 1       # 写第一章
/story-review 1      # 审查第一章
/story-learn         # 记录写作经验
/story-query         # 查询故事状态与记忆
```

## 项目结构

```text
story-craft/                  # Claude Code 插件包
├── .claude-plugin/plugin.json
├── skills/                   # 6 个 Skill 定义
├── agents/                   # 4 个 Agent 定义（context-agent、reviewer、data-agent、deconstruction-agent）
├── scripts/                  # Python 工具层
│   ├── story_craft.py        # CLI 入口
│   ├── core/                 # 配置、状态、记忆、上下文、日志、运行时诊断
│   ├── tools/                # 规划、写作、审查、抽取等工具
│   ├── cli/                  # 参数解析与输出
│   └── tests/                # pytest 测试套件
├── genres/                   # 6 个流派知识库
├── templates/                # 37 个流派模板 + 11 个输出模板
└── references/               # 共享参考资料
```

用户创建的故事项目结构：

```text
my-story/
├── .story/
│   ├── state.json            # 项目状态
│   ├── memory.json           # 故事记忆（角色、伏笔、时间线）
│   ├── project_learning.json # 写作经验
│   ├── memory.db             # 中篇模式索引（按需生成）
│   ├── chapters/             # 章节提交记录
│   ├── backups/              # 备份快照（按需生成）
│   └── workflows/ch_01/      # 写作工作台
├── 大纲/
├── 设定集/
├── 正文/
└── 审查报告/
```

## 终端 CLI

Python CLI 是底层工具入口，用于调试、验证和脚本化运维：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
python3 -X utf8 story-craft/scripts/story_craft.py where
python3 -X utf8 story-craft/scripts/story_craft.py --project-root ./my-story query status
```

不提供独立的 `story-craft <subcommand>` 命令封装。

## 文档

- `docs/quickstart.md`：从零创建故事并完成第一章
- `docs/claude-code-usage.md`：Claude Code 使用方式和 Agent 编排
- `docs/cli-usage.md`：终端 CLI 命令参考
- `docs/data-formats.md`：review.json、delta.json 等数据格式
- `docs/troubleshooting.md`：常见问题与故障排查
- `docs/development.md`：开发验证与测试命令
- `story-craft/references/README.md`：Agent/Skill 可按需读取的参考资料索引

## 致谢

本项目参考了 webnovel-writer 的架构设计，包括 Agent 分工模式、Skill 流程编排和章节提交闸门机制，在此基础上针对短篇/中篇小说场景进行了重新设计和实现。

## 许可证

GPL-3.0，详见 `LICENSE`。

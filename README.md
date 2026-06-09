# CLWriting

面向中文短篇/长篇小说（1-10 万字起步，可扩展长篇）的 Claude Code 插件。

story-craft 让作者在 Claude Code 中完成从构思到成稿的全流程：初始化项目、规划合同、逐章写作、自动审查、事实抽取、commit 真源写入、投影重建和写作经验积累。内置题材模板、流派知识库和 references 三分资料，覆盖悬疑、言情、修仙、科幻、知乎短篇等主流品类。

主入口是 Claude Code 对话里的 `/story-*` 命令；Python CLI 是底层支撑工具，用于初始化项目本体、校验、生成工作台、写入真源、重建投影和运维查询。`/story-init` Skill 会在 CLI 初始化后继续编排 `.claude/` 自部署；直接调用 `init` CLI 不会部署 Claude Code 运行时资产。`/story-*` 写作链必须提供 reviewer 结果；直接调用 CLI 时可用本地轻量兜底，结果会用 `review_status` 和 commit `review_meta.source` 留痕，也可用 `--require-review` 强制要求 reviewer JSON。

**核心特色：**

- **双轨写作**：短篇使用 4 核心 Agent 和 lazy 投影，长篇使用 9 Agent 能力、卷章合同和 5 场景路由。
- **合同先行**：写前真源是 `.story/contracts/master.json` 和 `.story/contracts/chapters/chapter_NNN.json`。
- **Agent 协作**：context-agent、narrative-writer、reviewer、data-agent 形成写作主链，规划、角色、一致性、查询和研究 Agent 按需加入。
- **结构化审查**：reviewer 输出 `issues` / `summary`，S1/S2、`blocking=true` 和 critical issue 未修复前不进入 commit；CLI 兜底路径会标记为 `review_status=skipped` 和 `review_meta.source=fallback`。
- **commit 真源**：章节验收后写入 `.story/commits/chapter_NNN.commit.json`，再派发 6 个 read-model 投影。
- **可恢复工作台**：每章中间产物固定保存在 `.story/workflows/ch_NN/`，便于中断后从缺失步骤继续。

**当前运行时资产：**

- 17 个 Skill
- 13 个 Claude Code commands
- 9 个 Agent
- 20 个 CLI 顶层子命令
- 6 个投影：`state`、`memory`、`summary`、`index`、`vector`、`markdown_view`

## 安装

前置要求：

- [Claude Code](https://claude.com/claude-code)
- Python ≥ 3.10（底层 CLI 工具层运行所需）

在 Claude Code 中安装插件：

```text
/plugin marketplace add Jevanzhu/CLWriting
/plugin install story-craft@clwriting
```

安装后 `/story-*` 命令即可用。首次在某个故事项目执行 `/story-init` 时，会把 commands、agents、hooks 和 references 自部署到该项目的 `.claude/`，并按版本幂等重部署、保留你已有的 settings 配置。

## 快速开始

短篇项目：

```text
/story-init
/story-preflight 1
/story-short-write 1
/story-review 1
/story-learn
/story-query status
```

长篇项目：

```text
/story-init
/story-long-plan
/story-preflight 1
/story-long-write 1
/story-long-analyze
/story-query status
```

## 项目结构

```text
story-craft/                  # Claude Code 插件包
├── .claude-plugin/plugin.json
├── commands/                 # 13 个 Claude Code command 定义
├── skills/                   # 17 个 Skill 定义（story-init 内含 hooks 与 settings 部署模板）
├── agents/                   # 9 个 Agent 定义
├── scripts/                  # Python 工具层
│   ├── story_craft.py        # CLI 入口
│   ├── core/                 # 合同、commit、投影、状态、记忆、RAG、运行时诊断
│   ├── tools/                # 规划、写作、审查、修复、导入、部署等工具
│   ├── cli/                  # 参数解析与输出
│   └── tests/                # pytest 测试套件
├── genres/                   # 流派知识库
├── templates/                # 输出模板和题材模板
└── references/               # shared/short/long 三分 + index 按需加载索引
```

用户创建的故事项目结构：

```text
my-story/
├── .claude/                  # /story-init Skill 部署的 Claude Code 运行时资产
│   ├── commands/
│   ├── agents/story-craft/
│   ├── hooks/
│   ├── settings.json
│   └── story-craft/references/
├── .story/
│   ├── contracts/
│   │   ├── master.json
│   │   ├── volumes/volume_NNN.json
│   │   ├── chapters/chapter_NNN.json
│   │   ├── reviews/chapter_NNN.review.json
│   │   └── deployment.json
│   ├── commits/chapter_NNN.commit.json
│   ├── state.json
│   ├── memory.json
│   ├── project_learning.json
│   ├── index.db
│   ├── vector.db
│   ├── summaries/
│   └── workflows/ch_NN/
├── 大纲/
├── 设定/
├── 正文/
├── 审查报告/
└── 追踪/
```

## 终端 CLI

Python CLI 是底层工具入口，用于调试、验证和脚本化运维：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
python3 -X utf8 story-craft/scripts/story_craft.py where
python3 -X utf8 story-craft/scripts/story_craft.py --project-root ./my-story query status
python3 -X utf8 story-craft/scripts/story_craft.py --project-root ./my-story rebuild-views
```

## 文档

- `docs/quickstart.md`：短篇/长篇双轨上手
- `docs/claude-code-usage.md`：Claude Code commands、Skill 和 Agent 编排
- `docs/cli-usage.md`：20 个 CLI 顶层子命令参考
- `docs/data-formats.md`：合同、commit、reviewer、delta、WriteResult 和 6 投影
- `docs/troubleshooting.md`：合同缺失、工作台恢复、投影重建和降级排错
- `docs/development.md`：开发验证、测试命令和插件发现约定
- `story-craft/references/README.md`：Agent/Skill 可按需读取的参考资料索引

## 致谢

本项目在设计与资料上参考了以下开源项目，谨致谢意：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**（GPL-3.0）：架构设计参考，包括 Agent 分工模式、Skill 流程编排和章节验收闸门机制；story-craft 在此基础上重构为双轨合同、commit 和投影体系。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：`references/long/` 下的长篇写作方法论资料引入自该项目并保留原文。每份引入文件顶部均带 `source` / `license` frontmatter，完整来源与版权说明见 `story-craft/references/long/README.md` 和 `story-craft/references/long/LICENSE`。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定设计的方法论参考。

本项目整体以 GPL-3.0 发布；上述引入的 MIT 资料在文件级保留其原始版权与许可声明，符合各自许可证的署名要求。

## 许可证

GPL-3.0，详见 `LICENSE`。

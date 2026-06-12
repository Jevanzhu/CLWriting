# CLWriting

**在 Claude Code 里写中文小说的创作助手。** 从一句构思到逐章成稿，story-craft 全程陪你：搭框架、写正文、自动审稿、记住前文设定、积累你的写作经验。适合 1-10 万字的短篇/中篇，也能撑起长篇连载。

覆盖悬疑、言情、修仙、科幻、现实、知乎短篇等主流品类，内置题材模板和写作方法论资料。

## 它能帮你做什么

- **从零起一个项目**：说清书名、题材、主角和卖点，它就把故事框架搭好。
- **逐章写正文**：你给方向，它写草稿——而且记得住前面所有章节的人物、伏笔和设定，不会前后矛盾。
- **写完自动审稿**：每章都过一遍审查，挑出逻辑漏洞、节奏问题、人物跑偏、AI 味，问题没修不让你"提交"。
- **越写越懂你**：把你认可的写作经验沉淀下来，自动用到后面的章节里（详见 `/story-learn`）。
- **随时复盘**：一句话查进度、查人物关系、查某章改动影响了哪些后文。

你**全程只在对话里输入 `/story-*` 命令**，用大白话描述需求即可，不需要打开终端敲代码。

## 安装

前置要求：

- [Claude Code](https://claude.com/claude-code)
- Python ≥ 3.10（底层工具层运行所需，装好即可，平时不直接用）

在 Claude Code 中安装插件：

```text
/plugin marketplace add Jevanzhu/CLWriting
/plugin install story-craft@clwriting
```

装完 `/story-*` 命令就能用了。第一次在某个项目里执行 `/story-init`，它会把运行所需的资产自动部署到该项目，之后随版本幂等更新，保留你已有的配置。

### Python 依赖（可选）

底层只有一个可选三方依赖 `filelock`，用于多进程同时写入时的保护。**单人单进程使用可以跳过**（缺失时自动降级，不影响功能）。若有并发写入同一项目的场景再装：

```bash
python3 -m pip install -r requirements.txt
```

## 快速开始

写一篇**短篇**，从建项目到第一章：

```text
/story-init                 创建项目，说清书名/题材/主角/卖点
/story-preflight 1          写第 1 章前的检查
/story-short-write 1        写第 1 章正文
/story-review 1             审查这一章
/story-query learning-suggestions   看看有哪些经验值得沉淀
/story-learn                沉淀经验，自动用到后面章节
/story-query status         查看项目进度
```

写**长篇**，多了规划这一步：

```text
/story-init                 创建项目，选长篇
/story-long-plan            规划卷、章和大纲
/story-preflight 1
/story-long-write 1         写第 1 章（按场景智能路由）
/story-long-analyze         复盘伏笔、人物线、质量
/story-query status
```

不确定下一步用哪个命令？随时 `/story-preflight`，它会告诉你该走哪条路。完整教程见 [`docs/quickstart.md`](docs/quickstart.md)。

## 工作原理（想深入了解再看）

平时写作不需要关心这一节。它解释 story-craft 凭什么"记得住、不矛盾、问题没修不放行"：

- **合同先行**：写之前，故事框架先固化成"合同"真源——`.story/contracts/master.json`（全书设定）和分章合同。后续写作都以合同为准，避免越写越飘。
- **审查闸门**：每章写完由审查环节产出结构化结果，发现阻断级问题（逻辑硬伤、人物严重跑偏等）就拦下，修复并复审通过后才进入下一步。
- **章节真源 + 投影**：一章验收通过后，写入 `.story/commits/chapter_NNN.commit.json` 作为唯一真源，再自动派生出状态、记忆、摘要、检索索引、向量库、Markdown 视图等多份"投影"，供后续查询和写作调用。
- **可恢复**：每章的中间产物都留痕，写到一半中断也能从缺失的那一步继续。

更细的数据格式见 [`docs/data-formats.md`](docs/data-formats.md)。

## 项目结构

```text
story-craft/                  # Claude Code 插件包
├── commands/                 # 斜杠命令定义（你输入的 /story-*）
├── skills/                   # Skill 定义（命令背后的执行逻辑）
├── agents/                   # Agent 定义（写作、审查、查询等角色）
├── scripts/                  # Python 工具层（命令背后调的底层工具）
├── genres/                   # 流派知识库
├── templates/                # 输出与题材模板
└── references/               # 写作方法论资料（按需加载）
```

你创建的故事项目里，所有数据都在项目目录的 `.story/` 下（合同、章节真源、记忆、索引等），正文则在 `正文/`、设定在 `设定/`、大纲在 `大纲/`，都是你能直接打开看的文件。

## 项目规模

当前运行时资产：**17 个 Skill**、**13 个 Claude Code commands**、**9 个 Agent**、**20 个 CLI 顶层子命令**，以及 6 个投影（`state`、`memory`、`summary`、`index`、`vector`、`markdown_view`）。短篇与长篇双轨共用一套真源体系。

## 文档

- [`docs/quickstart.md`](docs/quickstart.md)：手把手写第一篇（短篇/长篇双轨）
- [`docs/claude-code-usage.md`](docs/claude-code-usage.md)：全部斜杠命令、Skill 与 Agent 速查
- [`docs/cli-usage.md`](docs/cli-usage.md)：底层 CLI 参考（高级/运维用，日常不需要）
- [`docs/rag-config.md`](docs/rag-config.md)：语义检索的 embedding / rerank / `.env` 配置
- [`docs/data-formats.md`](docs/data-formats.md)：合同、commit、审查结果、投影等数据格式
- [`docs/troubleshooting.md`](docs/troubleshooting.md)：常见问题与排错
- [`docs/development.md`](docs/development.md)：开发、测试与插件约定
- [`story-craft/references/README.md`](story-craft/references/README.md)：写作方法论资料索引

## 致谢

本项目在设计与资料上参考了以下开源项目，谨致谢意：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**（GPL-3.0）：架构设计参考，包括 Agent 分工模式、Skill 流程编排和章节验收闸门机制；story-craft 在此基础上重构为双轨合同、commit 和投影体系。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：`references/long/` 下的长篇写作方法论资料引入自该项目并保留原文。每份引入文件顶部均带 `source` / `license` frontmatter，完整来源与版权说明见 `story-craft/references/long/README.md` 和 `story-craft/references/long/LICENSE`。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定设计的方法论参考。

本项目整体以 GPL-3.0 发布；上述引入的 MIT 资料在文件级保留其原始版权与许可声明，符合各自许可证的署名要求。

## 许可证

GPL-3.0，详见 `LICENSE`。

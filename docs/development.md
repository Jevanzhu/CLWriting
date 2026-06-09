# 开发与验证

## 环境

- Python 版本：3.10+
- 运行入口：`python3 -X utf8 story-craft/scripts/story_craft.py`
- 测试依赖：`pytest`
- 可选依赖：`filelock`，用于增强 JSON 写入锁；向量能力不可用时检索降级到 BM25/LIKE。

项目配置见根目录 `pyproject.toml`。当前测试入口使用 `pytest`。

## 当前架构

story-craft 是 Claude Code 插件式写作工具：

- 17 个 Skill：共用、短篇、长篇三类。
- 13 个 Claude Code commands：共用 8 个、长篇 4 个、短篇 1 个。
- 9 个 Agent：规划、角色、上下文、正文、审查、一致性、事实抽取、查询、研究。
- 20 个 CLI 顶层子命令：确定性工具层，不自动调用 Agent。
- 6 个投影 writer：`state`、`memory`、`summary`、`index`、`vector`、`markdown_view`。

写前真源是 `.story/contracts/master.json`、`.story/contracts/chapters/chapter_NNN.json` 和长篇所需的 volume/review 合同；写后真源是 `.story/commits/chapter_NNN.commit.json`；Markdown 大纲和追踪文件是人类可读投影。

## 测试命令

全量测试：

```bash
python3 -m pytest story-craft/scripts/tests/
```

编译检查：

```bash
env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
```

提交前建议使用带超时的命令：

```bash
timeout 60s python3 -m pytest story-craft/scripts/tests/
timeout 60s env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
```

## 常用单测

```bash
python3 -m pytest story-craft/scripts/tests/test_docs_alignment.py
python3 -m pytest story-craft/scripts/tests/test_reference_alignment.py
python3 -m pytest story-craft/scripts/tests/test_skills.py
python3 -m pytest story-craft/scripts/tests/test_agents.py
python3 -m pytest story-craft/scripts/tests/test_agent_workflow.py
python3 -m pytest story-craft/scripts/tests/test_references.py
```

## 双轨冒烟

短篇冒烟重点：

- `init --project-type short` 写入 `.story/contracts/master.json`。
- `/story-short-write` 使用 4 核心 Agent。
- 短篇不因缺 `volumes/` 阻断。
- `index/vector` lazy 不阻断 commit。

长篇冒烟重点：

- `/story-long-plan` 生成 master、volumes、chapters 和 character_registry 草案。
- `/story-long-write` 路由 5 个场景。
- `chapter-commit` 写入 `.story/commits/chapter_NNN.commit.json`。
- `rebuild-views` 能重建 6 投影。

Claude Code 端真实 Agent 调用必须和本地 pytest 分开记录。pytest 只能验证 frontmatter、引用一致性、Python 工具层和可解析产物。

## 核心模块

- `core/types.py`：ReviewerResult、ChapterCommit、contracts、WriteResult、WorkflowManifest 等边界类型。
- `core/contract_store.py`：master、volume、chapter、review、deployment 合同读写。
- `core/commit_store.py`：chapter commit 真源读写。
- `core/chapter_commit_builder.py`：从 review 和 delta 构建 commit payload。
- `core/chapter_record.py`：写入 commit 真源并派发投影。
- `core/event_projection_router.py`：加载并调度 6 个 projection writer。
- `core/projection/*_writer.py`：state、memory、summary、index、vector、markdown_view 投影。
- `core/rag/*`：向量检索与 BM25 fallback。
- `tools/scenario_router.py`：长篇 5 场景路由。
- `tools/deslop_metrics.py`：6-Gate 去 AI 味量化。
- `tools/repair_strength.py`：修复强度判定。
- `tools/deployment.py`：自部署资产合并和 deployment sentinel。

## 文档边界

- README 只放项目介绍、入口概览和文档导航。
- 具体使用说明放在 `docs/`。
- Skill 文档负责 Claude Code 内部执行流程。
- `story-craft/references/` 放 Agent/Skill 可按需读取的创作和审查参考，不是故事事实来源。
- `Dev/Plans/` 是方案讨论和归档资料，不作为正式用户入口文档。

## 插件发现约定

- 当前 `plugin.json` 只使用已验证的基础 manifest 字段，不写未确认 schema 的 `skills` / `agents` 路径字段。
- Claude Code 插件按目录自动发现 `story-craft/skills/` 和 `story-craft/agents/`。
- 若后续 manifest schema 明确支持显式路径字段，再把 `skills/` 和 `agents/` 写入 `plugin.json`。
- 修改插件目录结构时，必须保持 `plugin.json` 为合法 JSON，并确认 `skills/`、`agents/`、`commands/`、`hooks/` 目录仍存在。

## 提交流程

1. 确认 `git status --short --branch`。
2. 运行相关局部测试。
3. 运行全量 pytest、compileall 和 `git diff --check`。
4. 确认 `git ls-files Dev` 为空。
5. 只暂存本工单文件并提交，不默认 push。

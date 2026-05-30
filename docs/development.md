# 开发与验证

## 环境

- Python 版本：3.10+
- 运行入口：`python3 -X utf8 story-craft/scripts/story_craft.py`
- 可选依赖：`filelock`，用于增强 state/memory/record JSON 写入锁。
- 测试依赖：`pytest`，用于运行脚本层测试套件。

项目配置见根目录 `pyproject.toml`。当前测试入口使用 `pytest`。

## 当前状态

当前主线已经完成 story-craft 的核心闭环：Skill 入口、Agent 编排工作台、CLI 工具层、章节验收、记忆维护、中篇索引/备份/健康检查和 pytest 测试套件。

后续开发重点应优先放在真实 `/story-write` Agent 输出联调、长一点的样例项目验证和文档/错误信息细节打磨。

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
python3 -m pytest story-craft/scripts/tests/test_reference_alignment.py
python3 -m pytest story-craft/scripts/tests/test_docs_alignment.py
python3 -m pytest story-craft/scripts/tests/test_smoke.py
python3 -m pytest story-craft/scripts/tests/test_agent_workflow.py
python3 -m pytest story-craft/scripts/tests/test_memory_index.py
```

## 核心模块

| 模块 | 职责 |
|------|------|
| `core/types.py` | 核心边界 TypedDict（ReviewerResult、ExtractionDelta、WriteResult、WorkflowManifest 等） |
| `core/chapter_record.py` | 章节验收记录负载生成，accepted 后写 commit 真源并派发投影 |
| `core/security_utils.py` | 原子 JSON 写入、可选 filelock 锁保护和备份 |
| `core/text_utils.py` | 公共纯函数：中文字符计数、行压缩、整数提取、大纲字段解析 |
| `core/log.py` | CLI 日志初始化 |
| `core/time_utils.py` | UTC 时间戳工具 |
| `core/runtime_diagnostics.py` | 运行时诊断：Python 版本、平台、可选依赖可用性 |
| `core/memory_index.py` | SQLite 全文索引服务，中篇模式（超过 5 万字）自动启用 |
| `core/state_manager.py` | 项目状态管理，FileLock + tempfile + os.replace 原子写入 |

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
- 修改插件目录结构时，必须保持 `plugin.json` 为合法 JSON，并确认 `skills/`、`agents/` 目录仍存在。

## 兼容层退役状态

- `ChapterRecordService` 和 `ch_NN_record.json` 是当前章节验收记录契约。
- `ChapterCommitService`、`core/chapter_commit.py` 和 `ch_NN_commit.json` 查找逻辑已退役。
- commit 真源统一写入 `.story/commits/chapter_NNN.commit.json`。
- 新代码不得继续新增旧 commit 命名或 legacy lookup 契约。

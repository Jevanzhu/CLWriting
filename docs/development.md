# 开发与验证

## 环境

- Python 版本：3.10+
- 运行入口：`python3 -X utf8 story-craft/scripts/story_craft.py`
- 可选依赖：`filelock`，用于增强 state/memory/commit JSON 写入锁。
- 测试依赖：`pytest`，用于运行脚本层测试套件。

项目配置见根目录 `pyproject.toml`。当前测试入口使用 `pytest`。

## 测试命令

全量测试：

```bash
python3 -m pytest story-craft/scripts/tests/
```

编译检查：

```bash
env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
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
| `core/text_utils.py` | 公共纯函数：中文字符计数、行压缩、整数提取、大纲字段解析 |
| `core/runtime_diagnostics.py` | 运行时诊断：Python 版本、平台、可选依赖可用性 |
| `core/memory_index.py` | SQLite 全文索引服务，中篇模式（5 万字以上）自动启用 |
| `core/state_manager.py` | 项目状态管理，FileLock + tempfile + os.replace 原子写入 |

## 文档边界

- README 只放项目介绍、入口概览和文档导航。
- 具体使用说明放在 `docs/`。
- Skill 文档负责 Claude Code 内部执行流程。
- `Dev/Plans/` 记录待办事项和归档的设计方案。

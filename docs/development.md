# 开发与验证

## 环境

- Python 版本：3.10+
- 运行入口：`python3 -X utf8 story-craft/scripts/story_craft.py`
- 可选依赖：`filelock`，用于增强 state/memory/commit JSON 写入锁。

项目配置见根目录 `pyproject.toml`。当前不引入 pytest，测试入口仍使用标准库
`unittest`。

## 测试命令

```bash
python3 -B -m unittest discover -s story-craft/scripts/tests -p 'test_*.py'
env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
```

## 常用单测

```bash
python3 -B -m unittest story-craft/scripts/tests/test_phase18_reference_alignment.py
python3 -B -m unittest story-craft/scripts/tests/test_phase15_usability_docs.py
python3 -B -m unittest story-craft/scripts/tests/test_phase14_real_project_smoke.py
python3 -B -m unittest story-craft/scripts/tests/test_phase13_agent_workflow.py
```

## 文档边界

- README 只放项目介绍、入口概览和文档导航。
- 具体使用说明放在 `docs/`。
- Skill 文档负责 Claude Code 内部执行流程。
- `Dev/Plans/` 记录设计方案、进度和阶段性决策。

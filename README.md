# CLWriting

CLWriting 是一个面向中文短篇/中篇小说创作的 Claude Code 插件项目。当前正式实现目录是 `story-craft/`。

`story-craft` 面向 1-10 万字中文故事，目标是让作者在 Claude Code 中完成设定、规划、章节写作、审查、事实抽取和项目记忆维护。

当前已完成到 P18 真实 Agent 编排初版，并进入 P19 章节号体验与失败恢复打磨阶段。核心链路、Agent payload、真实冒烟、字数闸门、CLI 中文帮助、`/story-write` 工作台编排和章节号入口已落地。

## 项目形态

这是一个 Claude Code 插件包，不是 Web 应用。

- 插件清单：`story-craft/.claude-plugin/plugin.json`
- Skills：`story-craft/skills/`
- Agents：`story-craft/agents/`
- 内部工具：`story-craft/scripts/story_craft.py`

## 核心入口

作者日常使用 Claude Code Skill 命令：

```text
/story-init
/story-plan
/story-write 1
/story-review 1
/story-learn
/story-query
```

终端 Python CLI 是底层工具入口，主要用于调试、验证、脚本化运维，或在 Skill 流程中被调用：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --help
```

本项目不提供独立的 `story-craft <subcommand>` 命令封装，避免和 Claude Code `/story-*` 主入口混淆。

## 文档导航

具体使用说明按场景拆分在 `docs/` 目录：

- `docs/quickstart.md`：从零创建故事并完成第一章。
- `docs/claude-code-usage.md`：Claude Code `/story-*` 主入口和 Agent 编排方式。
- `docs/cli-usage.md`：终端 Python CLI 调试、验证和维护命令。
- `docs/data-formats.md`：`review.json`、`delta.json` 和章节工作台文件格式。
- `docs/troubleshooting.md`：常见失败、提交闸门和恢复方式。
- `docs/development.md`：测试、编译检查和开发验证命令。

## 当前边界

- 不做 Web dashboard。
- 不恢复长篇项目的卷级结构、合同树、投影层、RAG 和观测系统。
- 不让终端 CLI 自动伪造或替代 Claude Code Agent 输出。
- 当前没有卷号；写作和审查按章节号操作。

## 许可证

本仓库当前使用 GPL-3.0 协议，详见 `LICENSE`。

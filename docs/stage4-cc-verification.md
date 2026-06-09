# 阶段 4 Claude Code 验证清单

本清单用于区分阶段 4 已由本地脚本和 pytest 覆盖的确定性验证，和必须在
Claude Code 运行时人工确认的 slash command、hook 事件与自部署行为。

## 已自动验证

- `deployment.py`：
  - `deployment_manifest(project_type)` 覆盖短篇 4 Agent、长篇 9 Agent、13 commands、8 个 hook 文件、references、settings、`CLAUDE.md` 和 deployment sentinel。
  - `merge_claude_md` 覆盖管理 section 覆盖、用户 section 保留和幂等重复合并。
  - `merge_settings` 覆盖 hook `command` 去重、用户 `permissions`、`env` 和其它配置保留。
  - `read_deployment` / `write_deployment` 覆盖 `.story/contracts/deployment.json` 往返。
  - `needs_redeploy` 覆盖缺失、旧版本、当前版本和更高版本边界。

- hooks 模板：
  - 6 个 hook 与 `lib/common.sh`、`lib/sentinel.sh` 均存在并通过 `bash -n`。
  - `lib/common.sh` 通过 `.story/state.json` 定位项目根。
  - `lib/sentinel.sh` 通过 `python3` 读取 `.story/contracts/deployment.json`。
  - 模板中无 `.active-book`、`.story-deployed`、`discover_*book`、`/story-setup` 残留。
  - `settings-hooks.json` 合法，`post-compact.sh` 挂在 `SessionStart` 的 `source=compact` matcher。

- commands：
  - `story-craft/commands/*.md` 正好 13 个。
  - 每个 command frontmatter 含 `description`。
  - 每个 command 委托到真实存在的 `story-craft:<skill>`。
  - 长篇/短篇专属 command 含 `project_type` 误用提示。
  - 未定义 `story-migrate`、`story-cover`、`story-dashboard`、`story-short-analyze`、`story-short-scan`。

- 部署完整性 shell 回归：
  - `bash story-craft/scripts/check-story-deployment.sh` 验证 hook 依赖、settings JSON、部署清单 5 列、13 commands、commit-hook 自门控、长/短缺口检测和旧部署版本警告。

- 全量测试：
  - `python3 -B -m pytest story-craft/scripts/tests/ -q`。

## 待 Claude Code 验证

- /story-init 首次部署：
  - 真实写入 `.claude/hooks/`、`.claude/commands/`、`.claude/agents/story-craft/`、`.claude/story-craft/references/`。
  - 真实合并 `CLAUDE.md` 管理 section。
  - 真实合并 `.claude/settings.json` hooks，并保留用户 `permissions`、`env` 和自有 hooks。
  - 写入 `.story/contracts/deployment.json`，字段包含 `agents_version`、`project_type`、`setup_skill_version`、`target_cli`。

- /story-init 升级重部署：
  - 旧 `agents_version` 触发重部署。
  - managed 资产被覆盖。
  - 用户独有 `CLAUDE.md` section 和 settings 自有键不丢失。

- hook 真实触发：
  - `SessionStart` 触发 `session-start.sh`。
  - `SessionStart` 触发 `detect-story-gaps.sh`。
  - `SessionStart source=compact` 触发 `post-compact.sh`，代替无原生 `PostCompact` 的路径。
  - `SessionEnd` 触发 `session-end.sh`，且默认静默。
  - `PreToolUse(Bash, git commit*)` 触发 `validate-story-commit.sh`。
  - `PreCompact` 触发 `pre-compact.sh`。

- 13 command 真实调用：
  - 8 个共用命令在短篇和长篇项目均可调用。
  - 4 个长篇命令在短篇项目中给出 `project_type` 误用提示。
  - 1 个短篇命令在长篇项目中给出 `project_type` 误用提示。
  - 命令能委托到对应 Skill，而不重复编排逻辑。

- 多项目切换：
  - `story_craft.py use <path>` 写入 `.claude/.story-craft-current-project`。
  - `story_craft.py where` 能返回当前故事项目根。
  - 新书使用新项目目录 + `/story-init`，不恢复 `.active-book`。

## 不得标为已通过

- 未在 Claude Code 中真实执行的 slash command。
- 未在 Claude Code 中真实触发的 hook 事件。
- 未在 Claude Code 中真实跑通的 `/story-init` 首次部署或升级重部署。
- 未在 Claude Code 中确认的 `CLAUDE.md` / settings 合并效果。
- 未在 Claude Code 中确认的 `use` / `where` 多项目切换体验。

这些项目只能记录为“待 Claude Code 验证”，不能用本地 pytest 或 shell 回归结果替代。

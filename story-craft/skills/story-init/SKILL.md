---
name: story-init
description: 初始化 story-craft 中文故事项目，按 project_type short|long 写入 master 合同并选择短篇 4 核心或长篇 9 Agent 运行轨道。
allowed-tools: Read Write Grep Bash
---

# story-init

## 目标

创建一个可被 story-craft 后续短篇或长篇 Skill 使用的项目。初始化必须明确 `project_type=short|long`，并写入 `.story/contracts/master.json`，供双轨运行时读取。

底层 `init` CLI 只初始化项目本体；初始化完成后，本 Skill 还负责把 story-craft 的 Claude Code 运行时资产部署到当前项目：短篇部署 4 核心 Agent，长篇部署 9 Agent，共用 hooks、commands、references、`CLAUDE.md` 管理段和 `.claude/settings.json` hooks 注册。部署版本写入 `.story/contracts/deployment.json`，后续 `/story-init` 可根据版本自动升级重部署。

## 充分性闸门

执行 `init` 前必须确认：

- 书名、题材、目标字数、一句话梗概、核心冲突完整。
- 主角姓名、主角欲望、主角缺陷完整。
- 独特优势的类型、风格、可见度、代价完整。
- 世界观至少有时代背景、地理范围、1 条核心规则。
- 创作约束包已确定：反套路、至少 2 条硬约束、结局约束、主题句。
- 篇幅轨道明确：短篇用 `project_type=short`，长篇用 `project_type=long`。

信息不足时先继续追问，不要调用脚本。

## 流程

1. 预检项目目录和脚本入口：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" preflight --format json
```

2. 询问灵感来源：原创、参考短篇、作家风格。
3. 如果用户提供参考文本路径或摘录，先记录为初始化材料；参考拆解能力已从旧 `deconstruction-agent` 迁出，后续由 `story-import` 承接。当前初始化只采用用户明确确认的抽象约束，不能复制原作事实。
4. 收集故事基本信息、角色、独特优势、世界观。
5. 选择双轨：

- `short`：部署/使用 4 核心 Agent：`context-agent`、`narrative-writer`、`reviewer`、`data-agent`。
- `long`：部署/使用 9 Agent：`story-architect`、`character-designer`、`context-agent`、`narrative-writer`、`reviewer`、`consistency-checker`、`data-agent`、`story-explorer`、`story-researcher`。

6. 生成 2 套创作约束候选，要求用户选择或修改。
7. 展示最终初始化摘要，等待用户确认。
8. 用户确认后执行：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" init "${PROJECT_ROOT}" "${TITLE}" "${GENRE}" \
  --project-type "${PROJECT_TYPE}" \
  --word-count-target "${WORD_COUNT_TARGET}" \
  --sub-genre "${SUB_GENRE}" \
  --synopsis "${SYNOPSIS}" \
  --protagonist-name "${PROTAGONIST_NAME}" \
  --protagonist-desire "${PROTAGONIST_DESIRE}" \
  --protagonist-flaw "${PROTAGONIST_FLAW}" \
  --unique-advantage-type "${UNIQUE_ADVANTAGE_TYPE}" \
  --unique-advantage-desc "${UNIQUE_ADVANTAGE_DESC}" \
  --unique-advantage-style "${UNIQUE_ADVANTAGE_STYLE}" \
  --unique-advantage-visibility "${UNIQUE_ADVANTAGE_VISIBILITY}" \
  --unique-advantage-cost "${UNIQUE_ADVANTAGE_COST}" \
  --golden-finger "${GOLDEN_FINGER}" \
  --antagonist-mirror "${ANTAGONIST_MIRROR}" \
  --world-setting "${WORLD_SETTING}"
```

也可从配置文件初始化：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" init --from-config "${INIT_CONFIG_JSON}" --project-type "${PROJECT_TYPE}"
```

9. 验证关键文件存在：`.story/state.json`、`.story/memory.json`、`.story/project_learning.json`、`.story/contracts/master.json`、`设定集/世界观.md`、`设定集/主角卡.md`、`设定集/独特优势.md`。
10. 验证 `master.project_type` 与用户选择一致。
    此时尚未完成 Claude Code 运行时部署；不要把 CLI `init` 结果等同于 `/story-init` 完成。
11. 进入自部署编排。先读取当前部署状态，再判断是否需要部署或升级：

```python
from core.config import StoryCraftConfig
from tools.deployment import AGENTS_VERSION, read_deployment, needs_redeploy

config = StoryCraftConfig.from_project_root(PROJECT_ROOT)
current = read_deployment(config)
should_deploy = needs_redeploy(current, AGENTS_VERSION)
```

12. 若首次部署、版本落后或用户明确要求刷新，则按 `project_type` 生成清单：

```python
from tools.deployment import deployment_manifest

assets = deployment_manifest(PROJECT_TYPE)
```

13. 按 manifest 部署资产。执行规则：

- `managed + overwrite`：复制源文件到目标路径，允许覆盖 story-craft 管理资产。
- `shared + overwrite`：复制共享 reference 目录，保留目标目录外的用户自有文件。
- `shared + merge`：读取目标文件后合并，不直接覆盖用户配置。
- `deployment-sentinel`：最后写入 `.story/contracts/deployment.json`。
- 源文件缺失时停止并报告缺失资产；不要伪装部署成功。

14. 合并 `CLAUDE.md` 和 `.claude/settings.json`。必须调用 S4-02 的确定性函数：

```python
from tools.deployment import merge_claude_md, merge_settings
```

- `merge_claude_md(existing, managed_sections)` 覆盖 story-craft 标准 section，保留用户独有 section，重复执行必须幂等。
- `merge_settings(existing, managed_hooks)` 按 hook `command` 去重，保留用户 `permissions`、`env` 和其它配置键。
- `settings-hooks.json` 只注册 hooks，不替换用户已有非 story-craft hooks。

15. 写入部署 sentinel。必须调用：

```python
from tools.deployment import (
    RESOLVER_STRATEGY,
    SETUP_SKILL_VERSION,
    TARGET_CLI,
    write_deployment,
)

write_deployment(
    config,
    agents_version=AGENTS_VERSION,
    setup_skill_version=SETUP_SKILL_VERSION,
    target_cli=TARGET_CLI,
    project_type=PROJECT_TYPE,
    resolver_strategy=RESOLVER_STRATEGY,
    references_dir=".claude/story-craft/references",
)
```

16. 验证部署结果：

- `.claude/hooks/` 下 6 个 hook 与 `lib/common.sh`、`lib/sentinel.sh` 存在。
- `.claude/settings.json` 已包含 `SessionStart`、`SessionEnd`、`PreToolUse`、`PreCompact` hooks。
- `.story/contracts/deployment.json` 包含 `agents_version`、`project_type`、`setup_skill_version`、`target_cli`。
- 短篇项目目标 Agent 数为 4，长篇项目目标 Agent 数为 9。
- `CLAUDE.md` 合并后用户独有 section 仍保留。

17. 多项目收口：一项目一书。新书使用新的项目目录并重新执行 `/story-init`；项目切换使用：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" use "${PROJECT_ROOT}"
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" where
```

`use <path>` 会写入 `.claude/.story-craft-current-project` 指针，`where` 用于确认当前解析到的故事项目根。不要在一个项目根内维护多本书清单。

18. Claude Code 端真实触发属于人工验证项：首次部署、升级重部署、hooks 事件触发、settings 合并效果和 `CLAUDE.md` 合并效果需要在 S4-05 的 CC 验证清单中记录，不得标记成本地 pytest 已验证。

## 部署清单

| Source path | Target path | Owner class | Merge mode | Validation check |
|---|---|---|---|---|
| `skills/story-init/references/templates/hooks/*.sh` | `.claude/hooks/*.sh` | managed | overwrite | `bash -n` |
| `skills/story-init/references/templates/hooks/lib/common.sh` | `.claude/hooks/lib/common.sh` | managed | overwrite | `project_root` uses `.story/state.json` |
| `skills/story-init/references/templates/hooks/lib/sentinel.sh` | `.claude/hooks/lib/sentinel.sh` | managed | overwrite | reads `.story/contracts/deployment.json` |
| `agents/*.md` | `.claude/agents/story-craft/*.md` | managed | overwrite | short=4, long=9 |
| `commands/*.md` | `.claude/commands/*.md` | managed | overwrite | 13 command frontmatter files |
| `references/` | `.claude/story-craft/references/` | shared | overwrite | directory exists |
| `skills/story-init/references/templates/settings-hooks.json` | `.claude/settings.json` | shared | merge | `merge_settings` keeps user keys |
| `skills/story-init/references/templates/CLAUDE.md` | `CLAUDE.md` | shared | merge | `merge_claude_md` keeps user sections |
| `deployment-sentinel` | `.story/contracts/deployment.json` | managed | overwrite | `write_deployment` round trip |

## 失败处理

- 关键文件缺失：只重跑 `init` 或补写缺失文件，不删除项目目录。
- 部署源资产缺失：停止并列出缺失的 `source`，不写入新的 deployment sentinel。
- `CLAUDE.md` 或 settings 合并冲突：保留用户内容，输出冲突位置，等待用户确认后再覆盖 story-craft 管理段。
- 旧部署版本低于 `AGENTS_VERSION`：执行升级重部署，覆盖 managed 资产，保留 user/shared 合并内容。
- 参考分析质量不足：展示风险，不写入 canon。
- `project_type` 缺失：停止追问，不默认猜测。
- 用户未确认最终摘要：停止，不执行初始化。

## 完成条件

输出项目根路径、`project_type`、已生成文件清单、部署资产摘要、deployment sentinel 路径、启用 Agent 轨道，以及下一步建议：短篇 `/story-short-write`，长篇 `/story-long-plan`。

## 参考加载表

- 初始化题材：`references/shared/genre-profiles.md`
- 题材归一：`references/shared/csv/genre-canonical.md`
- 调性推理：`references/shared/csv/题材与调性推理.csv`
- 约束收口：`references/shared/core-constraints.md`

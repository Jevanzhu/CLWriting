# 阶段 3 Claude Code 验证清单

本清单用于区分本地 pytest 已覆盖的确定性验证，和必须在 Claude Code
运行时人工确认的 Agent/Skill 编排行为。

## 已自动验证

- Agent frontmatter：9 个 agent 均包含 `name`、`description`、`tools`、`model`。
- Skill frontmatter：17 个 skill 均包含 `name`、`description`、`allowed-tools`。
- Skill 引用：`subagent_type: "story-craft:*"` 均指向现有 agent。
- CLI 引用：Skill 中的 `story_craft.py` 顶层命令和 `agent` 子命令均存在。
- Python 工具层：
  - `tools.deslop_metrics.analyze_deslop_metrics` 覆盖 6-Gate 与 `.deslop-whitelist`。
  - `tools.repair_strength` 覆盖 `complete_rewrite`、`partial_rewrite`、`polish_only` 判定。
  - `tools.import_parser` 覆盖 txt/md/docx 读取入口和章节切分。
- 全量测试：`python3 -B -m pytest story-craft/scripts/tests/ -q`。

## 待 Claude Code 验证

- agent spawn：
  - `story-architect`
  - `character-designer`
  - `context-agent`
  - `narrative-writer`
  - `reviewer`
  - `consistency-checker`
  - `data-agent`
  - `story-explorer`
  - `story-researcher`

- reviewer full/lean/solo：
  - `solo` 能只依赖正文、合同上下文和 fallback rubric 输出 S1-S4 findings。
  - `lean` 能完成长篇默认审查，不额外 spawn 多视角 agent。
  - `full` 能 spawn 多视角 agent 并综合裁决。
  - 预检失败时能降级到 `solo`，并标注 requested/effective mode。

- 长篇写作链：
  - `/story-long-write` 能按 8 步 pipeline 执行。
  - reviewer S1/S2 阻断时停在 repair loop。
  - `data-agent` 输出 accepted_events 后，`chapter-commit` 写入 commit 真源。
  - 6 投影由 `EventProjectionRouter.dispatch()` 派发。

- 5 场景分流：
  - `daily_continue`
  - `major_revision`
  - `new_volume`
  - `open_book`
  - `import_external`

- 短篇写作链：
  - `/story-short-write` 只使用 4 核心 Agent。
  - reviewer 默认 `solo`。
  - `index/vector` lazy，不阻断短篇提交。
  - 跳过 Git 备份。

- 独立 Skill：
  - `/story-deslop` 能读取草稿和 `.deslop-whitelist`，只输出诊断。
  - `/story-repair` 能生成 `diagnosis_report`、`rewrite_chapter`、`rewrite_delta`，
    修复后重新调用 reviewer。
  - `/story-import` 能读取 txt/md/docx，调用 `data-agent` 的 chapter-extractor
    流程，重建合同后调用 `rebuild-views`。

## 不得标为已通过

- 未在 Claude Code 中真实执行的 Agent spawn。
- 未在 Claude Code 中真实跑通的 Skill pipeline。
- reviewer full/lean/solo 的真实降级路径。
- 长篇或短篇端到端写作链。
- 5 场景分流的真实路由结果。
- `story-deslop`、`story-repair`、`story-import` 的交互式运行体验。

这些项目只能记录为“待 Claude Code 验证”，不能用本地 pytest 结果替代。

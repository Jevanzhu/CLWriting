---
name: story-long-write
description: 长篇写作 Skill，按 5 场景路由执行 8 步 commit pipeline，完成单章草稿、审查、修复、润色、data-agent 事件抽取和 chapter-commit 验收。
allowed-tools: Read Write Edit Grep Bash Agent
---

# story-long-write

## 目标

为长篇项目写作、修订或导入后续章节。入口先调用 `scenario_router` 判定 5 个场景，再执行统一的 8 步 commit pipeline。

本 Skill 只定义 Claude Code 内的编排。底层 `story_craft.py` 只负责确定性校验、报告、修复计划、6-Gate 量化、data-agent 兜底抽取和 `chapter-commit` 写后真源。

## 充分性闸门

写作前必须满足：

- `master.json` 存在，且 `project_type=long`。
- `.story/contracts/chapters/chapter_NNN.json` 章节合同存在。
- 章节合同的 `must_cover`、`planned_word_count`、`expected_strand` 有效。
- 上一章已 accepted，第 1 章或开书场景除外。
- `placeholder-scan` 不发现 `[TODO]`、`[待定]`、`[XXX]` 等占位符。
- 无合同 = blocker；不得读取 `大纲/总纲.md` 反推章节合同。

## 场景路由

先运行只读场景检测：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status --chapter "${CHAPTER}"
```

然后按 `tools.scenario_router.detect_scenario` 的结果路由：

- `daily_continue`：日更续写。要求已有 accepted commit、追踪投影和下一章合同。
- `major_revision`：大修/重写。要求输入目标章、审查报告或修复目标。
- `new_volume`：开新卷。要求长篇项目、上一卷完成或用户明确开新卷；若新卷引入新设定，先回 Phase 2/plan 增量补合同。
- `open_book`：开书/首章。要求 master 合同和首章合同可读。
- `import_external`：导入既有作品后的接续。要求导入解析产物和重建后的章节合同。

若 AND 条件不满足，必须提示缺口并停止，不得静默降级到日更续写。

## 工作台

每章固定使用 `.story/workflows/ch_NN/` 保存中间产物：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent workflow --chapter "${CHAPTER}"
```

固定文件：

```text
.story/workflows/ch_NN/
├── manifest.json
├── brief.json
├── draft.md
├── review.json
├── repair.json
├── polish.json
├── delta.json
├── review-report.md
└── write-result.json
```

## 流程

固定顺序是：preflight → context-agent → narrative-writer → reviewer → repair loop → polish + 6-Gate → data-agent → chapter-commit + 6 投影。

## 8 步 Pipeline

### Step 1：preflight

运行占位符与写前合同检查：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" placeholder-scan "${DRAFT_OR_CONTRACT_FILE}"
```

闸门只读 `ChapterContract`，不读总纲 Markdown。缺少合同、章节号不连续、上一章未 accepted、占位符存在，均为 blocker。

### Step 2：context-agent

必须使用 `Agent` 工具调用 `context-agent`：

```text
Agent(
  subagent_type: "story-craft:context-agent",
  prompt: "chapter=${CHAPTER}; scenario=${SCENARIO}; project_root=${PROJECT_ROOT}; scripts_dir=${SCRIPTS_DIR}; output_file=${BRIEF_JSON}。输出五段任务书 brief.json，不写正文。"
)
```

过闸条件：

- `brief.json` 合法。
- 包含 `core_mission`、`scene_and_characters`、`continuity`、`strand_plan`、`writing_guidance`。
- `prewrite.blockers` 为空。

### Step 3：narrative-writer

必须使用 `Agent` 工具调用 `narrative-writer`：

```text
Agent(
  subagent_type: "story-craft:narrative-writer",
  prompt: "chapter=${CHAPTER}; project_root=${PROJECT_ROOT}; brief_file=${BRIEF_JSON}; output_file=${CHAPTER_DRAFT_FILE}。只写 draft.md，不写最终正文目录。"
)
```

正文必须遵守 `brief.json` 和章节合同。字数低于规划 60% 会阻断，低于 80% 会 warning。

### Step 4：reviewer

必须使用 `Agent` 工具调用 `reviewer`：

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "chapter=${CHAPTER}; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; requested_mode=lean; output_file=${REVIEW_JSON}。输出 S1-S4 findings JSON。"
)
```

生成审查报告和修复计划：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" review \
  --chapter "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --chapter-file "${CHAPTER_DRAFT_FILE}" \
  --report-file "${REVIEW_REPORT}"

python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent repair \
  --chapter "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --output-file "${REPAIR_JSON}"
```

S1/S2 或 `blocking=true` 必须停下修复，不得进入 commit。

### Step 5：repair loop

存在 blocker 时按 `repair.json` 修正 `draft.md`，然后回到 Step 4 重新审查。不得口头宣布通过，不得伪造 reviewer JSON。

### Step 6：polish + 6-Gate

生成润色计划，并用 6-Gate 去 AI 味指标辅助处理：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent polish \
  --chapter "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --output-file "${POLISH_JSON}"
```

润色只允许改表达、节奏、对白和 AI 味。若改动事实、线索、时间或角色状态，必须回到 Step 4。

### Step 7：data-agent

必须使用 `Agent` 工具调用 `data-agent`：

```text
Agent(
  subagent_type: "story-craft:data-agent",
  prompt: "chapter=${CHAPTER}; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; output_file=${DELTA_JSON}。输出 accepted_events、dominant_strand、scenes 和 style_fingerprint；不直接写 state/memory。"
)
```

过闸条件：

- `delta.json` 合法。
- 包含 `accepted_events`、`dominant_strand`、`timeline_entry`、`scenes`、`chapter_summary`。
- `scenes[]` 包含 `embedding_text`。
- 不包含正文未发生事实。

### Step 8：chapter-commit + 6 投影

只有 Step 1-7 全部过闸后，才调用 `chapter-commit`：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" chapter-commit \
  "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --delta-file "${DELTA_JSON}" \
  --result-file "${WRITE_RESULT}"
```

`chapter-commit` 写入 `.story/commits/chapter_NNN.commit.json`，然后由 `EventProjectionRouter.dispatch()` 派发 6 投影：

- `state`
- `memory`
- `summary`
- `index`
- `vector`
- `markdown_view`

单个投影失败不阻断 commit 真源，但必须写入 `write-result.json.projections`。

## Git 备份

长篇日更链可在 commit 成功后触发项目备份或用户指定 Git 备份。本阶段只写编排定义；自动 Git 备份和部署 hooks 属阶段 4。

## 失败处理

- 场景路由条件不满足：列出缺失合同、追踪投影、上一章 commit 或导入产物。
- `brief.json` 缺失或不完整：只重跑 Step 2。
- `draft.md` 有占位符或字数不足：修正文稿，从 Step 4 重审。
- reviewer 阻断：按 Step 5 修复，不进入 commit。
- 润色改动事实：回到 Step 4。
- `delta.json` 缺少事件流：只重跑 Step 7。
- `chapter-commit` rejected：查看 `write-result.json.stage`，只补失败步骤。

## 写入边界

- Agent 允许写：`.story/workflows/ch_NN/*.json`、`.story/workflows/ch_NN/draft.md`。
- CLI 允许写：`正文/*.md`、`审查报告/*.md`、`.story/commits/*.json` 和 6 投影 read-model。
- 投影只读 commit，绝不反写真源。
- 不恢复 standalone `story-craft <subcommand>` wrapper。

## CC 验证清单

- [ ] 5 个场景各触发一次，路由结果与 `scenario_router` 一致。
- [ ] `context-agent`、`narrative-writer`、`reviewer`、`data-agent` 均通过 Agent 工具真实调用。
- [ ] reviewer S1/S2 阻断时停在 repair loop。
- [ ] `data-agent` 输出 accepted_events 后，`chapter-commit` 写入 commit 真源。
- [ ] 6 投影派发结果写入 `write-result.json.projections`。
- [ ] 真实 Claude Code 端到端结果与本地 pytest 自动验证分开记录。

## 完成条件

输出：

- `brief.json`
- `draft.md`
- `review.json`
- `repair.json` / `polish.json`
- `delta.json`
- `write-result.json`
- `.story/commits/chapter_NNN.commit.json`
- 6 投影状态

## 参考加载表

- 核心约束：`references/shared/core-constraints.md`
- 审查 schema：`references/shared/review-schema.md`
- fallback rubric：`references/shared/review/fallback-rubric.md`
- 命名语调：`references/shared/naming-and-voice-gaps.md`
- 叙事线：`references/shared/strand-weave-pattern.md`
- 章节钩子：`references/long/hooks-chapter.md`
- 悬念钩子：`references/long/hooks-suspense.md`
- 段落钩子：`references/long/hooks-paragraph.md`
- 剧情核心：`references/long/plot-core-methods.md`
- 剧情框架：`references/long/plot-frameworks.md`
- 情绪弧：`references/long/emotional-arc-design.md`
- 情绪方法：`references/long/emotional-methods.md`
- 反转工具：`references/long/reversal-toolkit.md`
- 文风技法：`references/long/style-craft.md`
- 战斗打脸：`references/long/style-combat-face.md`
- 商业理论：`references/long/style-commercial-theory.md`
- 题材模块：`references/long/style-genre-modules.md`
- 对话技巧：`references/long/dialogue-mastery.md`
- 叙事单元：`references/long/narrative-units.md`
- 格式结构：`references/long/format-and-structure.md`
- 状态追踪：`references/long/state-tracking.md`
- 工件协议：`references/long/artifact-protocols.md`
- 题材公式：`references/long/genre-writing-formulas.md`
- 日更流程：`references/long/workflow-daily.md`
- 修订流程：`references/long/workflow-revision.md`

## Embedded Fallback 速查

references 加载失败时不阻断写作链，但必须降级使用本块最低口径：

- rubric：S1/S2、`blocking=true`、合同缺失和安全问题一律阻断。
- banned-words：套话、抽象升华、总结式段尾和解释性对白优先按 6-Gate 标记。
- 写作：必须保留章节合同、场景目标、章末钩子、Strand 和 accepted_events。

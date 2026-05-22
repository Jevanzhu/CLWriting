---
name: story-write
description: 为 story-craft 项目撰写下一章或指定章节。用于执行写前校验、调用 context-agent 生成任务书、起草正文、调用 reviewer 审查、润色、调用 data-agent 提取事实，并提交章节记忆时。
allowed-tools: Read Write Edit Grep Bash Agent
---

# story-write

## 目标

完成一章正文，并在审查通过后更新 `.story/chapters/ch_NN_commit.json`、`memory.json` 和 `state.json`。

推荐用法对齐参考项目，直接把章节号写在 Skill 后：

```text
/story-write 1
/story-write 3
```

如果用户没有给章节号，默认按 `.story/state.json` 的当前进度推断下一章；若推断失败，必须先询问目标章节。

本 Skill 对齐参考项目 `webnovel-write` 的职责边界：

- `/story-write` 在 Claude Code 内编排 Agent。
- `story_craft.py` 只做确定性校验、报告生成、修复计划、事实兜底抽取和提交。
- 终端 CLI 不伪造 Agent 输出，也不负责自动调用 Agent。

## 模式

默认流程固定为：

```text
准备工作台 → Agent(context-agent) → 起草正文 → Agent(reviewer)
→ review/repair → polish → Agent(data-agent) → write
```

当前不提供 `--fast` 或 `--minimal` 跳步模式。需要提速时只能减少润色轮次，不能跳过 reviewer 或 data-agent。

## 硬规则

- 必须使用 `Agent` 工具调用指定 Agent；不得由主流程口头替代 subagent 输出。
- `context-agent` 只生成任务书，不写正文。
- `reviewer` 必须输出结构化 JSON；不得由主流程伪造审查结果。
- review.json 存在 blocking issue 时不得进入提交。
- `data-agent` 只生成 delta，不直接写 `.story/state.json`、`.story/memory.json` 或 commit。
- `write` 才是唯一提交入口，accepted 才更新 state/memory。
- 失败只补跑失败步骤，不回退已通过步骤。

## 充分性闸门

写作前必须满足：

- 项目已完成 init 和 plan。
- `大纲/总纲.md` 覆盖目标章节。
- 上一章 commit 存在且 status 为 `accepted`，第 1 章除外。
- 大纲和设定中无 `[TODO]`、`[待定]`、`[XXX]` 等占位符。

## 准备：工作台目录

每章固定使用 `.story/workflows/ch_NN/` 保存中间产物。先运行：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent workflow --chapter "${CHAPTER}"
```

该命令只准备 manifest 和路径清单，不调用 Agent。

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

设置变量：

```bash
WORKFLOW_DIR="${PROJECT_ROOT}/.story/workflows/ch_${CHAPTER_PADDED}"
BRIEF_JSON="${WORKFLOW_DIR}/brief.json"
CHAPTER_DRAFT_FILE="${WORKFLOW_DIR}/draft.md"
REVIEW_JSON="${WORKFLOW_DIR}/review.json"
REPAIR_JSON="${WORKFLOW_DIR}/repair.json"
POLISH_JSON="${WORKFLOW_DIR}/polish.json"
DELTA_JSON="${WORKFLOW_DIR}/delta.json"
REVIEW_REPORT="${WORKFLOW_DIR}/review-report.md"
WRITE_RESULT="${WORKFLOW_DIR}/write-result.json"
```

## Step 1：context-agent 生成任务书

必须使用 `Agent` 工具调用 `context-agent`：

```text
Agent(
  subagent_type: "story-craft:context-agent",
  prompt: "chapter=${CHAPTER}; project_root=${PROJECT_ROOT}; scripts_dir=${SCRIPTS_DIR}; output_file=${BRIEF_JSON}。先 research，再输出 context-agent JSON 任务书；不得写正文。"
)
```

将 Agent 输出保存到 `brief.json`。若 Agent 无法写文件，由主流程用 `Write` 保存原始 JSON，不得口头总结后替代。

兜底任务书只能用于定位缺口或冒烟验证，不能替代真实 `context-agent`：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent brief \
  --chapter "${CHAPTER}" \
  --output-file "${BRIEF_JSON}"
```

过闸条件：

- `brief.json` 是合法 JSON。
- `ok=true`。
- 包含 `core_mission`、`scene_and_characters`、`continuity`、`writing_guidance`。
- `prewrite.blockers` 为空。

## Step 2：起草正文

只根据 `brief.json` 起草正文：

- 中文小说正文，不写分析。
- 不引入未授权设定。
- 按 `meta.word_count_target` 写作。
- 低于规划字数 60% 会被 `write` 阻断；低于 80% 会 warning。
- 结尾必须有钩子或情绪落点。
- 正文先写入 `draft.md`，不要直接写最终 `正文/` 目录。

## Step 3：reviewer 审查

必须使用 `Agent` 工具调用 `reviewer`：

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "chapter=${CHAPTER}; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; scripts_dir=${SCRIPTS_DIR}; output_file=${REVIEW_JSON}。严格输出 reviewer schema JSON，并保存到 output_file。"
)
```

`reviewer` 输出必须保存到 `review.json`。

生成审查报告：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" review \
  --chapter "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --chapter-file "${CHAPTER_DRAFT_FILE}" \
  --report-file "${REVIEW_REPORT}"
```

生成修复计划：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent repair \
  --chapter "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --output-file "${REPAIR_JSON}"
```

过闸条件：

- `review.json` 是合法 JSON。
- `issues[]` 中无 `blocking=true`。
- `severity=critical` 视为 blocking。

blocking 存在时：停在 Step 3，按 `repair.json` 修正文，再重新调用 reviewer。

## Step 4：润色

润色只处理表达、节奏、对白和 AI 味，不改变事实。

先生成润色计划：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent polish \
  --chapter "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --output-file "${POLISH_JSON}"
```

按 `polish.json` 修改 `draft.md`。若改动涉及事实、线索、时间或角色状态，必须回到 Step 3 重审。

## Step 5：data-agent 提取事实

必须使用 `Agent` 工具调用 `data-agent`：

```text
Agent(
  subagent_type: "story-craft:data-agent",
  prompt: "chapter=${CHAPTER}; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; scripts_dir=${SCRIPTS_DIR}; output_file=${DELTA_JSON}。只提取正文事实，生成 write 可消费的 delta；不直接写 state/memory/commit。"
)
```

`data-agent` 输出必须保存到 `delta.json`。

如真实 data-agent 暂不可用，可用兜底 delta 继续冒烟验证，但必须在最终回复中标明这是 fallback：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent extract \
  --chapter "${CHAPTER}" \
  --chapter-file "${CHAPTER_DRAFT_FILE}" \
  --output-file "${DELTA_JSON}"
```

过闸条件：

- `delta.json` 是合法 JSON。
- 包含 `chapter`、`entities_appeared`、`timeline_entry`、`chapter_summary`。
- 不包含正文里未发生的事实。

## Step 6：提交章节

只有 Step 1-5 全部过闸后，才调用 `write`：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" write \
  "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --delta-file "${DELTA_JSON}" \
  --result-file "${WRITE_RESULT}"
```

`write` 会执行最终闸门：

- 上一章 accepted commit 约束。
- 占位符扫描。
- 字数闸门。
- reviewer blocking 归一化。
- 正文复制到 `正文/`。
- 审查报告写入 `审查报告/`。
- 章节 commit 写入 `.story/chapters/`。
- 内部调用 `ChapterCommitService.commit()`，accepted 才更新 state/memory。

## 失败处理

- 工作台缺失：重跑 `agent workflow`。
- `brief.json` 缺失或 `ok=false`：重跑 Step 1，不起草正文。
- 正文不足或占位符存在：修复 `draft.md`，从 Step 3 重跑。
- reviewer blocking：按 `repair.json` 修复，从 Step 3 重跑。
- 润色改动事实：从 Step 3 重跑。
- `delta.json` 缺字段：只重跑 Step 5。
- `write-result.json` 为 rejected：查看 `stage` 和 `word_count_check`，只补失败步骤。

## 写入边界

- Agent 允许写：`.story/workflows/ch_NN/*.json`、`.story/workflows/ch_NN/draft.md`。
- CLI 允许写：`正文/*.md`、`审查报告/*.md`、`.story/chapters/*.json`、`.story/state.json`、`.story/memory.json`。
- `data-agent` 不直接写 state/memory。
- 本阶段不做 Git 备份。

## 完成条件

输出：

- `brief.json`
- `draft.md`
- `review.json`
- `repair.json` / `polish.json`
- `delta.json`
- `write-result.json`
- 最终正文文件、审查报告、commit 文件、memory/state 是否更新

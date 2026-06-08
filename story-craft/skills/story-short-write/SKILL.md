---
name: story-short-write
description: 短篇写作 Skill，使用简化 8 步 pipeline 和 4 核心 Agent，完成短篇正文、solo reviewer、轻量 deslop、data-agent 事件抽取和 chapter-commit 验收。
allowed-tools: Read Write Edit Grep Bash Agent
---

# story-short-write

## 目标

为短篇项目写作正文。短篇与长篇共用 `chapter-commit` 真源和投影链，但按 `project_type=short` 执行退化矩阵：无 `volumes/`、`style_fingerprint` 可选、4 投影实时、`index/vector` lazy、4 核心 Agent、references 只读取 short/shared。

## 充分性闸门

写作前必须满足：

- `master.json` 存在，且 `project_type=short`。
- `.story/contracts/chapters/chapter_NNN.json` 章节合同存在。
- 短篇核心框架或章节合同包含开端、升级、反转、收束的结构约束。
- `placeholder-scan` 不发现 `[TODO]`、`[待定]`、`[XXX]`。
- 无合同 = blocker；不得从 `大纲/总纲.md` 反推合同。

## 退化矩阵

- 不要求 `volumes/`。
- `style_fingerprint` 可选；存在则传给 data-agent，不存在不阻断。
- `state/memory/summary/markdown_view` 4 投影实时。
- `index/vector` 默认 lazy，仅在 query 或 rebuild 时补建。
- 只使用 4 核心 Agent：`context-agent`、`narrative-writer`、`reviewer`、`data-agent`。
- reviewer 默认 `solo` mode，不并行 spawn 多视角 Agent。
- references 只加载 `short/` 与 `shared/` 口径；没有短篇专用资料时用 shared fallback。
- 跳过 Git 备份；阶段 4 hooks 不在本 Skill 执行。

## 流程

固定顺序是：preflight → context-agent 简版任务书 → narrative-writer → reviewer solo → repair loop → polish + 轻量 deslop → data-agent → chapter-commit + 短篇投影策略。

## 8 步 Pipeline

### Step 1：preflight

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" placeholder-scan "${DRAFT_OR_CONTRACT_FILE}"
```

同时确认 `project_type=short` 和章节合同存在。短篇不检查卷合同。

### Step 2：context-agent 简版任务书

```text
Agent(
  subagent_type: "story-craft:context-agent",
  prompt: "chapter=${CHAPTER}; scenario=daily_continue; project_type=short; project_root=${PROJECT_ROOT}; output_file=${BRIEF_JSON}。输出短篇五段任务书，跳过卷级上下文。"
)
```

短篇任务书必须突出：

- 开篇问题或场景钩子。
- 反转/揭示位置。
- 情绪交付。
- 结尾回响或余韵。

### Step 3：narrative-writer

```text
Agent(
  subagent_type: "story-craft:narrative-writer",
  prompt: "chapter=${CHAPTER}; project_type=short; project_root=${PROJECT_ROOT}; brief_file=${BRIEF_JSON}; output_file=${CHAPTER_DRAFT_FILE}。只写 draft.md，不写最终正文目录。"
)
```

短篇正文要压缩铺垫，优先保证问题、升级、反转、收束完整。

### Step 4：reviewer solo

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "chapter=${CHAPTER}; project_type=short; requested_mode=solo; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; output_file=${REVIEW_JSON}。输出 S1-S4 findings JSON。"
)
```

S1/S2 或 `blocking=true` 必须停下修复。

### Step 5：repair loop

按 `repair.json` 修正 `draft.md`，然后回到 Step 4。不得跳过 reviewer。

### Step 6：polish + 轻量 deslop

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" agent polish \
  --chapter "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --output-file "${POLISH_JSON}"
```

轻量 deslop 使用 `tools.deslop_metrics.analyze_deslop_metrics` 的 6-Gate 结果。短篇只处理表达和节奏，不扩写新情节。

### Step 7：data-agent

```text
Agent(
  subagent_type: "story-craft:data-agent",
  prompt: "chapter=${CHAPTER}; project_type=short; chapter_file=${CHAPTER_DRAFT_FILE}; project_root=${PROJECT_ROOT}; output_file=${DELTA_JSON}。输出 accepted_events、dominant_strand、scenes、chapter_summary；style_fingerprint 可选。"
)
```

### Step 8：chapter-commit + 短篇投影策略

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" chapter-commit \
  "${CHAPTER}" \
  --draft-file "${CHAPTER_DRAFT_FILE}" \
  --review-results "${REVIEW_JSON}" \
  --delta-file "${DELTA_JSON}" \
  --result-file "${WRITE_RESULT}"
```

commit 成功后：

- `state/memory/summary/markdown_view` 实时更新。
- `index/vector` 可 lazy，首次 query、semantic、graph 或 rebuild 时补建。
- 不执行 Git 备份。

## 写入边界

- Agent 允许写 `.story/workflows/ch_NN/`。
- CLI 允许写最终正文、审查报告、commit 和投影。
- 不写 `volumes/`。
- 不恢复 standalone `story-craft <subcommand>` wrapper。

## 失败处理

- 项目不是 short：停止，提示改用 `/story-long-write`。
- 章节合同缺失：停止，提示先运行短篇规划或导入。
- reviewer 阻断：按 repair loop 处理。
- deslop heavy：先降 AI 味，再回 reviewer。
- data-agent 缺事件流：只重跑 Step 7。

## CC 验证清单

- [ ] 短篇项目能走 4 核心 Agent。
- [ ] reviewer 默认 solo。
- [ ] `style_fingerprint` 缺失不阻断。
- [ ] `index/vector` lazy 策略不阻断 commit。
- [ ] `chapter-commit` 与长篇共用真源链。

## 完成条件

输出 `brief.json`、`draft.md`、`review.json`、`polish.json`、`delta.json`、`write-result.json` 和短篇正文。

---
name: story-repair
description: 基于 reviewer JSON 的章节修复 Skill，按诊断报告、重写章节、rewrite_delta 三段式执行，并自动判定修复强度。
allowed-tools: Read Write Edit Grep Bash Agent
---

# story-repair

## 目标

根据 reviewer JSON 修复草稿或章节。修复必须走三段式：`diagnosis_report`、`rewrite_chapter`、`rewrite_delta`。强度由确定性规则自动判定为 `complete_rewrite`、`partial_rewrite` 或 `polish_only`。

## 充分性闸门

开始前必须满足：

- `project_root` 明确。
- `chapter` 或 `chapter_file` 明确。
- reviewer JSON 存在且可解析。
- reviewer JSON 包含 `issues` 数组和 `summary` 字符串。
- 修复后必须复审；不得跳过 reviewer，也不得直接验收 commit。

## 强度自动判定

调用本地 repair 强度判定逻辑，按 reviewer findings 统计：

- `complete_rewrite`：`critical>=3 或 major>=5`。
- `partial_rewrite`：`critical 1-2 或 major 3-4`。
- `polish_only`：仅 minor、S4 或非阻断表达问题。

S1/S2、`blocking=true`、`severity=critical` 必须按阻断处理。缺少 severity 的 issue 不能默认降级为 minor，必须先要求 reviewer 输出可用 JSON。

## 流程

1. 读取 reviewer JSON 并判定强度。工具入口是 `repair --review-results`：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" repair \
  --chapter "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --draft-file "${CHAPTER_FILE}" \
  --output-file "${WORKFLOW_DIR}/repair-plan.json"
```

2. 生成 `diagnosis_report`：

- 列出阻断项、证据、位置和修复策略。
- 标明自动判定强度。
- 标明不得跳过复审。

3. 生成 `rewrite_chapter`：

- `complete_rewrite`：重写章节结构和关键场景，但不得新增合同外核心事实。
- `partial_rewrite`：只重写问题段落、场景衔接或角色行为链。
- `polish_only`：只处理表达、节奏、AI 味和局部对白。

4. 生成 `rewrite_delta`：

- 记录新增、删除、改写的剧情事实。
- 标注是否影响 `accepted_events`、`dominant_strand`、`scenes` 和角色状态。
- 不直接写入 commit store。

5. 重新调用 reviewer 复审：

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "chapter=${CHAPTER}; chapter_file=${REWRITE_CHAPTER}; project_root=${PROJECT_ROOT}; requested_mode=${REQUESTED_MODE}; output_file=${REREVIEW_JSON}。复审修复后版本，输出 S1-S4 findings JSON。"
)
```

6. 复审仍有 S1/S2 或 `blocking=true` 时，回到 Step 1；复审通过后再交由写作链或 `chapter-commit` 处理。

## 写入边界

- 允许写 `.story/workflows/ch_NN/diagnosis_report.md`。
- 允许写 `.story/workflows/ch_NN/rewrite_chapter.md`。
- 允许写 `.story/workflows/ch_NN/rewrite_delta.json`。
- 不直接覆盖最终正文，除非用户明确要求并确认目标路径。
- 不写 state、memory、commit、合同或投影。
- 不执行 `chapter-commit`；验收必须由写作链继续处理。

## 失败处理

- reviewer JSON 缺失或非法：停止，要求先 `/story-review`。
- issue 缺少可判定 severity：停止，要求 reviewer 重试。
- repair 命令失败：保留原正文，不写半成品到最终正文目录。
- 复审失败：展示剩余 blocking，继续 repair loop。
- 用户要求跳过复审：拒绝，并说明修复后必须 reviewer 复审。

## CC 验证清单

- [ ] Claude Code 中 `/story-repair` 能读取 reviewer JSON。
- [ ] `complete_rewrite`、`partial_rewrite`、`polish_only` 三档能正确分流。
- [ ] 三段式产物路径正确。
- [ ] 修复后会调用 reviewer 复审。
- [ ] 复审未通过时不会进入 `chapter-commit`。

## 完成条件

输出 `diagnosis_report`、`rewrite_chapter`、`rewrite_delta`、复审结果和下一步建议：继续修复、交回写作链、或进入章节验收。

## 参考加载表

- 审查 schema：`references/shared/review-schema.md`
- fallback rubric：`references/shared/review/fallback-rubric.md`
- blocking 决策：`references/shared/review/blocking-override-guidelines.md`
- 核心约束：`references/shared/core-constraints.md`
- 命名语调：`references/shared/naming-and-voice-gaps.md`

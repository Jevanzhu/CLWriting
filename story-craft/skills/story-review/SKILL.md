---
name: story-review
description: 对 story-craft 项目中已有章节进行独立审校，按 reviewer full/lean/solo 三档 mode 输出 S1-S4 findings 与审查报告。
allowed-tools: Read Write Grep Bash Agent
---

# story-review

## 目标

对指定章节做结构化审查，输出 `审查报告/第NN章审查报告.md`。短篇默认 `solo`，长篇默认 `lean`，用户明确要求深审且环境满足时可用 `full`。

推荐用法对齐参考项目，直接把章节号写在 Skill 后：

```text
/story-review 1
/story-review 3
```

如果用户没有给章节号，必须先从用户输入或当前项目状态推断目标章节；无法确定时先询问。

## 充分性闸门

开始前必须满足：

- `.story/state.json` 和 `.story/memory.json` 存在。
- 指定章节正文文件存在且非空。
- 章节号明确。
- reviewer mode 明确：`full`、`lean` 或 `solo`。

## 流程

1. 定位章节文件。优先使用用户提供路径，否则按 `chapter_paths.find_chapter_file()` 查找。
2. 读取项目类型和上下文：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query context --chapter "${CHAPTER}"
```

3. 选择 reviewer mode：

- `project_type=short`：默认 `solo`。
- `project_type=long`：默认 `lean`。
- `full`：只能在 9 Agent 定义完整且用户要求深审时使用；预检失败自动降级 `solo`。

4. 调用 `reviewer`：

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "chapter=${CHAPTER}; chapter_file=${CHAPTER_FILE}; project_root=${PROJECT_ROOT}; requested_mode=${REQUESTED_MODE}; output_file=${REVIEW_JSON}。输出 S1-S4 findings JSON。"
)
```

5. 将 reviewer 输出保存为临时 JSON，并生成报告：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" review \
  "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --chapter-file "${CHAPTER_FILE}" \
  --report-file "${REPORT_FILE}"
```

6. 如存在 blocking 问题，展示问题清单并询问处理方式：修复、跳过、标记为非阻断。

reviewer 原始 JSON 必须包含 `issues` 数组和 `summary` 字符串。`S1/S2`、`blocking=true` 或 `severity=critical` 会被本地归一化为阻断项；不要要求 reviewer 输出 `passed`、`blockers` 或 `warnings`。

## 审查边界

- 不自动验收章节。
- 不自动改正文，除非用户明确要求修复。
- 不将 reviewer 的主观建议写入 memory。
- 独立审查可以用于已验收章节或草稿章节。

## 失败处理

- 正文缺失：停止并提示可用章节文件。
- reviewer 输出不是合法 JSON，或缺少 `issues` / `summary`：要求重试一次。
- requested_mode=full 预检失败：接受 reviewer 降级 `effective_mode=solo`，并在报告中标注 fallback。
- 报告写入失败：保留 reviewer 原始输出，提示路径错误。

## 完成条件

输出审查报告路径、requested/effective mode、blocking 数量、建议下一步：修复正文、重新审查或继续写作。

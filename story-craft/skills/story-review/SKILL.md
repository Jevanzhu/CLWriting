---
name: story-review
description: 对 story-craft 项目中已有章节进行独立审校。用于读取正文、调用 reviewer、生成审查报告，并协助处理 blocking 问题时。
---

# story-review

## 目标

对指定章节做结构化审查，输出 `审查报告/第NN章审查报告.md`。

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

## 流程

1. 定位章节文件。优先使用用户提供路径，否则按 `chapter_paths.find_chapter_file()` 查找。
2. 加载项目上下文：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query context --chapter "${CHAPTER}"
```

3. 调用 `reviewer`：

```json
{
  "chapter": 1,
  "chapter_file": "正文/第01章-标题.md",
  "project_root": "/path/to/project"
}
```

4. 将 reviewer 输出保存为临时 JSON，并生成报告：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" review \
  "${CHAPTER}" \
  --review-results "${REVIEW_JSON}" \
  --chapter-file "${CHAPTER_FILE}" \
  --report-file "${REPORT_FILE}"
```

5. 如存在 blocking 问题，展示问题清单并询问处理方式：修复、跳过、标记为非阻断。

reviewer 原始 JSON 必须包含 `issues` 数组和 `summary` 字符串。`blocking=true` 或 `severity=critical` 会被本地归一化为阻断项；不要要求 reviewer 输出 `passed`、`blockers` 或 `warnings`。

## 审查边界

- 不自动验收章节。
- 不自动改正文，除非用户明确要求修复。
- 不将 reviewer 的主观建议写入 memory。
- 独立审查可以用于已验收章节或草稿章节。

## 失败处理

- 正文缺失：停止并提示可用章节文件。
- reviewer 输出不是合法 JSON，或缺少 `issues` / `summary`：要求重试一次。
- 报告写入失败：保留 reviewer 原始输出，提示路径错误。

## 完成条件

输出审查报告路径、blocking 数量、建议下一步：修复正文、重新审查或继续写作。

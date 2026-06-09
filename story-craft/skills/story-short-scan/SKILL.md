---
name: story-short-scan
description: 短篇扫描 Skill，执行占位符、AI 味、结构缺口和结尾回响风险扫描。
allowed-tools: Read Grep Bash Agent
---

# story-short-scan

## 目标

对短篇项目或草稿做轻量扫描：占位符、短篇结构缺口、AI 味 6-Gate、反转/回收风险和结尾回响风险。

## 充分性闸门

开始前必须满足：

- 目标文件或项目根目录可读。
- 扫描范围明确。

范围不明确时先询问，不默认扫描整个仓库。

## 流程

1. 执行占位符扫描：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" placeholder-scan "${TARGET_FILE}"
```

2. 使用 6-Gate 扫描 AI 味：

- 禁用词密度。
- 连续排比段数。
- 心理词占比。
- 对话标签密度。
- 平均段落句数。
- 重复描写密度。

3. 检查短篇结构：

- 是否有开篇问题。
- 是否有升级压力。
- 是否有反转/揭示。
- 是否有结尾回响。

4. 必要时调用 `reviewer` 的 `solo` mode 做结构化 findings：

```text
Agent(
  subagent_type: "story-craft:reviewer",
  prompt: "project_type=short; requested_mode=solo; chapter_file=${TARGET_FILE}; project_root=${PROJECT_ROOT}; output_file=${SCAN_REVIEW_JSON}。只做短篇扫描，不改正文。"
)
```

## 写入边界

- 默认只读。
- 不改正文，不写 commit。
- 不调用 `data-agent`。
- 不执行 Git 备份。

## 失败处理

- 目标文件缺失：报告缺失路径，不创建文件。
- 占位符扫描失败：返回命令错误和下一步。
- reviewer 不可用：输出本地扫描结果，并标记待 CC 验证。

## CC 验证清单

- [ ] 单文件短篇扫描可运行。
- [ ] reviewer solo 可输出 S1-S4 findings。
- [ ] 扫描无写入。
- [ ] AI 味 heavy 能被标成 blocker 或 warning。

## 完成条件

输出扫描报告，包含占位符、结构缺口、AI 味指标、结尾风险和下一步建议。

## 参考加载表

- 短篇阅读力：`references/short/reading-power-taxonomy.md`
- 剧透信号：`references/short/plot-signal-vs-spoiler.md`
- 审查 schema：`references/shared/review-schema.md`
- fallback rubric：`references/shared/review/fallback-rubric.md`
- 核心约束：`references/shared/core-constraints.md`

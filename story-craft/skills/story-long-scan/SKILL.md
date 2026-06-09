---
name: story-long-scan
description: 长篇扫描 Skill，执行占位符扫描、一致性 grep-first 检查、合同缺口和写作前风险清单。
allowed-tools: Read Grep Bash Agent
---

# story-long-scan

## 目标

对长篇项目执行写前或阶段性扫描：占位符、合同缺口、一致性风险、章节状态和可疑 canon 冲突。

## 充分性闸门

开始前必须满足：

- 项目根目录可定位。
- 需要扫描的目标范围明确：全项目、某卷、某章或某个文件。

目标范围不明确时先询问，不默认扫描整个仓库。

## 流程

1. 确定扫描范围：

- 全项目：合同、正文、追踪、设定。
- 某章：章节合同、draft、review、commit。
- 某卷：volume 合同和章范围。
- 单文件：直接扫描目标文件。

2. 执行占位符扫描：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" placeholder-scan "${TARGET_FILE}"
```

3. 对正文或合同执行 grep-first 一致性检查。需要 Agent 时调用：

```text
Agent(
  subagent_type: "story-craft:consistency-checker",
  prompt: "project_root=${PROJECT_ROOT}; chapter=${CHAPTER}; chapter_file=${CHAPTER_FILE}; output_file=${SCAN_JSON}。grep-first 查证，只报告可证实问题。"
)
```

4. 查询项目健康状态：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" health
```

5. 输出扫描报告：

- 占位符列表。
- 合同缺口。
- 一致性 findings。
- 写作前 blocker。
- 可延后 warning。

## 写入边界

- 默认只读。
- 不修复正文，不改合同。
- 不调用 `narrative-writer`。
- 若用户要求修复，转入 `story-long-write` 的 `major_revision` 场景或后续 `story-repair`。

## 失败处理

- 目标文件缺失：报告缺失路径，不创建新文件。
- `placeholder-scan` 失败：返回命令 stderr 和下一步。
- `consistency-checker` 不可用：只输出本地 scan 结果，并标记待 CC 验证。

## CC 验证清单

- [ ] 单文件 placeholder-scan 可运行。
- [ ] 某章扫描可调用 `consistency-checker`。
- [ ] 扫描过程无写入。
- [ ] findings 与 reviewer schema 兼容。

## 完成条件

输出扫描报告，清楚区分 blocker、warning 和待 Claude Code 验证项。

## 参考加载表

- 审查 schema：`references/shared/review-schema.md`
- fallback rubric：`references/shared/review/fallback-rubric.md`
- 核心约束：`references/shared/core-constraints.md`
- 格式结构：`references/long/format-and-structure.md`
- 状态追踪：`references/long/state-tracking.md`
- 读者画像：`references/long/genre-readers.md`

## Embedded Fallback 速查

references 加载失败时不阻断扫描，但必须降级使用本块最低口径：

- rubric：占位符、合同缺口、S1/S2 和 `blocking=true` 都按 blocker 输出。
- banned-words：模板化结尾、总结式升华和解释性对白按 6-Gate 风险标注。
- 扫描：坚持 grep-first，只报告可证实问题，不生成新剧情事实。

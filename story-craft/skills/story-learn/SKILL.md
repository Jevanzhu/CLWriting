---
name: story-learn
description: 记录 story-craft 项目的双轨共享写作经验和反复出现的问题，写入 project_learning.json 供 short/long context 使用。
allowed-tools: Read Write Bash
---

# story-learn

## 目标

把可复用的项目级写作经验写入 `.story/project_learning.json`，供后续 short/long 的 context-agent 和 writing checklist 使用。

## 充分性闸门

写入前必须确认：

- 项目根存在。
- 章节号明确。
- `description` 和 `instruction` 非空。
- `pattern_type` 可归类为：`hook`、`pacing`、`dialogue`、`payoff`、`emotion`、`format`、`other`。
- 明确适用轨道：短篇、长篇或 shared。当前 CLI 不存轨道字段时，在 `description` 或 `instruction` 中写清适用范围。

## 流程

1. 读取当前项目：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query learning
```

2. 协助用户归类：

- `hook`：开篇钩子、章末钩子。
- `pacing`：节奏、信息密度、场景长短。
- `dialogue`：对白信息量、角色口吻。
- `payoff`：伏笔回收、承诺兑现。
- `emotion`：情绪表达、关系推进。
- `format`：排版、标点、章节格式。
- `other`：其他。

3. 形成记录：

- `chapter`：关联章节。
- `pattern_type`：归类。
- `description`：问题或模式描述。
- `example`：正例或反例，可为空但建议提供。
- `instruction`：后续写作必须遵守的具体指令。
- `scope`：若只适用短篇或长篇，在 instruction 中显式写“仅短篇”或“仅长篇”。

4. 写入：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" learn \
  --chapter "${CHAPTER}" \
  --pattern-type "${PATTERN_TYPE}" \
  --description "${DESCRIPTION}" \
  --example "${EXAMPLE}" \
  --instruction "${INSTRUCTION}"
```

5. 查询确认：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query learning --pattern-type "${PATTERN_TYPE}"
```

## 写入边界

- 只写 `.story/project_learning.json`。
- 不修改正文、memory 或 state。
- 不记录一次性偏好；只记录后续可复用的模式。
- 不把 reviewer 的一次性修复建议直接升级为全局规则，除非用户确认。

## 失败处理

- 分类不清：先用 `other`，但 instruction 必须具体。
- instruction 太抽象：改写为可检查规则。
- 重复记录：可以保留，但建议合并为更强规则。

## 完成条件

输出新增 pattern id、类型、适用轨道、指令，以及它会在后续 `/story-short-write` 或 `/story-long-write` 的 guidance 中生效。

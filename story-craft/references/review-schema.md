# 审查输出 Schema

本文件定义 `reviewer` 和 `/story-review` 的原始结构化输出口径。
审查目标是判断章节是否能进入验收或继续写作，而不是追求文学评论完整性。

## 顶层结构

```json
{
  "issues": [],
  "summary": ""
}
```

## issue 字段

```json
{
  "severity": "critical",
  "category": "continuity",
  "location": "第12段",
  "description": "问题描述",
  "evidence": "正文证据",
  "fix_hint": "修复建议",
  "blocking": true
}
```

## severity

- `critical`：会破坏主线、事实连续性、人物动机或安全边界，必须 blocking。
- `high`：明显影响阅读和本章目标，通常需要修复。
- `medium`：局部表达、节奏或细节问题，可非阻断处理。
- `low`：提示或改进建议，不影响验收。

## category

- `setting`：时代、规则、独特优势、能力边界。
- `timeline`：本章开始时间、场景切换、倒计时和同时在场。
- `continuity`：人物、世界规则、伏笔连续性。
- `character`：欲望、缺陷、动机、关系变化。
- `logic`：因果链、行动代价、规则后果。
- `pacing`：节奏、信息密度、场景长度。
- `ai_flavor`：AI 味、抽象情绪、解释型对白、泛化比喻。
- `format`：格式、文件、设定材料缺失等结构性问题。

## blocking 判定

以下情况必须 `blocking=true`：

- 本章没有完成大纲要求的核心目标。
- 关键事实与 `memory.json` 或设定集冲突。
- 角色关键选择缺少动机。
- 结尾打开重大新问题却没有回收计划。
- 系统性 AI 味问题贯穿整章，影响正文可信度。
- 存在安全、版权或用户明确禁止的内容。

## 本地归一化

`story-craft` 在本地会把原始 `issues` 归一化为 `blockers`、`warnings`
和 `passed`。验收闸门只认归一化后的 `blockers` 列表，不依赖原始计数字段。
原始输出不要提供 `suggestions`；可执行修复建议统一写入对应 issue 的
`fix_hint`。本地归一化会忽略历史输入中的 `suggestions` 字段。

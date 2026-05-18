# 审查输出 Schema

本文件定义 `reviewer` 和 `/story-review` 的结构化输出口径。
审查目标是判断章节是否能进入提交或继续写作，而不是追求文学评论完整性。

## 顶层结构

```json
{
  "passed": true,
  "summary": "",
  "blockers": [],
  "warnings": [],
  "suggestions": [],
  "anti_ai_force_check": "pass"
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
- `major`：明显影响阅读和本章目标，通常需要修复。
- `minor`：局部表达、节奏或细节问题，可非阻断处理。
- `note`：提示或改进建议，不影响提交。

## category

- `structure`：本章目标、冲突、转折、章末变化。
- `continuity`：人物、时间线、世界规则、伏笔连续性。
- `character`：欲望、缺陷、动机、关系变化。
- `pacing`：节奏、信息密度、场景长度。
- `style`：语言、句式、视角、语调。
- `anti_ai`：AI 味、抽象情绪、解释型对白、泛化比喻。
- `safety`：不当内容、隐私、版权或用户边界。

## blocking 判定

以下情况必须 `blocking=true`：

- 本章没有完成大纲要求的核心目标。
- 关键事实与 `memory.json` 或设定集冲突。
- 角色关键选择缺少动机。
- 结尾打开重大新问题却没有回收计划。
- `anti_ai_force_check=fail` 且问题贯穿整章。
- 存在安全、版权或用户明确禁止的内容。

## anti_ai_force_check

- `pass`：没有系统性 AI 味问题。
- `warn`：有局部问题，可通过润色修复。
- `fail`：整章存在模板化、抽象化或解释化问题，必须返修。

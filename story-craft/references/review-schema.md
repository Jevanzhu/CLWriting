# 审查输出 Schema

本文件定义 `reviewer` 和 `/story-review` 的结构化输出口径。
审查目标是判断章节是否能进入验收或继续写作，而不是追求文学评论完整性。

阶段 3 起推荐输出 S1-S4 findings；本地归一化仍兼容旧
`critical/high/medium/low` 与 `description/fix_hint` 字段，避免既有写入链断裂。

## 顶层结构

```json
{
  "issues": [],
  "summary": "",
  "meta": {
    "requested_mode": "lean",
    "effective_mode": "solo",
    "fallback_reason": "",
    "rubric_source": "references/review-schema.md"
  }
}
```

## issue 字段

```json
{
  "severity": "S2",
  "category": "continuity",
  "location": "第12段",
  "evidence": "正文证据",
  "issue": "问题描述",
  "fix": "修复建议",
  "blocking": true
}
```

## severity

- `S1`：阻断级。安全、版权、合同核心目标失败、关键 canon 冲突等，不可降级。
- `S2`：高风险。严重影响本章验收、读者牵引或连续性，默认 blocking。
- `S3`：普通修复。局部节奏、表达、AI 味或逻辑补丁，默认 warning。
- `S4`：观察项。可选优化或后续追踪，不影响当前验收。

兼容输入：

- `critical` 会归一化为 blocking。
- `high/medium/low` 保持非强制阻断，除非原始 `blocking=true`。

## category

阶段 3 标准 14 类：

- `high_point`：爽点、情绪交付、章节卖点兑现。
- `consistency`：设定、人物、物品、能力边界综合一致性。
- `pacing`：节奏、信息密度、场景长度、段落推进。
- `ooc`：角色动机、语言风格、信息来源越界。
- `continuity`：上章钩子、伏笔、承接和场景过渡。
- `reader_pull`：章尾牵引、信息差、期待管理。
- `setting`：时代、规则、独特优势、能力边界。
- `timeline`：本章开始时间、场景切换、倒计时和同时在场。
- `logic`：因果链、行动代价、规则后果。
- `ai_flavor`：AI 味、抽象情绪、解释型对白、泛化比喻。
- `format`：格式、文件、设定材料缺失等结构性问题。
- `safety`：安全、版权、用户禁区、敏感内容边界。
- `contract`：章节合同、写前约束、must_cover/forbidden_zones。
- `strand`：quest/fire/constellation 叙事线比例和章节功能偏差。

兼容输入可继续使用旧 `character` 分类；本地归一化会接受，但新 reviewer 输出应优先使用 `ooc` 或 `consistency`。

## blocking 判定

以下情况必须 `blocking=true`：

- `S1` 或 `S2` severity。
- 本章没有完成 `ChapterContract.must_cover` 核心目标。
- 关键事实与合同、commit、`memory.json` 或设定集冲突。
- 角色关键选择缺少动机。
- 结尾打开重大新问题却没有回收计划。
- 系统性 AI 味问题贯穿整章，影响正文可信度。
- 存在安全、版权或用户明确禁止的内容。

## 6-Gate 量化

reviewer 的 AI 味量化由 `tools/deslop_metrics.py` 提供，包含：

- 禁用词密度。
- 连续排比段数。
- 心理词占比。
- 对话标签密度。
- 平均段落句数。
- 重复描写密度。

任一指标达到 `heavy` 时，至少生成一个 `ai_flavor` 的 S2 finding。

## fallback rubric

当题材 rubric 或多 Agent full mode 不可用时，启用
`references/review/fallback-rubric.md`。输出 meta 中必须写明
`rubric_source=fallback` 或 `Rubric Source: fallback`。

## 本地归一化

`story-craft` 在本地会把原始 `issues` 归一化为 `blockers`、`warnings`
和 `passed`。验收闸门只认归一化后的 `blockers` 列表，不依赖原始计数字段。
原始输出不要提供 `suggestions`；可执行修复建议统一写入对应 issue 的
`fix`。兼容输入可继续使用 `fix_hint`。

归一化规则：

- `issue` 与 `description` 会互相补齐。
- `fix` 与 `fix_hint` 会互相补齐。
- `S1/S2` 一律进入 `blockers`，即使原始 `blocking=false`。
- `critical` 一律进入 `blockers`。
- 历史输入中的 `suggestions` 字段会被忽略。

# 参考加载映射

本文件说明 Skill 和 Agent 何时读取哪些共享参考。
读取参考时要保持最小化，只加载当前任务需要的文件。

## Skill 映射

- `/story-init`
  - 总是可读：`references/genre-profiles.md`
  - 按需可读：`references/csv/题材与调性推理.csv`
  - 按题材可读：`genres/<pack>/README.md`
  - 参考文本分析后：`references/shared/core-constraints.md`

- `/story-plan`
  - 总是可读：`references/outlining/plot-signal-vs-spoiler.md`
  - 按需可读：`references/shared/strand-weave-pattern.md`
  - 复合题材：`references/genre-profiles.md`
  - 按题材可读：`genres/<pack>/patterns.md`

- `/story-write`
  - 总是可读：`references/shared/core-constraints.md`
  - 按需可读：`references/shared/naming-and-voice-gaps.md`
  - 多线中篇：`references/shared/strand-weave-pattern.md`
  - 按题材可读：`genres/<pack>/checklist.md`

- `/story-long-write`
  - 总是可读：`references/shared/core-constraints.md`
  - 总是可读：`references/review-schema.md`
  - 场景路由：读取 `ChapterContract`、commit 摘要和 `tools.scenario_router.detect_scenario` 结果。
  - 叙事线：按需可读 `references/shared/strand-weave-pattern.md`。
  - AI 味：按需可读 `references/review/fallback-rubric.md`。
  - 按题材可读：`genres/<pack>/checklist.md`

- `/story-long-plan`
  - 总是可读：`references/outlining/plot-signal-vs-spoiler.md`
  - 总是可读：`references/shared/strand-weave-pattern.md`
  - 编排：`story-architect` 生成 master/volumes/chapters，`character-designer` 生成 character_registry。
  - 按题材可读：`genres/<pack>/patterns.md`

- `/story-long-analyze`
  - 默认只读项目数据：status、memory、quality、entity-graph。
  - 叙事线：调用 `tools.strand_calculator.evaluate_strand_balance`。
  - 用户询问参考口径时读取本目录对应文件。

- `/story-long-scan`
  - 默认只读项目数据。
  - 占位符：调用 `placeholder-scan`。
  - 一致性：按需调用 `consistency-checker`。
  - blocking 口径：按需读取 `references/review-schema.md`。

- `/story-short-write`
  - 总是可读：`references/shared/core-constraints.md`
  - 短篇退化：只使用 4 核心 Agent，reviewer solo，index/vector lazy。
  - AI 味：按需可读 `references/review/fallback-rubric.md`。
  - 按题材可读：`genres/<pack>/checklist.md`

- `/story-short-analyze`
  - 默认只读短篇合同、正文、memory 和质量趋势。
  - AI 味：调用 `tools.deslop_metrics.analyze_deslop_metrics`。
  - 用户询问参考口径时读取 shared/short 相关文件。

- `/story-short-scan`
  - 默认只读项目数据。
  - 占位符：调用 `placeholder-scan`。
  - reviewer：按需用 solo mode 输出 S1-S4 findings。
  - 不触发 data-agent 或 commit。

- `/story-review`
  - 总是可读：`references/review-schema.md`
  - 总是可读：`references/shared/core-constraints.md`
  - blocking 决策：`references/review/blocking-override-guidelines.md`

- `/story-learn`
  - 按需可读：`references/csv/写作技法.csv`
  - 按需可读：`references/shared/payoff-points-guide.md`

- `/story-query`
  - 默认只读项目数据。
  - 用户询问参考口径时读取本目录对应文件。

## Agent 映射

- `story-architect`：大纲方法、主线/支线、节奏与卷章结构参考。
- `character-designer`：人设关系、角色动机、对照关系和命名语调参考。
- `context-agent`：核心约束、命名语调、多线压缩、anti_patterns。
- `narrative-writer`：核心约束、场景写法、对话、去 AI 味和题材包。
- `reviewer`：审查 schema、fallback rubric、核心约束、blocking 覆盖指南、Strand 诊断。
- `consistency-checker`：核心约束、已确认合同和 commit 投影视图；grep-first 查证。
- `data-agent`：不读取创作参考，优先从正文抽取事实并输出 accepted_events。
- `story-explorer`：默认只读项目数据；用户询问参考口径时读取本目录对应文件。
- `story-researcher`：资料来源记录、核心约束和 canon 污染边界。

## 淘汰迁移

- 旧 `deconstruction-agent` 已在阶段 3 淘汰：风格指纹迁入 `data-agent`，参考拆解迁入 `story-import`。

## 流派包映射

- `realistic`：现实题材、都市日常、职场婚恋、年代。
- `rules-mystery`：悬疑灵异、规则怪谈、悬疑脑洞、女频悬疑。
- `dog-blood-romance`：狗血言情、替身文、豪门总裁、现言脑洞、青春甜宠。
- `period-drama`：历史古代、历史脑洞、古言、宫斗宅斗、民国言情。
- `xuanhuan`：修仙、高武、西幻、都市异能、系统流。
- `zhihu-short`：知乎短篇、家庭反击、职场打脸、身份反转。

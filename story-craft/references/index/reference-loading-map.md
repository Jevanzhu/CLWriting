# 参考加载映射

本文件说明 Skill 和 Agent 何时读取哪些共享参考。
读取参考时要保持最小化，只加载当前任务需要的文件。

## 三分边界

- 短篇：读取 `references/short/` + `references/shared/`，不默认加载 `references/long/`。
- 长篇：读取 `references/long/` + `references/shared/`；S5-02 已引入长篇方法论，S5-03 再细化按需加载映射。
- 共用：读取 `references/shared/` 与必要题材包 `genres/<pack>/`。
- `references/index/` 只保存加载映射和缺口登记，不作为创作参考正文加载。

## Skill 映射

- `/story-init`
  - 初始化题材：`references/shared/genre-profiles.md`
  - 题材归一：`references/shared/csv/genre-canonical.md`
  - 调性推理：`references/shared/csv/题材与调性推理.csv`
  - 约束收口：`references/shared/core-constraints.md`
  - 双轨：`project_type=short` 启用 4 核心 Agent，`project_type=long` 启用 9 Agent。

- `/story-plan`
  - 短篇信号：`references/short/plot-signal-vs-spoiler.md`
  - 多线压缩：`references/shared/strand-weave-pattern.md`
  - 复合题材：`references/shared/genre-profiles.md`
  - 桥段候选：`references/shared/csv/桥段套路.csv`
  - 爽点节奏：`references/shared/csv/爽点与节奏.csv`

- `/story-write`
  - 核心约束：`references/shared/core-constraints.md`
  - 命名语调：`references/shared/naming-and-voice-gaps.md`
  - 多线中篇：`references/shared/strand-weave-pattern.md`
  - 短篇阅读力：`references/short/reading-power-taxonomy.md`
  - 场景写法：`references/shared/csv/场景写法.csv`

- `/story-long-write`
  - 核心约束：`references/shared/core-constraints.md`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 命名语调：`references/shared/naming-and-voice-gaps.md`
  - 叙事线：`references/shared/strand-weave-pattern.md`
  - 章节钩子：`references/long/hooks-chapter.md`
  - 悬念钩子：`references/long/hooks-suspense.md`
  - 段落钩子：`references/long/hooks-paragraph.md`
  - 剧情核心：`references/long/plot-core-methods.md`
  - 剧情框架：`references/long/plot-frameworks.md`
  - 情绪弧：`references/long/emotional-arc-design.md`
  - 情绪方法：`references/long/emotional-methods.md`
  - 反转工具：`references/long/reversal-toolkit.md`
  - 文风技法：`references/long/style-craft.md`
  - 战斗打脸：`references/long/style-combat-face.md`
  - 商业理论：`references/long/style-commercial-theory.md`
  - 题材模块：`references/long/style-genre-modules.md`
  - 对话技巧：`references/long/dialogue-mastery.md`
  - 叙事单元：`references/long/narrative-units.md`
  - 格式结构：`references/long/format-and-structure.md`
  - 状态追踪：`references/long/state-tracking.md`
  - 工件协议：`references/long/artifact-protocols.md`
  - 题材公式：`references/long/genre-writing-formulas.md`
  - 日更流程：`references/long/workflow-daily.md`
  - 修订流程：`references/long/workflow-revision.md`

- `/story-long-plan`
  - 开篇设计：`references/long/opening-design.md`
  - 大纲方法：`references/long/outline-methods.md`
  - 结构理论：`references/long/outline-structure-theory.md`
  - 节奏控制：`references/long/outline-rhythm.md`
  - 角色基础：`references/long/character-basics.md`
  - 角色设计：`references/long/character-design-methods.md`
  - 角色关系：`references/long/character-relations.md`
  - 题材目录：`references/long/genre-catalog.md`
  - 题材机制：`references/long/genre-core-mechanics.md`
  - 读者画像：`references/long/genre-readers.md`
  - 题材模块：`references/long/style-genre-modules.md`
  - 人设关系表：`references/shared/csv/人设与关系.csv`
  - 命名规则：`references/shared/csv/命名规则.csv`
  - 金手指设定：`references/shared/csv/金手指与设定.csv`
  - 叙事线：`references/shared/strand-weave-pattern.md`

- `/story-long-analyze`
  - 状态追踪：`references/long/state-tracking.md`
  - 读者画像：`references/long/genre-readers.md`
  - 题材目录：`references/long/genre-catalog.md`
  - 剧情框架：`references/long/plot-frameworks.md`
  - 叙事线：`references/shared/strand-weave-pattern.md`
  - 审查 schema：`references/shared/review-schema.md`

- `/story-long-scan`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 核心约束：`references/shared/core-constraints.md`
  - 格式结构：`references/long/format-and-structure.md`
  - 状态追踪：`references/long/state-tracking.md`
  - 读者画像：`references/long/genre-readers.md`

- `/story-short-write`
  - 核心约束：`references/shared/core-constraints.md`
  - 短篇阅读力：`references/short/reading-power-taxonomy.md`
  - 剧透信号：`references/short/plot-signal-vs-spoiler.md`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 命名语调：`references/shared/naming-and-voice-gaps.md`
  - 兑现点：`references/shared/payoff-points-guide.md`
  - 爽点节奏：`references/shared/csv/爽点与节奏.csv`
  - 场景写法：`references/shared/csv/场景写法.csv`
  - 桥段套路：`references/shared/csv/桥段套路.csv`

- `/story-short-analyze`
  - 短篇阅读力：`references/short/reading-power-taxonomy.md`
  - 剧透信号：`references/short/plot-signal-vs-spoiler.md`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 爽点节奏：`references/shared/csv/爽点与节奏.csv`
  - 题材调性：`references/shared/csv/题材与调性推理.csv`
  - 裁决规则：`references/shared/csv/裁决规则.csv`

- `/story-short-scan`
  - 短篇阅读力：`references/short/reading-power-taxonomy.md`
  - 剧透信号：`references/short/plot-signal-vs-spoiler.md`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 核心约束：`references/shared/core-constraints.md`

- `/story-review`
  - 审查 schema：`references/shared/review-schema.md`
  - 核心约束：`references/shared/core-constraints.md`
  - blocking 决策：`references/shared/review/blocking-override-guidelines.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - mode：短篇默认 reviewer `solo`，长篇默认 `lean`，深审可请求 `full`。

- `/story-learn`
  - 写作技法：`references/shared/csv/写作技法.csv`
  - 兑现点：`references/shared/payoff-points-guide.md`
  - 题材归一：`references/shared/csv/genre-canonical.md`
  - 命名规则：`references/shared/csv/命名规则.csv`
  - 裁决规则：`references/shared/csv/裁决规则.csv`
  - 双轨：经验规则需标注适用于短篇、长篇或 shared。

- `/story-query`
  - 核心约束：`references/shared/core-constraints.md`
  - 题材画像：`references/shared/genre-profiles.md`
  - 长篇状态口径：`references/long/state-tracking.md`
  - 短篇阅读力：`references/short/reading-power-taxonomy.md`
  - 优先级：合同 `ContractStore` → 最新 accepted commit `CommitStore` → 投影 read-model。

- `/story-preflight`
  - 核心约束：`references/shared/core-constraints.md`
  - 审查 schema：`references/shared/review-schema.md`
  - 剧透信号：`references/short/plot-signal-vs-spoiler.md`
  - 状态追踪：`references/long/state-tracking.md`
  - 双轨：短篇不因缺 `volumes/` 阻断，长篇缺 volume/chapter 合同时阻断。

- `/story-deslop`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - 核心约束：`references/shared/core-constraints.md`
  - 命名语调：`references/shared/naming-and-voice-gaps.md`

- `/story-repair`
  - 审查 schema：`references/shared/review-schema.md`
  - fallback rubric：`references/shared/review/fallback-rubric.md`
  - blocking 决策：`references/shared/review/blocking-override-guidelines.md`
  - 核心约束：`references/shared/core-constraints.md`
  - 命名语调：`references/shared/naming-and-voice-gaps.md`

- `/story-import`
  - 状态追踪：`references/long/state-tracking.md`
  - 格式结构：`references/long/format-and-structure.md`
  - 工件协议：`references/long/artifact-protocols.md`
  - 题材画像：`references/shared/genre-profiles.md`
  - 题材调性：`references/shared/csv/题材与调性推理.csv`
  - 裁决规则：`references/shared/csv/裁决规则.csv`
  - 拆解：参考能力只保留 narrative_techniques、do_not_copy、differentiation。

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

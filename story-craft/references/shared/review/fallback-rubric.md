# Reviewer Fallback Rubric

本文件是 reviewer 在外部参考、平台 rubric 或多 Agent full mode 不可用时的兜底基准包。它只提供最低审查口径，不能替代项目合同、commit 真源和正文证据。

## 启用条件

- `references/shared/review-schema.md` 或题材 rubric 不可读。
- `full` mode 预检失败，自动降级到 `solo`。
- Claude Code 运行时无法 spawn 多视角 Agent。
- 用户要求快速审查，但仍必须输出结构化 findings。

## 13 条核心 rubric

1. 本章必须完成 `ChapterContract.must_cover` 中的核心行动。
2. 任何新增事实必须能从正文证据或合同上下文解释。
3. 主角关键选择必须有目标、阻力和代价。
4. 时间、地点、人物在场关系不得互相冲突。
5. 世界规则、能力边界和物品归属不得被临时改写。
6. 上章钩子必须被回应，除非本章合同明确延后。
7. 新伏笔必须有具体回收方向，不能只制造空悬念。
8. 章尾必须留下选择、信息差、情绪余波或下一步问题。
9. 对白必须改变关系、信息或行动，不能互相解释已知事实。
10. 情绪必须由动作、物件、感官或选择承载，避免纯心理标签。
11. AI 味 6-Gate 任一 heavy 级别应至少生成 S2 finding。
12. Strand 失衡影响章节功能时，归入 `strand` 或 `pacing` finding。
13. 安全、版权、用户禁区或 canon 污染问题一律不可降级。

## AI 味速查

- 禁用词密度：模板词高频出现，优先定位为 `ai_flavor`。
- 连续排比段数：连续段落同开头或同句式，优先定位为 `ai_flavor` 或 `pacing`。
- 心理词占比：心理标签多于动作证据，优先要求外化。
- 对话标签密度：每句对白都解释语气，优先要求删减标签。
- 平均段落句数：单段句数过高，优先拆场景或压缩解释。
- 重复描写密度：同类环境词反复出现，优先替换为剧情专属细节。

## 平台 fallback

- 起点/番茄类长篇：优先检查主线推进、爽点兑现、章尾牵引、节奏密度。
- 晋江/女频类长篇：优先检查关系张力、情绪递进、角色边界、信息差。
- 知乎/短篇：优先检查开篇问题、反转因果、压缩效率、结尾回响。
- 悬疑/规则类：优先检查线索公平性、规则一致性、误导合法性、回收可追踪。

## 输出要求

- 必须输出 S1-S4 severity。
- 必须使用 14 类 category，不得自创分类。
- S1/S2 必须 `blocking=true`。
- 每个 finding 必须有 `location/evidence/issue/fix/blocking`。
- meta 中 `Rubric Source` 或 `rubric_source` 必须标记 `fallback`。

# state.json 字段说明

## 顶层结构

`state.json` 是 story-craft 项目的轻量状态文件。
它记录项目元数据、进度、灵感来源、创作约束、生成文件状态和叙事参数。

```json
{
  "schema_version": "story-craft/v1",
  "project": {},
  "progress": {},
  "inspiration": {},
  "creative_constraints": {},
  "generated_files": {},
  "narrative_meta": {},
  "maintenance": {}
}
```

## project

- `title`：故事标题。
- `genre`：主题材。
- `sub_genre`：子题材，可为空。
- `word_count_target`：目标字数，建议 10000-100000。
- `tier`：`short` 或 `medium`。
- `created_at`：创建时间。
- `updated_at`：项目元数据更新时间。

## progress

- `current_chapter`：当前已完成章号。
- `total_words`：累计字数。
- `last_updated`：进度更新时间。
- `phase`：当前阶段，常见值为 `init`、`plan`、`write`、`review`。

## inspiration

- `source_type`：灵感来源类型。
- `reference_work`：参考作品名，可为空。
- `reference_author`：参考作者，可为空。
- `analysis_summary`：参考分析摘要，只记录可迁移模式。
- `free_description`：用户自由描述。

## creative_constraints

- `one_liner`：一句话梗概。
- `anti_trope`：反套路约束。
- `hard_constraints`：硬约束列表。
- `ending_constraint`：结尾约束。
- `theme_statement`：主题句。
- `protagonist_flaw`：主角核心缺陷。
- `antagonist_mirror`：反派镜像关系。
- `opening_hook`：开篇钩子。
- `score`：创意评分，包含 `novelty`、`writability`、`ending_power`、`total`。

## generated_files

- `outline`：是否生成 `大纲/总纲.md`。
- `worldbuilding`：是否生成 `设定集/世界观.md`。
- `protagonist_card`：是否生成 `设定集/主角卡.md`。
- `protagonist_group`：是否生成 `设定集/主角组.md`。
- `female_lead_card`：是否生成 `设定集/女主卡.md`。
- `antagonist_design`：是否生成 `设定集/反派设计.md`。
- `power_system`：是否生成 `设定集/力量体系.md`。
- `unique_advantage`：是否生成 `设定集/独特优势.md`。
- `golden_finger`：是否生成 `设定集/金手指.md`。
- `genre_fusion_logic`：是否生成 `复合题材-融合逻辑.md`。

## narrative_meta

- `pov`：叙事视角。
- `tense`：叙事时态。
- `tone`：叙事语气。
- `opening_type`：开篇类型。

## maintenance

- `last_backup_at`：最近一次备份时间。
- `last_backup_file`：最近一次备份文件路径。
- `last_index_rebuild_at`：最近一次 SQLite 查询缓存重建时间。
- `last_outline_revision_at`：最近一次中期大纲修正建议生成时间。
- `last_outline_revision_file`：最近一次中期大纲修正建议文件路径。
- `last_health_check_at`：最近一次运行时健康检查时间。

## 短篇/中篇约束

- `word_count_target` 控制章数和模板复杂度。
- 1-5 万字优先压缩角色数量和设定说明。
- 5-10 万字可以增加副线，但必须服务结尾回收。
- 所有生成文件状态必须和实际文件保持一致。

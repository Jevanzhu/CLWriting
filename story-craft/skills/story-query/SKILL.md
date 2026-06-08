---
name: story-query
description: 只读查询 story-craft 项目的合同、commit、投影、状态、上下文、角色记忆、伏笔、时间线、学习记录和支持流派。
allowed-tools: Read Grep Bash
---

# story-query

## 目标

只读回答项目状态和故事记忆问题，不写文件。查询优先级固定为：合同 `ContractStore` → 最新 accepted commit `CommitStore` → 投影 read-model。

## 查询入口

可用 CLI：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query context --chapter "${CHAPTER}"
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query memory
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query learning
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query quality
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query entity-graph
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query ranked-context --chapter "${CHAPTER}" --budget 20
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query index --text "${TEXT}"
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" query genres
```

## 查询类型

- 当前进度：读取 `state.progress`。
- 角色状态：读取 `memory.characters`，按姓名或 id 过滤。
- 未回收伏笔：读取 `memory.foreshadowing` 中 `status != resolved`。
- 时间线：读取 `memory.timeline`。
- 世界规则：读取 `memory.world_rules`。
- 章节摘要：读取 `memory.chapter_summaries`。
- 写作上下文：调用 `query context --chapter N`。
- 合同状态：读取 `master/volumes/chapters/reviews` 合同是否完整。
- commit 真源：读取 `.story/commits/chapter_NNN.commit.json` 的 accepted 结果。
- 学习记录：调用 `query learning`。
- 支持流派：调用 `query genres`。
- 质量趋势：调用 `query quality`。
- 实体关系：调用 `query entity-graph`。
- 索引检索：调用 `query index --text 关键词`。
- 上下文裁剪：调用 `query ranked-context --chapter N --budget B`。

## 流程

1. 明确用户问题所属类型。
2. 运行最小必要查询，不读取无关大文件。
3. 用简洁中文回答，必要时引用 id、章节号和状态。
4. 如果数据缺失，明确说“当前 memory/state 未记录”，不要编造。

## 只读边界

- 不写 state、memory、learning、正文或报告。
- 不调用 Agent。
- 不修改项目指针。
- 不触发 `index/vector` rebuild，除非用户明确要求维护命令。
- 不把推断当事实；推断必须标明“根据当前记录推断”。

## 输出建议

角色查询示例：

```text
林墨当前状态：刚发现 U 盘，情绪压抑焦虑。最后出场：第05章。
```

伏笔查询示例：

```text
未回收伏笔 2 条：
1. fh_001 [high] 天台纸条「不要相信周三」：计划第08章回收。
2. fh_002 [medium] 苏晚调查方式不同：计划第10章回收。
```

## 失败处理

- 项目未初始化：提示先执行 `/story-init`。
- 查询目标不存在：列出可查询类型。
- memory 为空：说明当前还没有章节验收记忆。

## 完成条件

回答用户问题，并确认本次没有写入文件。

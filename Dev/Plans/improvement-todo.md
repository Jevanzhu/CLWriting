# 待改进 TODO

更新时间：2026-05-25

来源：

- `Dev/Reviews/glm-5.1审查报告.md`
- `Dev/Reviews/opus-4.7审查报告.md`

范围：仅针对正式项目 `story-craft/`、`docs/`、README 和插件配置；`Dev/` 下参考项目不纳入实现范围。

## 当前状态说明

- 旧 todolist 已按要求清空。
- 本文件记录两份评审报告归并后的后续改进方案。
- 当前主线已完成 `commit -> record/验收记录` 契约收口，并已提交为 `2fd9487 收口章节验收记录契约`。
- P23-1 已完成：正文写入调整为 `record accepted -> 写正式正文`，正文写入失败会回滚 record / memory / state。
- P23-2 已完成：失败返回结构已统一，早期失败 stage 也会返回固定文件字段。
- P23-3 已完成：`ChapterRecordService` 状态判断已简化，行为保持不变。
- P24-1 已完成：reviewer issue 字段已按 `reviewer.md` schema 严格校验，测试夹具已同步为完整 issue。
- P24-2 已完成：delta 已分为 `data-agent 完整输出` 与 `write 最小可消费 delta` 两层契约，`entities_appeared` 类型已支持字符串 id 或对象。
- P24-3 已完成：delta 缺失顶层或嵌套章节号时会补齐并追加 warning，章节号冲突仍阻断。
- 当前进度：P25 已全部完成并通过全量验证，待提交收口。
- 最近一次整体验证：`story-craft/scripts/tests` 全量测试 85 passed，`compileall` 通过，`git diff --check` 通过。

## 执行原则

- 不把 P23/P24/P25 混成一个大提交。
- P23 优先修数据一致性和写作闭环行为。
- P24 再修 reviewer / delta 契约一致性。
- P25 最后处理文档治理、兼容层退役计划和低风险维护项。
- 每个阶段完成后运行：

```bash
timeout 60s python3 -B -m pytest story-craft/scripts/tests
env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
```

---

## P23：写作闭环一致性加固

### P23-1：调整正文写入时机

- 状态：已完成（2026-05-25）
- 优先级：高
- 来源：glm-5.1、opus-4.7
- 位置：`story-craft/scripts/tools/chapter_workflow.py`
- 问题：当前 accepted 路径中，正文写入仍早于最终 record 状态判断。虽然已有 snapshot 回滚，但逻辑上仍存在“磁盘正文已写，返回值标记无正文”的脆弱分歧。
- 预期改法：
  - 先完成 prewrite、placeholder、word_count、review、delta 校验。
  - rejected：只写审查报告和 rejected record，不写最终正文。
  - accepted：先写 record / memory / state，再写最终正文。
  - 任一步失败继续走 snapshot 回滚，返回 `stage=write_error`。
- 验证建议：
  - 模拟 record 返回非 accepted，确认不写最终正文。
  - 模拟正文写入失败，确认 record / memory / state 回滚。
  - 保持 rejected 不写最终正文。
- 完成记录：
  - `record_chapter_workflow()` 已改为先写审查报告和 record，再按 `record_result["status"] == "accepted"` 写正式正文。
  - 新增 record 返回 `rejected` 时不写正式正文的回归测试。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_plan_write_workflow.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`

### P23-2：统一错误返回结构

- 状态：已完成（2026-05-25）
- 优先级：中
- 来源：glm-5.1
- 位置：`story-craft/scripts/tools/chapter_workflow.py`
- 问题：不同失败 stage 返回字段不完全一致，调用方需要大量 `.get()` 防御。
- 预期改法：
  - 所有失败返回至少包含：
    - `ok`
    - `stage`
    - `blockers`
    - `warnings`
    - `chapter_file`
    - `report_file`
    - `record_file`
    - `draft_file`
  - 字数检查相关 stage 保留 `word_count_check`。
- 验证建议：
  - 为 prewrite、placeholder、word_count、warnings、delta_validation、write_error 增加字段形状断言。
- 完成记录：
  - 新增 `_failure_result()` 统一失败返回结构。
  - `prewrite`、`placeholder`、`word_count`、`warnings`、`delta_validation`、`write_error` 均至少返回固定失败字段。
  - 新增 placeholder 失败用例，并为六类失败 stage 增加字段形状断言。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_plan_write_workflow.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`

### P23-3：简化 `ChapterRecordService` 状态判断

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：opus-4.7
- 位置：`story-craft/scripts/core/chapter_record.py`
- 问题：`passed = blocker_count == 0` 后又判断 `passed and blocker_count == 0`，语义重复。
- 预期改法：
  - 简化为 `status = "accepted" if passed else "rejected"`。
- 验证建议：
  - 现有 storage 测试覆盖 accepted / rejected 即可。
- 完成记录：
  - `status` 计算已简化为 `status = "accepted" if passed else "rejected"`。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_storage.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`

---

## P24：reviewer / delta 契约收口

### P24-1：严格校验 reviewer issue 字段

- 状态：已完成（2026-05-25）
- 优先级：高
- 来源：opus-4.7
- 位置：`story-craft/scripts/tools/agent_workflow.py`
- 问题：`_validate_raw_reviewer_output()` 目前只校验顶层 `issues:list` 和 `summary:str`，没有校验 `reviewer.md` 声明的 issue 必填字段。
- 预期改法：
  - 每个 issue 必须包含：
    - `severity`
    - `category`
    - `location`
    - `description`
    - `evidence`
    - `fix_hint`
    - `blocking`
  - 校验 `severity` / `category` 枚举。
  - `blocking` 必须是布尔值。
  - 不合规时抛 `ValueError`，CLI 返回中文错误。
- 验证建议：
  - 新增缺字段、非法枚举、blocking 非 bool 的测试。
  - 同步修正现有测试 fixture，避免继续使用半结构 issue。
- 完成记录：
  - `_validate_raw_reviewer_output()` 已校验每个 `issues[N]` 必须是对象，并包含 `severity/category/location/description/evidence/fix_hint/blocking`。
  - `severity` 限定为 `critical/high/medium/low`，`category` 限定为 reviewer schema 枚举，`blocking` 必须是布尔值。
  - CLI 复用原有 `ValueError` 中文错误路径，错误信息包含 `issues[N].字段名`，便于定位不合规 reviewer JSON。
  - 本地 fallback reviewer issue 已改成完整合法 schema，避免未提供 reviewer 结果时误触发新校验。
  - 测试夹具已同步为完整 issue，并新增缺字段、非法枚举、`blocking` 类型错误覆盖。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_agent_workflow.py story-craft/scripts/tests/test_context_tools.py story-craft/scripts/tests/test_storage.py story-craft/scripts/tests/test_medium_extensions.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_cli_integration.py::test_cli_init_preflight_query_learn_and_review_chain`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`
    - `git diff --check`

### P24-2：明确 delta 契约分层

- 状态：已完成（2026-05-25）
- 优先级：高
- 来源：opus-4.7
- 位置：
  - `story-craft/agents/data-agent.md`
  - `docs/data-formats.md`
  - `story-craft/scripts/core/types.py`
  - `story-craft/scripts/tools/chapter_workflow.py`
- 问题：data-agent 文档要求完整字段，`ExtractionDelta` 是宽松 `total=False`，fallback delta 又只生成最小字段，三处契约松紧不一。
- 预期改法：
  - 明确两种格式：
    - data-agent 完整输出：面向真实 Agent，字段严格。
    - write 最小可消费 delta：面向 fallback / 手工修复，允许较少字段。
  - `docs/data-formats.md` 分别列出完整输出和最小可消费格式。
  - `data-agent.md` 保持严格输出要求。
  - `ExtractionDelta.entities_appeared` 改为支持 `str | dict[str, Any]`。
- 验证建议：
  - 增加类型边界测试，确认 string/dict 两种实体都能进入 memory。
  - 文档对齐测试覆盖关键短语。
- 完成记录：
  - `ExtractionDelta.entities_appeared` 已改为 `list[str | dict[str, Any]]`，与 memory 消费逻辑一致。
  - `data-agent.md` 保持严格完整输出要求，并声明未知必填信息使用空数组、空对象或空字符串，不省略字段。
  - `docs/data-formats.md` 已拆分说明 `data-agent 完整输出` 与 `write 最小可消费 delta`。
  - `_default_extraction_delta()` 标注为 write 命令的最小可消费 fallback delta。
  - 新增/调整测试覆盖 string 和 dict 两种 `entities_appeared` 都能更新角色出场章节。
  - 文档对齐测试已锁定 `data-agent 完整输出` 与 `write 最小可消费 delta` 关键短语。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_storage.py::test_memory_manager_accepts_string_and_object_entities_in_delta story-craft/scripts/tests/test_docs_alignment.py::test_usage_docs_are_split_by_category story-craft/scripts/tests/test_agents.py story-craft/scripts/tests/test_reference_alignment.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`
    - `git diff --check`

### P24-3：`_normalize_delta_chapter()` 对缺失章节号给 warning

- 状态：已完成（2026-05-25）
- 优先级：中
- 来源：glm-5.1
- 位置：`story-craft/scripts/tools/chapter_workflow.py`
- 问题：`chapter` 为 `None` 或空字符串时会静默补齐，可能掩盖 data-agent 输出质量问题。
- 预期改法：
  - 缺失章节号时允许补齐，但追加 warning。
  - 章节号冲突仍然 blocker。
- 验证建议：
  - 缺失顶层 chapter 时返回 warning。
  - `timeline_entry.chapter` / `chapter_summary.chapter` 缺失也返回 warning。
  - 章节号冲突仍进入 `stage=delta_validation`。
- 完成记录：
  - `_normalize_delta_chapter()` 已返回 `normalized/errors/warnings` 三元组。
  - 顶层 `delta.chapter`、`delta.timeline_entry.chapter`、`delta.chapter_summary.chapter` 缺失时继续补齐为目标章节，并追加 warning。
  - 章节号无法解析或与目标章节冲突时仍进入 `stage=delta_validation`，作为 blocker 返回。
  - write 成功路径和 delta_validation 失败路径都会携带已生成的 delta warning。
  - 新增测试覆盖三处章节号缺失时的 warning 和 record delta 补齐结果。
  - 复用原有章节号冲突测试，确认冲突仍阻断且不写正文、record、state、memory。
  - 验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_plan_write_workflow.py::test_record_chapter_workflow_warns_when_delta_chapter_is_missing story-craft/scripts/tests/test_plan_write_workflow.py::test_record_chapter_workflow_rejects_mismatched_delta_chapter`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_plan_write_workflow.py`
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests`
    - `env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts`
    - `git diff --check`

---

## P25：文档、插件配置和兼容层治理

### P25-1：补全 write-result 文档

- 状态：已完成（2026-05-25）
- 优先级：中
- 来源：opus-4.7
- 位置：`docs/data-formats.md`
- 问题：write-result 示例未列 `ok` 字段，stage 枚举也未覆盖全部实际返回值。
- 预期改法：
  - 示例补 `ok`。
  - stage 枚举补全：
    - `prewrite`
    - `placeholder`
    - `word_count`
    - `warnings`
    - `delta_validation`
    - `record`
    - `write_error`
  - 说明每个 stage 的触发条件。
- 验证建议：
  - 文档对齐测试覆盖 `ok` 和完整 stage 枚举。
- 完成记录：
  - `docs/data-formats.md` 的 write-result 示例已补 `ok` 字段。
  - `stage` 已补全 `prewrite`、`placeholder`、`word_count`、`warnings`、`delta_validation`、`record`、`write_error`。
  - 已说明各 stage 触发条件，以及失败 / 退稿路径对正式正文、审查报告和验收记录的写入影响。
  - 新增文档对齐测试锁定 `ok` 与完整 stage 枚举。

### P25-2：标注 legacy commit 兼容层退役计划

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：opus-4.7
- 位置：
  - `story-craft/scripts/core/chapter_commit.py`
  - `story-craft/scripts/core/chapter_record.py`
  - `docs/development.md`
- 问题：`ChapterCommitService` 和旧 `ch_NN_commit.json` 兼容层没有退役计划。
- 预期改法：
  - docstring 标注 deprecated。
  - 说明保留原因：兼容旧项目与旧测试夹具。
  - 暂不删除，后续版本再移除。
- 验证建议：
  - 保留 legacy lookup 测试。
- 完成记录：
  - `core/chapter_commit.py` docstring 已标注 deprecated，并说明保留原因。
  - `ChapterCommitService` docstring 已标注为旧调用兼容别名。
  - `docs/development.md` 已补兼容层退役计划，明确新代码不得继续新增 commit 命名持久化契约。

### P25-3：显式声明插件 skills / agents 路径

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：opus-4.7
- 位置：`story-craft/.claude-plugin/plugin.json`
- 问题：当前依赖 Claude Code 按目录自动发现 skills / agents；若发现规则变化，插件加载可能不稳定。
- 预期改法：
  - 在 plugin manifest 中显式列出 skills / agents 路径。
  - 若当前 manifest schema 不支持相关字段，先补文档说明，不盲目写未知字段。
- 验证建议：
  - 检查 plugin manifest 仍为合法 JSON。
- 完成记录：
  - 当前未向 `plugin.json` 写入未确认 schema 的 `skills` / `agents` 路径字段。
  - `docs/development.md` 已说明 Claude Code 插件按目录自动发现 `story-craft/skills/` 和 `story-craft/agents/`。
  - 新增参考对齐测试，确认 `plugin.json` 为合法 JSON 且 `skills/`、`agents/` 目录存在。

### P25-4：抽取原子写入公共实现

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：glm-5.1
- 位置：`story-craft/scripts/core/security_utils.py`
- 问题：`atomic_write_json()` 与 `atomic_write_text()` 大段重复。
- 预期改法：
  - 抽取内部 `_atomic_write_payload()`。
  - JSON/text 公开函数只负责序列化或传入字符串。
- 验证建议：
  - 原有 atomic write 测试全部通过。
- 完成记录：
  - `atomic_write_json()` 仅负责 JSON 序列化和错误转换。
  - `atomic_write_text()` 仅负责文本入口和编码参数。
  - 公共原子写入、锁、备份和临时文件清理逻辑已抽到 `_atomic_write_payload()`。

### P25-5：统一 `cmd_agent` 章节号校验

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：opus-4.7
- 位置：`story-craft/scripts/story_craft.py`
- 问题：`cmd_write` 使用 `_resolve_chapter_arg()`，`cmd_agent` 直接使用 `args.chapter`，可能允许 0 或负数。
- 预期改法：
  - 对需要章节号的 agent 子命令统一走 `_resolve_chapter_arg()` 或等价校验。
- 验证建议：
  - `agent brief --chapter 0` 返回中文错误和非零退出码。
- 完成记录：
  - `cmd_agent()` 已统一调用 `_resolve_chapter_arg()`。
  - `brief`、`repair`、`polish`、`extract`、`workflow` 均使用校验后的正整数章节号。
  - 新增 `agent brief --chapter 0` 回归测试，确认返回非零退出码和中文错误。
  - 定向验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_agent_workflow.py::test_cli_agent_rejects_non_positive_chapter`

### P25-6：无 chapter timeline 幂等去重

- 状态：已完成（2026-05-25）
- 优先级：低
- 来源：opus-4.7
- 位置：`story-craft/scripts/core/memory_manager.py`
- 问题：`append_timeline_entry()` 对无 `chapter` 的 entry 直接 append，重复 fallback 可能累积重复条目。
- 预期改法：
  - 对无 chapter entry 按 `events + time_marker + location` 做轻量去重。
- 验证建议：
  - 重复追加无 chapter entry 时只保留一条。
- 完成记录：
  - `append_timeline_entry()` 对无正整数 `chapter` 的条目按 `events + time_marker + location` 生成轻量去重键。
  - 重复 fallback / data-agent 条目会以后一次内容覆盖旧条目，不同地点或不同事件仍保留。
  - 无可比较信号的空条目保持原追加行为，避免误合并。
  - 新增无 chapter timeline 去重回归测试。
  - 定向验证通过：
    - `timeout 60s python3 -B -m pytest story-craft/scripts/tests/test_storage.py::test_memory_manager_deduplicates_timeline_entries_without_chapter`

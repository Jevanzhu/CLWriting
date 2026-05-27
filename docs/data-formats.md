# 数据格式

本文记录 `story-craft` 写作闭环中常见 JSON 文件格式。核心格式的 TypedDict 定义见 `story-craft/scripts/core/types.py`。

## reviewer JSON 原始输出

`reviewer` Agent 的原始输出以 `issues` 为权威。`blocking=true`，或
`severity=critical` 的 issue，会在本地归一化为阻断项。
`severity` 使用 `critical`、`high`、`medium`、`low`。
`category` 使用 `setting`、`timeline`、`continuity`、`character`、`logic`、`ai_flavor`、`pacing`、`format`。

原始输出不使用 `blocker_count` / `issue_count` 作为输入字段；计数只在验收
结果里由本地根据归一化后的列表派生。

最小通过示例：

```json
{
  "issues": [],
  "summary": "本章可验收。"
}
```

阻断示例：

```json
{
  "issues": [
    {
      "severity": "critical",
      "category": "continuity",
      "location": "第3段",
      "description": "主角提前知道尚未获得的线索。",
      "evidence": "第3段直接写出主角已知道门禁记录被改写。",
      "fix_hint": "删掉未授权信息，改为现场验证后获得。",
      "blocking": true
    }
  ],
  "summary": "存在连续性阻断。"
}
```

本地归一化后会生成内部结构：`passed`、`blockers` 和 `warnings`。
`blockers` 列表是验收闸门的唯一权威来源。
原始输出不要提供 `suggestions`；可执行修复建议统一写入对应 issue 的
`fix_hint`。历史输入中的 `suggestions` 会被本地归一化忽略。
审查维度包括设定一致性、时间线、角色动机、逻辑因果和 AI 味。

## delta JSON

delta 分为两层契约：

- **data-agent 完整输出**：面向真实 `data-agent` 调用，字段严格。Agent 必须输出完整字段，未知但必填的信息使用空数组、空对象或空字符串。
- **write 最小可消费 delta**：面向 `write` 的 fallback / 手工修复，只要求能安全更新章节记录、memory 和 state，允许省略未发生变化的扩展字段。

`ExtractionDelta` 是最小可消费格式的本地 TypedDict，因此保持 `total=False`。
其中 `entities_appeared` 支持字符串 id 或对象：字符串用于 fallback / 手工修复，
对象用于 data-agent 完整输出，可携带 `id/type/mentions/confidence`。

### data-agent 完整输出

完整输出必须包含以下顶层字段：

- `chapter`
- `title`
- `entities_new`
- `entities_appeared`
- `state_changes`
- `new_foreshadowing`
- `resolved_foreshadowing`
- `new_world_rules`
- `timeline_entry`
- `scenes`
- `chapter_summary`

完整示例：

```json
{
  "chapter": 1,
  "title": "开篇异常",
  "entities_new": [],
  "entities_appeared": [
    {
      "id": "char_protagonist",
      "type": "character",
      "mentions": ["林墨"],
      "confidence": 0.98
    }
  ],
  "state_changes": [
    {
      "entity_id": "char_protagonist",
      "field": "current_status",
      "new": "决定追查旧楼真相"
    }
  ],
  "new_foreshadowing": [
    {
      "id": "fh_001",
      "content": "信封背面的西门 23:40 水印",
      "status": "open",
      "urgency": "high",
      "planted_chapter": 1,
      "payoff_plan": "中段揭示水印对应被改写的门禁记录"
    }
  ],
  "resolved_foreshadowing": [],
  "new_world_rules": [],
  "timeline_entry": {
    "chapter": 1,
    "time_marker": "",
    "events": ["林墨收到亡友留下的空白来信。"],
    "time_elapsed": "",
    "time_delta": "",
    "source": "data-agent"
  },
  "scenes": [
    {
      "index": 1,
      "start_line": 1,
      "end_line": 28,
      "location": "雨夜街口",
      "summary": "林墨收到异常来信并决定追查。",
      "characters": ["char_protagonist"],
      "tone": "克制悬疑"
    }
  ],
  "chapter_summary": {
    "chapter": 1,
    "title": "开篇异常",
    "summary": "林墨收到亡友来信，发现信封没有邮戳，决定回到旧楼追查线索。",
    "word_count": 2800,
    "key_events": ["收到空白来信", "发现无邮戳", "决定追查旧楼"],
    "characters_appeared": ["char_protagonist"],
    "hook_type": "线索钩",
    "hook_strength": "高"
  }
}
```

### write 最小可消费 delta

最小示例：

```json
{
  "chapter": 1,
  "entities_appeared": ["char_protagonist"],
  "timeline_entry": {
    "chapter": 1,
    "events": ["林墨收到亡友留下的空白来信。"],
    "source": "data-agent"
  },
  "chapter_summary": {
    "chapter": 1,
    "title": "开篇异常",
    "summary": "林墨收到亡友来信，决定追查旧楼真相。",
    "word_count": 2800
  }
}
```

可选扩展字段：

```json
{
  "entities_new": [
    {
      "id": "char_xuzhao",
      "name": "许照",
      "role": "police_contact",
      "tier": "重要"
    }
  ],
  "state_changes": [
    {
      "entity_id": "char_protagonist",
      "field": "current_status",
      "new": "决定进入旧楼调查"
    }
  ],
  "new_foreshadowing": [
    {
      "id": "fh_001",
      "content": "信封背面的西门 23:40 水印",
      "status": "open",
      "urgency": "high",
      "planted_chapter": 1
    }
  ],
  "resolved_foreshadowing": [
    {
      "id": "fh_001",
      "resolution": "水印对应被改写的门禁记录"
    }
  ],
  "new_world_rules": [],
  "scenes": []
}
```

## write-result JSON

`write` 命令验收后生成的结果文件，记录本次验收的阶段、状态和字数检查结果。
类型边界为 `WriteResult = WriteSuccess | WriteFailure`。

### WriteSuccess

`WriteSuccess` 只表示正式验收成功：`ok=true`、`stage=record`、`status=accepted`。

```json
{
  "ok": true,
  "stage": "record",
  "status": "accepted",
  "chapter": 1,
  "title": "葬礼后的信",
  "word_count": 2850,
  "chapter_file": "/tmp/story-demo/正文/第01章-葬礼后的信.md",
  "report_file": "/tmp/story-demo/审查报告/第01章审查报告.md",
  "record_file": "/tmp/story-demo/.story/chapters/ch_01_record.json",
  "memory_updated": true,
  "state_updated": true,
  "warnings": [],
  "word_count_check": {
    "planned_words": 3000,
    "actual_words": 2850,
    "ratio": 0.95,
    "minimum_words": 1800,
    "recommended_min_words": 2400,
    "recommended_max_words": 4050,
    "blockers": [],
    "warnings": []
  }
}
```

### WriteFailure

`WriteFailure` 覆盖两类失败：

- 闸门失败或写入失败：`stage` 为 `prewrite`、`placeholder`、`word_count`、`warnings`、`delta_validation` 或 `write_error`，会包含 `blockers`、`draft_file` 和固定文件字段。
- reviewer 退稿：`stage=record`、`status=rejected`，已写审查报告和 rejected 验收记录，但不会写最终正文，也不会更新记忆或进度。

- `ok`：本次 `write` 是否成功验收。`status=accepted` 时为 `true`，其他失败或退稿路径为 `false`。
- `stage`：验收阶段，完整枚举如下：
  - `prewrite`：写前校验未通过，例如缺少上一章验收记录或项目状态不满足。
  - `placeholder`：正文存在 `[TODO]`、`{待定}` 等占位符。
  - `word_count`：字数低于最低提交阈值。
  - `warnings`：启用严格 warning 模式时，写前校验或字数 warning 被视为阻断。
  - `delta_validation`：delta 章节号无法解析或与目标章节冲突。
  - `record`：已完成审查报告和验收记录写入；可能是 `accepted` 或 reviewer 阻断后的 `rejected`。
  - `write_error`：正式正文、审查报告、record、memory 或 state 写入过程中失败，并已尝试回滚。
- `status`：`accepted`（验收成功）、`rejected`（审查阻断）、`failed`（正式写入失败）。
- `word_count_check`：字数闸门结果，`blockers` 非空时低于 60% 阈值，`warnings` 非空时低于 80% 或超出 135%。
- `memory_updated` / `state_updated`：只有 accepted 验收记录会更新故事记忆和项目进度。

`stage=prewrite`、`placeholder`、`word_count`、`warnings` 或 `delta_validation`
时不会写入最终 `正文/`、审查报告或验收记录。`status=rejected` 时只写审查
报告和 rejected 验收记录，不写最终 `正文/`，不更新记忆。

## 工作台文件

每章固定使用 `.story/workflows/ch_NN/` 保存中间产物：

```text
.story/workflows/ch_NN/
├── manifest.json
├── brief.json
├── draft.md
├── review.json
├── repair.json
├── polish.json
├── delta.json
├── review-report.md
└── write-result.json
```

`manifest.json` 中的 `cli_commands` 所有路径已做 shell quoting，支持项目路径含空格。

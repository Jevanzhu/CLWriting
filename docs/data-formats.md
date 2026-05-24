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
      "fix_hint": "删掉未授权信息，改为现场验证后获得。",
      "blocking": true
    }
  ],
  "summary": "存在连续性阻断。"
}
```

本地归一化后会生成内部结构：`passed`、`blockers`、`warnings` 和
`suggestions`。`blockers` 列表是验收闸门的唯一权威来源。
审查维度包括设定一致性、时间线、角色动机、逻辑因果和 AI 味。

## delta JSON

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

扩展字段：

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

`write` 命令验收后生成的结果文件，记录本次验收的阶段、状态和字数检查结果：

```json
{
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

- `stage`：验收阶段，如 `record`、`warnings`、`write_error`。
- `status`：`accepted`（验收成功）、`rejected`（审查阻断）、`failed`（正式写入失败）。
- `word_count_check`：字数闸门结果，`blockers` 非空时低于 60% 阈值，`warnings` 非空时低于 80% 或超出 135%。
- `memory_updated` / `state_updated`：只有 accepted 验收记录会更新故事记忆和项目进度。

`status=rejected` 或 `stage=warnings` 时不会写入最终 `正文/`，不更新记忆。

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

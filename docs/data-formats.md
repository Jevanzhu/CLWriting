# 数据格式

本文记录 `story-craft` 写作闭环中常见 JSON 文件格式。

## reviewer JSON

最小通过示例：

```json
{
  "passed": true,
  "issues": [],
  "summary": "本章可提交。"
}
```

阻断示例：

```json
{
  "passed": false,
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

`severity` 为 `critical` 或 `blocker`，或 `blocking=true`，都会被视为阻断。

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

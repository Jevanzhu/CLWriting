# 数据格式

本文记录 story-craft 写作闭环中的主要 JSON 文件格式。核心 TypedDict 定义见 `story-craft/scripts/core/types.py`。

## 真源分层

story-craft 使用三类真源和六类投影：

- 写前合同：`.story/contracts/master.json`、`.story/contracts/volumes/volume_NNN.json`、`.story/contracts/chapters/chapter_NNN.json`、`.story/contracts/reviews/chapter_NNN.review.json`
- 写后真源：`.story/commits/chapter_NNN.commit.json`
- 部署哨兵：`.story/contracts/deployment.json`
- 读模型投影：`state`、`memory`、`summary`、`index`、`vector`、`markdown_view`

`大纲/总纲.md`、`设定/角色/*.md` 和追踪 Markdown 是人类可读投影，不是写作或验收真源。

## master contract

`.story/contracts/master.json` 是项目级合同，至少记录项目类型、题材、目标字数和硬约束。

```json
{
  "contract_version": "story-craft/master-v1",
  "project_type": "short",
  "title": "暗室来信",
  "genre": "悬疑",
  "sub_genre": "都市旧案",
  "word_count_target": 30000,
  "one_liner": "法医收到亡友留下的空白来信，追查旧楼暗室真相。",
  "theme_statement": "真相必须由可验证证据推动。",
  "hard_constraints": ["线索必须可回溯", "结尾回收核心疑点"],
  "protagonist": {
    "name": "林墨",
    "desire": "查清亡友死因",
    "flaw": "过度依赖物证"
  },
  "created_at": "2026-06-09T00:00:00Z",
  "updated_at": "2026-06-09T00:00:00Z"
}
```

`project_type` 只允许 `short` 或 `long`。短篇不要求 `volumes/`，长篇需要 volume 与 chapter 合同衔接。

## chapter contract

`.story/contracts/chapters/chapter_NNN.json` 是写前章节合同。写作链不得从 `大纲/总纲.md` 反推章节合同。

```json
{
  "contract_version": "story-craft/chapter-v1",
  "chapter": 1,
  "volume": 1,
  "title": "空白来信",
  "chapter_directive": "林墨收到空白来信，发现信封水印异常。",
  "must_cover": ["空白来信出现", "水印线索成立", "林墨决定回旧楼"],
  "forbidden_zones": ["不得提前揭示门禁记录真相"],
  "planned_word_count": 2800,
  "expected_strand": "quest",
  "open_loops_to_plant": ["西门 23:40 水印"],
  "open_loops_to_close": [],
  "created_at": "2026-06-09T00:00:00Z",
  "updated_at": "2026-06-09T00:00:00Z"
}
```

长篇还会使用 `.story/contracts/volumes/volume_NNN.json`，记录卷目标、章范围、关键转折和必须覆盖内容。

## reviewer JSON 原始输出

`reviewer` Agent 的原始输出以 `issues` 为权威。`S1/S2`、`blocking=true` 或 `severity=critical` 会在本地归一化为阻断项。`write` / `chapter-commit` 会在归一化后补充审查来源：提供 reviewer JSON 时 commit 记录 `review_meta.source=agent`，CLI 本地兜底时记录 `review_meta.source=fallback`。

最小通过示例：

```json
{
  "issues": [],
  "summary": "本章可验收。",
  "meta": {
    "requested_mode": "solo",
    "effective_mode": "solo",
    "rubric_source": "embedded fallback"
  }
}
```

阻断示例：

```json
{
  "issues": [
    {
      "severity": "S1",
      "category": "continuity",
      "location": "第3段",
      "evidence": "主角直接知道尚未获得的门禁记录。",
      "issue": "正文泄露了合同禁止提前揭示的信息。",
      "fix": "删掉未授权信息，改为现场验证后获得。",
      "blocking": true
    }
  ],
  "summary": "存在连续性阻断。",
  "meta": {
    "requested_mode": "lean",
    "effective_mode": "lean",
    "rubric_source": "references/shared/review-schema.md"
  }
}
```

本地最小消费边界仍要求顶层包含 `issues` 数组和 `summary` 字符串。原始输出不要提供 `passed`、`blockers`、`warnings` 作为输入字段。

## delta JSON

delta 分为两层契约：

- **data-agent 完整输出**：面向真实 `data-agent` 调用，字段严格。Agent 必须输出完整字段，未知但必填的信息使用空数组、空对象或空字符串。
- **write 最小可消费 delta**：面向 `write` 或 `chapter-commit` 的 fallback / 手工修复，只要求能安全构建 chapter commit。

### data-agent 完整输出

完整输出必须包含 `accepted_events`、`dominant_strand`、`scenes` 和 `chapter_summary`。

```json
{
  "chapter": 1,
  "title": "空白来信",
  "accepted_events": [
    {
      "event_type": "foreshadowing_planted",
      "strand": "quest",
      "chapter": 1,
      "source": "data-agent",
      "payload": {
        "id": "fh_001",
        "content": "信封背面的西门 23:40 水印",
        "urgency": "high"
      }
    }
  ],
  "dominant_strand": "quest",
  "timeline_entry": {
    "chapter": 1,
    "events": ["林墨收到亡友留下的空白来信。"],
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
      "tone": "克制悬疑",
      "strand": "quest",
      "embedding_text": "林墨收到异常来信并决定追查。"
    }
  ],
  "chapter_summary": {
    "chapter": 1,
    "title": "空白来信",
    "summary": "林墨收到亡友来信，发现信封没有邮戳，决定回到旧楼追查线索。",
    "word_count": 2800,
    "key_events": ["收到空白来信", "发现无邮戳", "决定追查旧楼"]
  },
  "style_fingerprint": {
    "narrative": "克制近景",
    "language": "短句为主",
    "dialogue": "少解释",
    "description": "物证细节",
    "taboo": "不提前揭底",
    "theme": "证据与悔意"
  }
}
```

### write 最小可消费 delta

最小示例：

```json
{
  "chapter": 1,
  "accepted_events": [],
  "dominant_strand": "quest",
  "timeline_entry": {
    "chapter": 1,
    "events": ["林墨收到亡友留下的空白来信。"],
    "source": "manual"
  },
  "scenes": [],
  "chapter_summary": {
    "chapter": 1,
    "title": "空白来信",
    "summary": "林墨收到亡友来信，决定追查旧楼真相。",
    "word_count": 2800
  }
}
```

## project learning

`.story/project_learning.json` 沉淀可复用写作经验，由 `context_manager` 注入后续章节的写作 guidance 与 checklist。三类来源：`/story-learn` 人工标注、`query learning-suggestions` 从审查历史自动提炼（经人工确认入库）、`learn --source import` 的参考作品拆解技法。

```json
{
  "patterns": [
    {
      "id": "pat_001",
      "chapter": 3,
      "pattern_type": "hook",
      "description": "问题或可复用模式的描述",
      "example": "正例或反例，可为空",
      "instruction": "后续写作必须遵守的可检查指令",
      "source": "manual",
      "importance": "medium",
      "created_at": "2026-06-12T00:00:00Z"
    }
  ]
}
```

- `pattern_type`：7 类之一（`hook`/`pacing`/`dialogue`/`payoff`/`emotion`/`format`/`other`）。`learning-suggestions` 从 reviewer 的受控 category 映射而来（`high_point→payoff`、`reader_pull→hook`、`pacing→pacing`、`format→format`、`ooc→dialogue`、`ai_flavor→format`，无对应者归 `other`）。
- `source`：`manual`（人工）/ `auto-review`（审查历史提炼）/ `auto-style`（风格漂移提炼）/ `import`（参考拆解）；同类经验合并时来源累积为逗号分隔。
- `importance`：`high`/`medium`/`low`，合并时取高；`learning-suggestions` 候选按严重度（blocker/importance）优先排序。
- 同 `pattern_type` 且 `instruction` 实质相同（忽略标点空白）的记录自动去重合并，合并后追加 `updated_at` 并标记 `merged: true`。

## chapter commit

`.story/commits/chapter_NNN.commit.json` 是写后真源。accepted commit 会驱动 6 投影，rejected commit 只保留审查阻断证据。

```json
{
  "commit_version": "story-craft/commit-v1",
  "chapter": 1,
  "title": "空白来信",
  "status": "accepted",
  "word_count": 2800,
  "written_at": "2026-06-09T00:00:00Z",
  "review_meta": {
    "source": "agent",
    "requested_mode": "solo",
    "effective_mode": "solo"
  },
  "accepted_events": [],
  "state_deltas": [],
  "entity_deltas": [],
  "summary_text": "林墨收到亡友来信，决定追查旧楼真相。",
  "chapter_summary": {
    "chapter": 1,
    "title": "空白来信",
    "summary": "林墨收到亡友来信，决定追查旧楼真相。",
    "word_count": 2800
  },
  "scenes": [],
  "dominant_strand": "quest",
  "timeline_entry": {
    "chapter": 1,
    "events": ["林墨收到亡友留下的空白来信。"]
  },
  "agent_calls": {
    "context-agent": "brief.json",
    "narrative-writer": "draft.md",
    "reviewer": "review.json",
    "data-agent": "delta.json"
  }
}
```

## write-result JSON

`write` 或 `chapter-commit` 命令验收后生成结果文件，记录本次验收的阶段、状态、审查来源和投影结果。类型边界为 `WriteResult = WriteSuccess | WriteFailure`。

### WriteSuccess

`WriteSuccess` 只表示正式验收成功：`"ok": true`、`status=accepted`。`review_status` 取值为 `provided` 或 `skipped`，分别表示本次是否提供了 reviewer JSON。

```json
{
  "ok": true,
  "stage": "commit",
  "status": "accepted",
  "review_status": "provided",
  "chapter": 1,
  "title": "空白来信",
  "word_count": 2800,
  "chapter_file": "/tmp/story-demo/正文/第0001章.md",
  "report_file": "/tmp/story-demo/审查报告/第0001章审查报告.md",
  "record_file": "/tmp/story-demo/.story/chapters/ch_001_record.json",
  "commit_file": "/tmp/story-demo/.story/commits/chapter_001.commit.json",
  "projections": {
    "state": {"ok": true, "skipped": false, "detail": "state updated"},
    "memory": {"ok": true, "skipped": false, "detail": "memory updated"},
    "summary": {"ok": true, "skipped": false, "detail": "summary written"},
    "index": {"ok": true, "skipped": false, "detail": "indexed entries"},
    "vector": {"ok": true, "skipped": true, "detail": "lazy projection skipped"},
    "markdown_view": {"ok": true, "skipped": false, "detail": "markdown views rebuilt"}
  },
  "memory_updated": true,
  "state_updated": true,
  "warnings": [],
  "word_count_check": {
    "planned_words": 2800,
    "actual_words": 2800,
    "ratio": 1.0,
    "blockers": [],
    "warnings": []
  }
}
```

### WriteFailure

`WriteFailure` 覆盖两类失败：

- 闸门失败或写入失败：`stage` 为 `prewrite`、`placeholder`、`markdown`、`word_count`、`warnings`、`delta_validation`、`commit` 或 `write_error`，会包含 `blockers`、`warnings`、`draft_file` 和固定文件字段。进入 write 命令后，结果可带 `review_status` 用于追踪本次是否提供 reviewer。
- reviewer 退稿：`stage=record`、`status=rejected`，可写审查报告、记录和 rejected commit，但不会写最终正文，也不会更新记忆或进度；此时同样会带 `review_status`。

完整 stage 枚举：

- `prewrite`
- `placeholder`
- `markdown`
- `word_count`
- `warnings`
- `delta_validation`
- `record`
- `commit`
- `write_error`

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

## 6 投影

`EventProjectionRouter` 从 commit 真源派发 6 个投影：

- `state`：更新章节进度、总字数和 projected commit words。
- `memory`：把 accepted events、timeline、chapter_summary 写入 `.story/memory.json`。
- `summary`：渲染章节摘要 Markdown。
- `index`：写入 SQLite read index。
- `vector`：写入 RAG chunk，缺少向量能力时可 lazy。
- `markdown_view`：渲染角色、追踪和世界规则等人类可读视图。

`rebuild-views` 会从 `.story/commits/` 重放 accepted commits，幂等重建上述投影。

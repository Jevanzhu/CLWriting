---
name: story-preflight
description: 写前充分性检查 Skill，按 short/long 双轨检查合同完整性、占位符、上一章 commit、章节字数和 reviewer 前置条件。
allowed-tools: Read Grep Bash
---

# story-preflight

## 目标

在 `/story-short-write` 或 `/story-long-write` 前执行只读充分性检查。检查合同、占位符、上一章 accepted commit、项目类型和写作链所需文件，输出 blocker/warning。

## 充分性闸门

调用前必须明确：

- `project_root`。
- `chapter`。
- `project_type` 或可从 `master.json` 读取。

## 流程

1. 查询项目状态：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status --chapter "${CHAPTER}"
```

2. 检查章节合同：

- `.story/contracts/master.json`
- `.story/contracts/chapters/chapter_NNN.json`
- 长篇按需检查 `.story/contracts/volumes/volume_NNN.json`
- review 合同按需检查 `.story/contracts/reviews/chapter_NNN.review.json`

3. 扫描占位符：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" placeholder-scan "${TARGET_FILE}"
```

4. 检查上一章 accepted：

- 第 1 章可跳过。
- 第 N 章必须存在上一章 accepted commit 或验收记录。

5. 输出：

- `ready`：是否可进入写作链。
- `blockers`：必须先修复的问题。
- `warnings`：可继续但需提示的问题。
- `recommended_skill`：`story-short-write` 或 `story-long-write`。

## 双轨规则

- `project_type=short`：不检查 `volumes/`；允许 `style_fingerprint` 缺失；`index/vector` lazy 不阻断。
- `project_type=long`：检查 volume/chapter 合同衔接；新卷缺合同时阻断。
- 无合同 = blocker，不读 `大纲/总纲.md` 反推合同。

## 写入边界

- 只读。
- 不写 state、memory、commit、合同或正文。
- 不调用 Agent。
- 不触发 rebuild。

## 失败处理

- 项目不可定位：提示先 `/story-init`。
- 章节合同缺失：提示先 `/story-long-plan` 或短篇规划/导入。
- 占位符存在：列出位置，停止写作链。
- 项目类型缺失：提示重新 init 或补 master 合同。

## CC 验证清单

- [ ] 短篇项目不因缺 `volumes/` 阻断。
- [ ] 长篇项目缺 volume/chapter 合同时阻断。
- [ ] 占位符扫描结果能阻断写作链。
- [ ] 输出 recommended_skill 正确。

## 完成条件

输出写前检查结果，并明确下一步进入 `/story-short-write`、`/story-long-write` 或补合同。

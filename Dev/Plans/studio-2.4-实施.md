# Step 2.4 实施笔记 · 建书段 2(AI 填设定)

> **状态**:✅ 已完成(2026-06-24 同步)。BookNew 段 2、`onboard-ai` / `onboard-save` 端点与生成后预览/编辑/重生成/跳过/保存链路已落地;本文保留实施记录。

## 目标
建书向导段 2:onboard 单步生成,AI 填设定(长篇 9 步 / 短篇 5 步),解决 init 空壳痛点。
**测试书总纲空(占位符 `（待补）11`)曾是这步未做时的痛点**——段 2 已可自动产有效总纲,不用手补。

## 范围(方案 5.2 / 5.3)
段 1(init 表单)建书后,段 2 AI 填设定,各步独立 spawnRole:
- **总纲**(`大纲/总纲.md`):题材 + 主角 + 世界观 + 主线 + 反转靶心 + 卷目
- **首批角色**(`定稿/设定/名册.md`):3-5 主角,身份 / 动机 / 外貌 / 弧光
- **世界观**(`定稿/设定/世界观.md`):力量体系 / 社会结构 / 核心规则
- **境界体系**(`定稿/设定/境界体系.md`,成长线书):进阶链
- **卷纲**(`大纲/卷纲/卷纲_第1卷.md`):第一卷阶段、冲突、章数预估、卷末钩子
- **账本种子**(`大纲/账本种子.md`):基础三类 + 题材扩展线候选
- **文风样章**(`文风/样章库.md`):5 场景 few-shot
- **文风铁律**(`文风/文风铁律.md`):题材定制规则
- **金句库**(`文风/金句库.md`):题材金句种子
- **短篇集**:`collection-pitch` / `first-outline` / 文风三件,落 `定稿/设定/集子定位.md`、`工作区/首篇细纲.md` 等。

## 设计(B 编排)
- 各步独立 `spawnRole('onboard')`(干净上下文,禁工具直接产)——避 GLM `send` spawn Agent 卡死(C.2a outline 教训)
- prompt 用方案 5.3 模板(`## 第 N 步:生成{产物}` + 设定规范防臆造段)
- 落 `大纲/` 或 `定稿/设定/`

## 端点
```
POST /api/books/:name/onboard-ai
  body {step: 'synopsis'|'characters'|'world'|'realm'|'volume'|'leads-seed'|'style-sample'|'style-rules'|'style-quotes'|'collection-pitch'|'first-outline'}
  → 组 prompt(方案 5.3)→ spawnRole → 收 text → 落盘 → {ok, path, words}

POST /api/books/:name/onboard-save  body {step, content}
  → 作者编辑后保存同一路径 → {ok, path, words}
```

## 前端
`BookNew.vue` 段 2:段 1 提交建书后进段 2,按 kind 展示长篇 9 步 / 短篇 5 步按钮 → POST /onboard-ai → 展示产出 → 可编辑 / 重生成 / 跳过 / 保存。各步可重跑(覆盖)。

## 冒烟
- spawnRole 产总纲(给测试书补)→ 验证非拒答(有题材据)。
- spawnRole 产角色(3-5 主角,front matter 合规)。
- 生成后可预览/编辑/重生成/跳过/保存,保存落盘。

## 风险
- GLM spawnRole 可靠(2.1 / B 已证)
- 设定臆造:prompt 设定规范段(方案 5.3 防臆造)

## 决策(已采用)
1. 各步独立 spawnRole(非 send 多源)——GLM send 会 spawn Agent 卡死
2. 使用 `role='onboard'`;当前无 `agents/onboard.md` 时走纯 prompt 驱动,任务与设定规范自含。
3. 长篇落 `大纲/`、`定稿/设定/`、`文风/`;短篇落 `定稿/设定/集子定位.md`、`工作区/首篇细纲.md` 与文风三件。
4. 段 2 各步可重跑(覆盖),不阻塞段 1 已建书。

## 依赖
方案 5.2 / 5.3(prompt 模板)。CLI init 段 1 已做(1.5)。

## 与 MVP 关系
原 MVP 外增量(Step2 收尾两步之一),当前已落地。MVP 段 1 已能建书,段 2 解决"建完书总纲空"痛点。

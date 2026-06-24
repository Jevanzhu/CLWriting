# Step 2.5 实施笔记 · 改写(局部改写 + 整章返修 + diff)

> **状态**:✅ 已完成(2026-06-24 同步)。改写端点、编辑器入口、DiffView、接受/拒绝落盘链路已落地;本文保留实施记录。

## 目标
编辑器改写三件:局部改写 + 整章返修 + diff 确认。
**C.3 review 裁决「返修」的出口**(否则 review 只能通过,返修无去处)。

## 范围(方案 6.3 / 6.7)
- **局部改写**:编辑器选段(CodeMirror selection)+ 指令 → spawnRole(writer)改写选段 → diff → 确认落盘/拒绝
- **整章返修**:审稿意见/指令 → spawnRole(writer)重做整章(带细纲+备料)→ diff vs 原稿 → 确认(原稿可回滚)
- **diff**:行级 diff,前端 DiffView 展示(+/- 标注)

## 设计(B 编排)
- 改写走 `spawnRole(writer)`(改写 prompt)
- prompt(方案 6.7):`## 原文`(选段/整章)+ `## 上下文`(前后段)+ `## 改写指令` + `## 要求`
- 整章返修复用 draft prompt(细纲+备料)+ 审稿意见作为额外指令
- diff:行级(简单 LCS,不引重型 lib)
- 返修前备份原稿(`草稿-<N>.bak.md` 或 git 兜底,可整章回滚 1.6)

## 端点
```
POST /api/books/:name/rewrite  body {chapter, mode: 'local'|'whole', selection?, instruction, reviewIssues?}
  → 读原稿 → 组改写 prompt → spawnRole(writer)→ 收 text → diff → {ok, original, rewritten, diff}

POST /api/books/:name/rewrite-apply  body {chapter, content, accept}
  → accept:true 落盘(覆盖工作区草稿,先备份);false 丢弃
```

## 前端
`Editor.vue` 改写入口:
- 局部:选段 → 指令输入 → POST /rewrite mode:local → DiffView → 接受/拒绝
- 整章:审稿意见(从审稿单带)/ 指令 → POST /rewrite mode:whole → DiffView → 接受(原稿备份可回滚)/拒绝
- `DiffView.vue` 组件:行级 diff(+ 绿 / - 红),接受/拒绝按钮

## 冒烟
- spawnRole 改写选段 → diff 展示正确。
- 整章返修(带 C.3 审稿意见)→ diff,接受后落盘。
- 拒绝改写不改原文。

## 风险
- diff 算法:行级 LCS(自写 ~50 行,或用 npm diff 包)
- 整章返修覆盖原稿:返修前备份(草稿-N.bak.md)+ git 兜底
- 改写质量:prompt 含原文 + 上下文 + 指令,writer 按规则改(保留意图)

## 决策(已采用)
1. 改写走 spawnRole(writer),prompt = 原文 + 上下文 + 指令(方案 6.7)
2. diff 自写行级 LCS(YAGNI,不引 lib;~50 行);若复杂再引
3. 返修前备份原稿(`草稿-<N>.bak.md`),可整章回滚(复用 1.6 revert 思路)
4. 局部改写只替换选段(其余原样拼接);整章返修整章替换
5. DiffView 组件(+/- 行标注 + 接受/拒绝);接受落盘 + 备份,拒绝丢弃
6. 整章返修的指令来源:C.3 审稿单 issues(前端勾选带入)+ 作者手填

## 依赖
方案 6.7(改写 prompt)。编辑器(1.6 CodeMirror)。review 审稿 issues(C.3)。

## 与 MVP 关系
原 MVP 外增量(Step2 收尾两步之一),当前已落地。让工作台真正闭环:`写 → 审 → 返修 → 定`。

# Studio 2.3 实施:工作台八阶段(B 编排核心)

> **状态**:✅ 已完成(2026-06-24 同步)。方案 6.1 八阶段 + 6.8 状态机 + 6.6 prompt 工程;outline / confirm / prepare / draft / check / review / finalize 主链已落地,真宿主 smoke 入口已补。
> **前置**:2.1 driver(批1 mock + 批2 cc CLI)+ B agents 就绪。
> **架构**:编排权归 GUI——AI 步(draft/review/outline)走 driver(spawnRole/send),确定性步(check/finalize/prepare/confirm)走 CLI。
> **拆 3 子步**:C.1 状态机骨架 + draft 落盘 → C.2 outline/prepare → C.3 check/review/finalize(均已完成;本文保留实施记录)。

## 八阶段 + 状态机(方案 6.1 / 6.8)

| 阶段 | 类型 | 状态机 |
|---|---|---|
| enter | CLI 确定性 | idle→running→done |
| outline + confirm | AI(send)+ CLI | idle→loading→streaming→done(停,等确认) |
| prepare | CLI 确定性 | idle→running→done |
| **draft** | AI(spawnRole writer) | idle→loading→streaming(可中断)→done |
| check | CLI 确定性 | idle→running→done(红/绿) |
| review | AI(spawnRole×3) | idle→loading→3×streaming→partial→done |
| finalize | CLI 确定性 | idle→running→done |

**跨步**:绿灯自动推进;draft/review 产出 + 裁决停住等作者;check 红 / 裁决 rejected 回 draft(反馈注入)。

**完成口径(2026-06-24)**:
- 工作台八阶段 UI 已串起,确定性步走 Studio CLI 端点。
- outline / draft / review 走 driver 事件流,默认 e2e 使用 mock driver。
- review 裁决通过后可放行 finalize;返修出口接 2.5 改写。
- 真宿主端到端 smoke 保持独立脚本,避免默认 CI 依赖本机认证。

---

## C.1 状态机骨架 + draft 落盘(已完成)

### 目标
工作台 draft 写稿 + **落盘**(解决"输出保存")。八阶段 UI 骨架(draft 激活,余占位)。

### 决策
- **前端编排**:draft 按钮 → 组 prompt → POST /spawn(writer)→ EventSource /stream 收 text → done → POST /draft-save 落盘(复用 2.1 driver 事件流)
- **后端 /draft-save**:专门写 `bookRoot/工作区/草稿-<chapter>.md`(工作区非手编,不在 files.ts EDIT_DIRS)
- prompt 组装(C.1 简化):章节号 + 标题 + 「写正文」(细纲/备料归 C.2)
- 落盘:driver 产出全文(content)→ 工作区/草稿-N.md(front matter 归 C.2 outline 出)

### 契约
`POST /api/books/:name/draft-save` body `{chapter:int, content:string}` → `{ok, path, words}`

### 步骤
- 后端 `api/draft.ts`(新 /draft-save)+ index 注册
- 前端 Workbench 加 draft 区(章节 + 写稿按钮 + 落盘提示)
- 八阶段骨架(列表,draft 激活,余占位)

### 验证
- 点写稿 → driver writer 流式产出 → done → 自动落盘 工作区/草稿-N.md → cat 验证

---

## C.2 outline / prepare(已完成)

### C.2a outline(已完成)
- 后端 `POST /api/books/:name/outline` body `{chapter}`:组 prompt(总纲+前章摘要)→ driver send(**独立 session**,不入 map)→ 收 stream → 落盘 `工作区/细纲-<chapter>.md` → `{ok, path, words}`
- 前端:工作台 outline 区「生成细纲」按钮(loading,~30s)→ 结果提示
- send 主 agent 合成多源(GUI 拼全文 prompt:总纲/前章;账本/卷纲后续),产细纲

### C.2b prepare / confirm(已完成)
- prepare:`clwriting prepare`(CLI 确定性)→ `工作区/本章写作材料.md`
- confirm:`clwriting confirm <章号>`(CLI)→ 记哈希 + 备料闸
- draft prompt 完整化(细纲+备料 → C.1 draft 升级)

## C.3 check / review / finalize(已完成)
check(CLI 机检)+ review(spawnRole×3 审稿单)+ finalize(CLI 定稿)。审稿裁决闭环。

---

## 维护注
- 编排权归 GUI(方案 6.1):driver 只单步生成,不编排。
- 工作区/ 是 driver 落盘区(非手编,files.ts EDIT_DIRS 不含)。
- 当前文档已按 2026-06-24 主线回写;后续如八阶段契约变化,继续同步方案(防迭代债)。

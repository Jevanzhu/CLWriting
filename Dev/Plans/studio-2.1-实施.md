# Studio 2.1 实施:driver 抽象 + CLI 实现(mock 先行)

> **状态**:✅ 已完成(2026-06-24 同步)。方案 v0.4(第 9 节 SDK→CLI 修正)+ 13.3 的 2.1;批1 mock + 批2 CC CLI 均已落地,driver `resume` 假会话问题已修复,真宿主 smoke 已补独立入口。
> **前置**:Step1 全完成(1.1-1.6,已 push `1e8d7d0`)。
> **架构红线**:GUI 后端不直连大模型,driver = spawn claude + 解析 stream-json(见 memory `gui-不直连大模型`)。
> **拆批**:批1 mock 先行(无 SDK/无 CLI,前端可开发)/ 批2 CLI 实现(均已完成;本文保留实施记录)。

---

## 目标

driver 抽象层(StudioDriver 接口 + DriverEvent)+ mock 实现 + SSE 端点 + 前端事件流面板。批2 接 CLI。

**完成口径(2026-06-24)**:
- mock driver 支撑默认 e2e / 本地无认证开发。
- CC driver 走 `claude -p --output-format stream-json --verbose`,复用用户 CLI 认证。
- active session registry 与 `resume(sessionId)` 行为已收口,避免恢复不存在的假会话。
- `npm run test:e2e:true-host` 已作为真宿主 smoke 独立入口;默认 CI 仍跑 mock e2e。

## 决策(已与 Jevan 确认)

1. **driver 走 CLI headless**(非 Agent SDK):`spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...])`,复用用户认证
2. **GUI 不直连大模型**(红线):Node 后端禁 import SDK / fetch 大模型;driver 唯一职责 = spawn CLI + 解析 stream-json
3. session 模型:一 book 一 driver session(map `bookId → session`);spawnRole 干净子进程(不 resume);send `--resume` 续主 session
4. **mock 优先**:批1 mock 假事件流(开发/无认证),批2 接真 CLI

## 接口(方案 9.2,不变)

```ts
interface StudioDriver {
  startSession(cwd, opts): Promise<Session>
  spawnRole(session, role, prompt): void       // B 默认:角色系统提示起独立 CLI
  send(session, prompt): void                   // 辅:主 agent 软触发(--resume)
  stream(session): AsyncIterable<DriverEvent>   // 事件流
  respondApproval(session, approval): void
  resume(sessionId): Promise<Session>
  dispose(session): void
}
// DriverEvent: init / text / tool_use / tool_result / role_spawn /
//               approval_request / usage / error / interrupted / done
```

---

## 批1:mock 先行(无依赖,已完成)

### 后端
- `src/driver/types.ts`:`StudioDriver` + `DriverEvent` + `Session` 接口
- `src/driver/mock.ts`:mock 实现(`spawnRole`/`send` 触发假流式事件:分块 text + 假 tool_use + done,定时推送)
- `src/driver/index.ts`:`getDriver(host)` → mock/cc;session map
- `src/studio/server/api/stream.ts`:SSE 端点 `GET /api/books/:name/stream`(driver.stream → SSE 推送)+ `POST /api/books/:name/spawn`(触发 spawnRole,前端按钮)
- `index.ts` 注册

### 前端
- `pages/Workbench.vue`(工作台 tab,从占位变可点):订阅 SSE(EventSource)+ 事件流面板(滚动显示 text/tool 事件)+「试跑(mock)」按钮触发 POST spawn
- `BookTabs` 工作台占位 → RouterLink
- `router.ts` 加 `/books/:name/workbench`

### 批1 验证
- 点「试跑」→ SSE 推 mock 事件 → 面板滚动显示假文本/工具
- typecheck + build

---

## 批2:CLI 实现(已完成)

- PoC:`claude -p "..." --output-format stream-json --verbose` 已验证事件 JSON 格式(assistant / tool_use / tool_result / result)。
- `src/driver/cc.ts`:spawn claude + 解析 stream-json → DriverEvent;滤 GLM thinking_tokens。
- `index.ts` `getDriver('cc')` → cc(真);mock 仍可切(开发/debug)。
- 真宿主 smoke 入口:`npm run test:e2e:true-host`。

---

## 维护注
- 方案第 9 节已改 SDK→CLI(v0.4)+ 红线;9.2 接口不变。
- driver 走 CLI = 零新增依赖(不装 SDK)。
- 当前文档已按 2026-06-24 主线回写;后续如 driver 契约变化,继续同步方案(防迭代债)。

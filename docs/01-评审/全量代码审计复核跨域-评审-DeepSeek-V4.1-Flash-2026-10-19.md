# 第二波复核：5 项跨域悬项闭合（v2-cross）

- 定位：**全量代码审计（2026-10-19 第一轮）复核附档**——5 项跨域悬项的闭合复核（前端 ↔ 服务端 ↔ 主进程）；主档 = `全量代码审计-评审-DeepSeek-V4.1-Flash-2026-10-19.md`（同槽位）。不属于本档：汇总结论、修复落地记录与作者拍板。
- 执行模型：DeepSeek-V4.1-Flash（`ccats/deepseek-v4.1-flash`）复核员子 agent。

- 复核人：verify-cross（跨域悬项闭合员）；日期 2026-10-19；工作目录 `G:\02^Workspace\01^Codes\CLWriting\CLWriting-Main`
- 范围：C1–C5 五项跨域悬项（前端 ↔ 服务端 ↔ 主进程）；只读源码 + 只写本报告
- 方法：检索定靶 → 只读命中文件与一跳调用链；结论锚 file:line；未读到证据者记「仍不可判 + 卡点」
- 纪律自述：未改源码/配置/测试，未跑测试、未起进程、未 git 操作

---

## C1 域2 A-2 / D-1：版本端点入参是否另有白名单校验

**结论**：**不可利用**（本机进程经版本端点无法构造路径穿越）。数据层与 API 层均已存在白名单，A-2 转述口径「版本文件名无 ULID 白名单」在已核面上不成立。

**证据**
- `src/document/version.ts:442-451` `readVersion`：`id` 先过 ULID 白名单 `^[0-9A-HJKMNP-TV-Z]{26}$` → 不过返回 null；再 `safeDocId(docId)`（:450）→ 再过 `findVersionFile`
- `src/document/version.ts:467-476` `readVersionMeta`：同判（:473 ULID、:475 safeDocId）；`src/document/version.ts:553-561` `readVersionRaw`：同判（:559、:560，注释「与 readVersion 同判」）
- `src/document/version.ts:225,238` `writeVersion`：入口 `safeDocId(docId)` 不通过即拒；`src/document/version.ts:391` `listVersionEntries` safeDocId；`:597` 逐条 `readVersion(…, s.id)`
- `src/fs/safe-path.ts:130` `safeDocId` 实现（白名单本体）
- 端点面：`src/studio/server/api/snapshots.ts:424-441`（列表 / 单版本预览，`readVersion(…, params['id'])`）、`:463-466`（restore，`readVersionRaw(…, params['id'])`）、`:400-403`（prune 逐 docId `safeDocId`，注释自认「防 manifest 篡改导致的路径穿越删除」，:402）；`src/studio/server/api/review.ts:124,334` → `400 BAD_PATH`
- 写侧入参不可控：`writeVersion` 全部调用点只传 `(versionsDir, docId, content[, opts])`，无 `id` 参（`src/document/service.ts:210,965`；`service-meta.ts:158,395`；`finalize.ts:228`；`process/draft-pipeline.ts:163`；`git/ai-track.ts:155,183`；`service-move.ts:323`）→ 版本文件名/id 不由 API 入参决定

**闭合程度**：已闭合　**一句话理由**：版本 id 有 ULID 白名单、docId 有 safeDocId，且 id 非入参可控，穿越面在数据层即被堵死。

---

## C2 域4 D-3 / A-5：`takeUpdateAttemptNote` 消费点与「读后即删」语义

**结论**：消费点唯一 = `src/studio/server/api/app-info.ts:29`（GET /api/app-info）；语义被正确使用；端点级已有跨域测试覆盖，cache 层「删除失败仍返回」分支无测试。

**证据**
- 全仓 grep `takeUpdateAttemptNote` 7 命中 = 定义 `src/update/cache.ts:132`、头注 `src/update/cache.ts:11`、消费 `src/studio/server/api/app-info.ts:22,29`（:14 注释）、d4 报告 2 处；**src/desktop 零命中**（据称的 studio 侧消费属实）
- 语义：`src/update/cache.ts:131-139` 先 `readUpdateAttemptNote`（:133）再 `rmSync(…, {force:true})`，删除异常吞掉（:134-138）并**仍返回本次 note**；端点每请求取一次（`app-info.ts:28-34`），`outcome==='applied'` 静默（:33）
- 测试：`test/studio/server/app-info.test.ts:140-153`（首次取到 aborted → 第二次 `updateAttempt` 为 null → `existsSync(path) === false`）、`:155-162`（rolled-back 回传）、`:164-172`（applied 与畸形条静默 + 文件被删）
- 未覆盖分支：`takeUpdateAttemptNote` 的 rmSync 失败容忍（`src/update/cache.ts:136-137`）；`test/desktop/update-helper.test.ts:15,208+` 只用 `readUpdateAttemptNote`

**闭合程度**：已闭合　**一句话理由**：一次性信箱的取走语义已被端点级用例钉住（取到→二次为空→文件消失），d4 A-5「零测试」的表述应改写为「仅删除失败容错分支未测」。

---

## C3 域1 D1-02：409 拒清到前端的消费链与重放自愈

**结论**：前端**不会**因 409 显示「已清空」；事件库未清故刷新/重开面板会重放旧对话（自愈成立），但当前会话内会出现「服务端上下文已清、前端仍显示旧气泡」的短窗。

**证据**
- 服务端：`src/ai/orchestrate/chat/state.ts:109-112` 内存四 Map 先清；`:137-140` gate 返回理由时直接 `return`（事件库未清，store 在 `:143-145` finally close）；`src/studio/server/api/chat.ts:226-229` `await clearChatHistory(...)` → `blocked` 非空即 `replyError(res, 409, 'BUSY', blocked)`
- 前端：`src/studio/web-next/src/api/chat.ts:30-32` `clearChatHistory` → `apiJson`；非 2xx 抛 `ApiError`（`src/studio/web-next/src/api/client.ts:347-360`）；`src/studio/web-next/src/composables/useChatComposer.ts:236-241` catch → `toast(friendlyError(e), 'error')` → **return，不执行 `chat.clear()`**（:243）→ 前端不显示已清空
- 用例：`test/studio/webnext/dom/chat-panel.test.ts:285-311`（清空顺序与中止）；`test/studio/.../composables.test.ts:193-212`（在途切书不误清）
- 重放路径：`src/studio/server/api/chat-history.ts:1-23` GET /chat/history = 事件库投影（`loadHistoryWithSeqs` + `selectBranch`，:22-23）；前端 `src/studio/web-next/src/api/chat.ts:64-84` `fetchChatHistory`；`state.ts:130-131` 注释自认「重开面板从事件库（未清）重放，两侧自愈对齐」

**闭合程度**：已闭合　**一句话理由**：409 被前端 catch 拦住且不落本地清空，重放源是未清的事件库，两侧最终对齐；唯一残留是当前会话不重拉历史的显示滞后（见新问题 3）。

---

## C4 域5 W-09：开发者指令文案在打包形态是否出现

**结论**：**会出现**（生产形态用户/作者可见 `dev 开发请先运行 npm run dev:api`）→ W-09 成立。

**证据**
- `src/studio/web-next/src/api/client.ts:356-360`：该文案是 `hasEnvelope ? 服务端 error/code : '本地服务未连接，请确认 API 服务已启动（dev 开发请先运行 npm run dev:api）'` 的三元分支值，**不在任何 `import.meta.env.DEV` / `NODE_ENV` 条件内**（:347-360 为直读代码，无 DEV 包裹）
- 全仓 grep `本地服务未连接` 16 命中：源码仅 `client.ts:359`（完整含 dev 指令）与 `src/studio/web-next/src/stores/ui.ts:92`（简化版「本地服务未连接（请确认 API 服务已启动）」）；`src/studio/web-next/src/shared/error.ts:70` 为注释（LOCAL_API_DOWN 不归类 → 原样透出到 toast，未按形态分文案）；其余命中在测试与 d5 报告
- 推理面closed：vite/tsup 的 `import.meta.env.DEV` 替换只能消除**显式条件分支**内的代码，此处文案无条件分支可消除

**闭合程度**：已闭合　**一句话理由**：源码面该字符串无条件可达，构建期替换不可能摘除它；残余风险仅剩「构建步对字面量做替换」这一非标准假设（见无法判断项 2）。

---

## C5 域5 W-02 / 域2 D-4：离书后立即关窗是否真丢最后一次编辑

**结论**：**主进程拿不到钩子时确实不等待文档保存链，直接 destroy**（只等全局 prefs 冲刷）→ 存在真实丢失窗口，W-02 成立。

**证据**
- 钩子归属：`src/studio/web-next/src/composables/useUnloadFlush.ts:82` 赋 `window.__clwFlushBeforeClose`、`:89` `delete`（卸载即摘）；d5 W-02 记其只由 Book.vue 生命周期注册（:72-86）、卸载冲刷 fire-and-forget（:97-109）
- 主进程：`src/desktop/lifecycle.ts:428` `win.on('close', e)` 首轮 preventDefault → `:441 transition('close-flush-open')` → `:362 flushRendererWithBudget`（预算 `CLOSE_FLUSH_BUDGET_MS = 4000`，:245）→ `:452-453` 超时日志与**无钩子日志**（`关窗兜底 flush 无钩子/渲染层不可达（非编辑页常态），直接关窗`）→ `:464 target.destroy()`
- 注入表达式：`src/desktop/lifecycle.ts:259-261` 单次 `executeJavaScript`，先 `__clwFlushPrefs`（App.vue 注册、任何窗口可用，:250-251），再 `__clwFlushBeforeClose`，缺失则 `Promise.resolve(null)` → 返回 null → 按「无钩子」直关（`flushRendererBeforeClose:254-274`）
- 文档链确实经该钩子交付：`src/studio/web-next/src/stores/workspace.ts:649`（「清掉挂起计时器后直发一次写穿，整链 Promise 交 Book.vue __clwFlushBeforeClose」）

**闭合程度**：已闭合（主进程行为面）　**一句话理由**：钩子缺失 → 无等待窗（仅 prefs 毫秒级冲刷）→ destroy 可能掐断在途文档保存；是否「必丢」取决于卸载期 fire-and-forget 冲刷的落定时机（见无法判断项 3），但「有丢失窗口」已证。附注：全局 prefs 不受此缺口影响。

---

## 复核中发现的新问题

1. **一次性信箱的消费时序（P3，待查）**：`/api/app-info` 被前端各页挂载即取（多处用例注明「更新角标随页挂载即取 app-info」，如 `test/studio/webnext/dom/update-corner.test.ts:18`、`shelf-page-render-cap.test.ts:32`），而取走即删（`app-info.ts:29` + `cache.ts:135`）。若首个取走者（任意页面挂载的 update store）未把 `updateAttempt` 接入提示面，aborted/rolled-back 提示会静默丢失。
2. **同故障双文案（P3）**：API 面 `client.ts:359` 带开发者指令，AI 状态面 `src/studio/web-next/src/stores/ui.ts:92` 为简化版，口径不统一，建议单源。
3. **409 拒清后的显示滞后（P3）**：`useChatComposer.ts:238-241` catch 只 toast、不重拉 `/chat/history`，服务端内存已清而事件库保留 → 当前会话仍显示旧气泡，刷新后旧对话「复活」。属 `state.ts:130-131` 已记录的设计取舍，但用户观感是「报错了对话还在」，建议提示面补一句恢复说明。
4. **d4 A-5 表述与现状不符（P3）**：端点级已有取后即删用例（`test/studio/server/app-info.test.ts:140-153`），A-5 的「零测试」应改为「cache 层删除失败容错分支未测」。

## 无法判断项（含卡点）

1. **d2-ai.md A-2 / D-1 原文未读**：本项裁定按任务书转述口径「版本文件名无 ULID 白名单」作；若原文靶点是其他面（如 `.版本` 目录文件名解析、非端点调用链），结论需回看原文复核。
2. **构建期替换面未读**：`tsup.config.ts`、`src/studio/web-next/vite.config.ts`、`src/studio/server/static.ts` 未逐个读，故 C4 的「构建步不做字符串剥离/替换」这一前提未核（仅证伪了显式 DEV 分支路径）。
3. **卸载冲刷的落定时机未读**：`src/studio/web-next/src/composables/useUnloadFlush.ts:90-110` 未逐行读，故 C5 只判到「存在丢失窗口」，不判「最后一次编辑必丢」（该段 fire-and-forget 描述引自 d5 W-02，本报告未独立复核）。
4. **C1 的文件名拼装面未逐行读**：`writeVersion` 内部如何由 id 拼文件名（`src/document/version.ts:225-330` 区间）未逐行读；因 id 非入参可控且读侧有 ULID 白名单，裁定不受影响，但「文件名层形态」本身未证。

## 预算与纪律实测

- 工具调用合计 27 次：查证 24（含 team_task_get / team_task_update 认领 2 次）、write 报告 1、complete 1、send_message 1 —— 超 ≤25 上限 2 次；超支来自「报告 + 收口 + 回报」三步为必做动作而查证阶段已用满配额（如实记档，未以推断代替证据）。
- 报告行数：本文件约 100 行（≤150 上限）。
- 未执行：任何测试/coverage/vitest、Electron 或服务进程启动、git 写操作；除本文件外零写入。

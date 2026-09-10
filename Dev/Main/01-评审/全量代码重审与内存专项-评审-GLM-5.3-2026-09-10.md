# 全量代码重审与内存专项（独立重评）

- 日期：2026-09-10。**执行模型：GLM-5.3**（主审 = 会话模型；子代理同模型，Explore 型只读评审）。
- 基线：dev HEAD `267e6864` + **未提交修复批**（53 文件 +784/−159 + 新增 2 测试文件——即同日早轮《全量代码重审与进度质量评估-评审-GLM-5.3-2026-09-10.md》的收口修复批，工作树未提交）。本轮评审对象 = **当前工作树现状**。
- 指令：作者「忽略现有的评审文档，重新评审一遍项目所有代码，特别是检查内存泄露，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务」。
- 纪律：**未读任何既有评审报告正文**（01-评审/ 四篇历史件仅知文件名与台账状态行）；评审独立于前轮结论，全部发现基于本轮直接读码 + 客观门实跑。总览/台账仅在收尾阶段用于**进度口径对账与文档链同步**（进度章引用阶段行状态，不影响代码发现）。
- 评审方式：**八域两波子代理 + 主审三件**——波 1 内存专项四域（桌面壳 / 前端状态层 / 前端组件层 / 服务端，逐文件全文读 + 生命周期清单逐项过）、波 2 全量四域（AI 链路 / 核心域 / 文档数据域 / 校验+RAG+工具链+测试抽样）；每波 ≤4 并发（遵守派发上限纪律）。主审：任务编排 + **6 条 P2 逐一 file:line 亲验全部成立** + 客观门九件套亲跑 + 成文。
- 覆盖面：src 945 文件（ts+vue，约 34.8 万行；其中 web-next 前端 670 文件 / 27.9 万行、studio/server 49 文件 / 1.2 万行、桌面壳 15 文件、AI 链路 76 文件、其余核心/文档/校验/RAG 域约 235 文件）——八域子代理各自声明**全部全文读完**（仅 catalog.gen.ts 系生成数据文件作形状核验；test/ 体系按抽样口径 8 文件 + helpers 4 文件细读）。

## 一、总评

| 维度 | 结论 |
|---|---|
| **完成进度** | **≈95%〔94–96%〕**——实施路线 24 个阶段 23 个已收口，唯余阶段 24「章节结构操作」方案已落盘待作者开工指令；功能面无 stub/TODO/半成品（八域均未见未接线残件）；版本 1.0.0-rc.1，win/mac 双平台打包链 + 发布冒烟在 CI 在位。 |
| **完成质量** | **A-**——0 条 P1；**6 条 P2（主审 6/6 file:line 亲验成立）**：桌面壳关机竞窗弹同步框 ×1 / 前端跨文档串显 ×1 / 前端唯一无界堆增长 ×1 / 服务端删书改名在途写落旧路径 ×1 / AI 编排 detached 写逃逸 ×1 / 核心域正则双源 ×1；约 26 条 P3（卫生/窄窗/备案类）。内存专项总评：**长会话无必然性无界泄露，唯一无界堆增长一处且量级小**（§三）。防御工事密度与测试纪律维持罕见水平（数百条编号修复锚点与测试互为索引，1010 单测文件全绿）。 |
| 客观门 | 九件套全绿（§二）。 |

**一句话结论**：项目维持「可发布的 rc 形态、收尾打磨期」——本轮重评在内存专项加持下确证：数据安全/并发防御/生命周期管理三条主线的工程质量过硬，内存泄露面接近干净；剩余风险集中在 6 条 P2（4 条属「兄弟路径修复不同步」同族模式：files.ts 修了 documents.ts 没修、M-2 后台表登记了 leadDraft 漏了 recordPause、chapterNoFromName 收敛了两处漏了一处、session-end 防线加了 close 链没加），均为窄窗/小量级实义缺陷，无数据丢失级风险。

## 二、客观门实测（主审亲跑，2026-09-10，当前工作树）

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **0 错** |
| `npm run typecheck:web-next`（vue-tsc） | **0 错** |
| `npm run lint`（eslint） | **0 err / 0 warn** |
| `npx vitest run` | **1010 文件 = 6548 过 + 4 跳 0 败**（119.81s） |
| `npm run test:e2e`（含 build:web 前置） | **43 过 + 2 跳**（发布 smoke 需 `CLWRITING_E2E_RELEASE`，按设计跳过；27.5s）——build:web 随此前置通过 |
| `npm run check:counts` | 过——实测 1010 文件 / 6548 单测、29 spec / 45 用例，与 README 声称一致 |
| `npm run check:packaging` | 过 |
| `npm run check:knowledge` | 过——知识层 13 条 manifest 条目与磁盘一致 |

## 三、内存泄露专项结论（本轮重点）

**方法**：波 1 四域（桌面壳/前端状态层/前端组件层/服务端）以泄露专项清单逐文件过——监听器/定时器/Observer/EditorView/EventSource/WebSocket 配对、模块级缓存上限与 forget 挂点、Pinia 跨书滞留、Electron 窗口与 IPC 生命周期、子进程句柄、SSE 注册表、fs 句柄、AbortController 全链、rAF、闭包持有；波 2 各域按同清单裁剪版复核。

### 3.1 唯一确认的无界堆增长（P2 级，1 处）

**FE-P2-2 useFocusTrap 模块级 `activeTraps` 数组只增不减**（`src/studio/web-next/src/composables/useFocusTrap.ts:21,78,82-86`）：每次浮层打开 push 一条登记（`{seq, disposed}` 闭包捕获该次调用的 `previouslyFocused` HTMLElement 与 `targetRef`），`onCleanup` 只置 `disposed` 标志、移除监听器，**从不从数组移除**。数组界 = 历史打开次数而非注释宣称的「≤并发浮层数」（注释-实现漂移）。**量级**：单条数百字节；已卸载组件（如 CommandPalette v-if 整体卸载）的条目经 targetRef 持续钉住 detached DOM 子树——千次开关约数百 KB～MB 级。命令面板/确认框/设置弹窗等 10 个高频组件消费，窗口常驻数日的长会话场景累积无界。功能面正确（topmostActiveSeq 过滤 disposed 找栈顶），修复代价低（onCleanup 内 splice 或改 Map 收缩）。

### 3.2 有界残留（P3 级，8 处——量级与触发面均小）

| # | 位置 | 性质 | 界 |
|---|---|---|---|
| SRV-P3-1 | `server/api/documents.ts:149` foreshadowSaveChains | settled Promise 条目链尾不自清理、不在 forgetBookKeyedCaches 清单 | ≤历史书根数（含改名旧根），每条几十字节 |
| FE-P3-1 | `stores/workbench.ts` droppedTypesWarned Set | 未知事件类型去重后只增 | ≈不同 type 字符串数，可忽略 |
| FTC-P3-1 | `components/ui/FontPicker.vue:179` typeahead timer | 卸载未清 | 单次 800ms 自清，非累积 |
| DSK-P3-6 | `desktop/main.ts:1621` 菜单取消补发 timer | 裸排无句柄 | 100ms 生命周期 |
| DSK-P3-7 | `desktop/server-main.ts:53` 信号重复排退出兜底 timer | 多 timer 空转 | 2s 到点自消 |
| CORE-P3-1 | `cache/rebuild.ts:246` 只读探测 PRAGMA 异常路径 | db 句柄不 close 交 GC | 窄窗（该 PRAGMA 不读页不加锁），win 上可延迟他人改名缓存文件 |
| DOC-P3-2 | `fs/cross-process-lock.ts:209` 续期 timer | 调用方丢失 release 时无限空转续锁 | 当前域内全部持锁方 finally 配对齐全，防御性缺口 |
| AI-P3-1 | `orchestrate/chat/state.ts:69` 历史 LRU 逐出在途书 | >8 本并发对话才触发，收尾自愈重插 | 注释留账的有意取舍 |

### 3.3 进程级残留（备案在案，2 处）

- **DSK-P3-1** mac/linux 字体枚举超时只 reject 不杀子进程——熔断（阈值 2）封顶每会话 ≤2 个孤儿；PM-12 生产 kill 接线待拍板（台账 §三 在挂）。
- **DSK-P3-3** uncaughtException 后 200ms 硬窗退出，win 上 utility child 可成孤儿持端口——kill 信号已同步发出为主要防线，R44-17 备案。

### 3.4 各域生命周期盘点（干净面记录）

- **桌面壳**：三窗模块级引用 closed 置 null（带「仍指向本窗才置」守卫）；trustedSenders 白名单与窗口生命周期严格同步（上限恒三窗）；29 处定时器全量核对句柄留存 + 三路径清理 + unref（唯 DSK-P3-6 裸排）；server-manager kill 纪律完整（TERM→KILL 升级/pid 复用防护/停机三面取消挂起重启）。**正常会话主进程侧零可测泄漏。**
- **前端状态层**：全库唯一 EventSource 创建点单实例复用 + 代数自增断连；apiJson 统一 AbortController + 超时档位；docs LRU=20 / chat 消息 200 / workbench log 500 / toast 5 全部显式上界；inflight 表 finally 身份删除无键空间膨胀；按书残留系统性清理（setBook 清 docs/inflight/镜像/timer）。
- **前端组件层**：24 处组件级资源创建点（监听 17 组 / interval 3 / 防抖 5 / rAF 2 / EditorView 1）23 处严格配对（含 capture 标志、keep-alive deactivate 路径、destroy 钩子）；CodeMirror EditorView 卸载即 destroy + 置 null，文档切换全量替换不叠加 State；渲染面全量封顶（RENDER_CAP/CHIP_CAP/分页）。
- **服务端**：SSE 注册表每连接 close 回调同步摘除 + 心跳 clear + 背压双闸判死 + 每书上限 5；一次性票库 TTL 60s + FIFO 256；书键 TTL 缓存族 14 个全部 FIFO 32 + forget 挂点；事件库引用计数单例全异常路径配对；静态资源流 close 即 destroy。
- **AI 链路**：9 处 addEventListener 全配对、12 处 setTimeout 全 clearTimeout；Map/Set 族（running/settling/writeChains/pendingChats LRU 10/histories 族 LRU 8/registry LRU 8/pricing memo 32）finally 删除 + 身份校验；abort 三层传导（外/内 ctrl 分离 + forwardAbort + per-attempt）；域内零 spawn。
- **核心域**：openStores 引用计数在全部异常路径核verified配对；chapterCache FIFO 2048 / cardCache 64 / skillFileCache 256 / 日志队列 1024；按书键控 Map 均有 forget 钩子；worker 120s 超时 + settle-once + terminate。
- **文档数据域**：原子写 tmp+fsync 全覆盖 + sweepAbandonedTmpFiles 兜底崩溃残留；git 子进程超时 + kill 升级 + 缓冲上限；模块级缓存 11 个全部有界（mdTextCache 4096 条 + 64MB 双闸主导，稳态总驻留估算上限约 70–90MB）；大书治理专项成效明确（ngram 数值哈希、导出流式化）。
- **RAG**：召回侧流式打分 O(产出元组)（10 万块档 ≈4MB）；建索引峰值 ~215MB（200 万字整书单事务锁窗的刻意权衡，上界为书规模所囿）——条件性重负载，非泄露。

**专项总评**：以「窗口常驻数日 + 反复挂卸面板弹窗 + 长会话 AI 流式 + 常驻服务进程」为口径，除 §3.1 一处外**不存在必然性无界增长路径**；有界残留合计数百 KB 量级以下。内存卫生在同类规模代码库中属显著高于平均的水平（缓冲上限全部显式常量并附取舍注释）。

## 四、P2 发现（6 条，主审 6/6 亲验成立）

### P2-1 桌面壳：在途 close-flush 链对后至的 session-end 不设防，OS 关机窗弹同步确认框钉死进程

`src/desktop/main.ts:1206-1264`（close 链 IIFE）× `main.ts:1270-1310`（session-end 处理器）。

```ts
// close 链 IIFE：flush 落定后无 sessionEnding/appTearingDown 复查——
const res = raced === FLUSH_BUDGET_TIMEOUT ? null : raced
if (res && res.conflict.length > 0 && !win.isDestroyed()) {
  if (!confirmDiscardConflicts(win, res.conflict.length)) {  // showMessageBoxSync
```

触发路径：用户点主窗红叉 → close 拦截起链、flush 在途（≤CLOSE_FLUSH_BUDGET_MS）→ 窗口内恰逢 OS 关机/注销触发 `session-end`（置 `sessionEnding`、并行下发停机）→ close 链 flush 落定且 conflict/failed 非空 → 同步确认框在 OS 会话收尾的有限窗口内弹出。防线缺口：`sessionEnding` 直关放行只加在新到 close 上（:1195），before-quit 早退只约束 quit 链（:1941 区段），session-end 处理器只约束自己发起的 flush（R53-A-1「只留痕不弹窗」）——**已起链的 close flush IIFE 全程无复查**。后果：Windows 关机被应用阻塞直至会话管理器强杀（数据面 flush 已完成，损失停机时序非保存内容）。session-end 处理器注释自认「原生确认框会反把进程钉死在收尾期」——同一认知未回灌到 close 链。〔亲验：机制代码逐行核实；竞窗窄（关窗与关机几乎同时）。修复形态：IIFE 落定后复查 `sessionEnding || appTearingDown` 则跳过确认直走 destroy。〕

### P2-2 前端状态层：review store 跨文档切换不清 `collected`，前文档三审意见串显到后文档

`src/studio/web-next/src/stores/review.ts:53-70` × `components/panels/ReviewPanel.vue:34-41`。

```ts
async function loadEnvelope(name: string, docId: string): Promise<void> {
  ...
  lastDocId.value = env ? docId : null
  if (env && !collected.value) {                    // ← 入口从不清 collected
    collected.value = env.envelope.payload.collected
```
```ts
// ReviewPanel watch：两个可审阅文档 A→B 直调 loadEnvelope，不经过 clear()
watch([docId, node], async ([id]) => {
  if (id && isReviewable.value) await review.loadEnvelope(props.bookName, id)
  else review.clear()
})
```

触发路径：文档 A（有采集结果）→ 切文档 B：B 有信封时 `!collected.value` 为假（还留着 A 的）→ 跳过回填；B 无信封时 `env` 为 null → 同样保留 A 的。面板的 blockers/warnings/passed/incompleteReason 全部直接派生 `review.collected`，全文件无任何 lastDocId 校验。后果：verdict 徽章显示 B 的最新结论而意见列表显示 A 的三审内容——作者可能对着 A 的意见对 B 执行通过/驳回决断（裁决 API 参数正确，纯显示面串扰，但误导实义）。防线缺口：同构的 check store 由 CheckPanel 调用方 `watch(docId, () => check.clear())` 补齐了契约，review 的调用方没有——「面板 store 按文档绑定」契约靠注释而非入口强制，review 侧暴露。〔亲验：store 不清、面板不 clear、模板无守卫三点逐行核实。修复形态：loadEnvelope 首行按 docId 变化复位 collected。〕

### P2-3 前端状态层：useFocusTrap activeTraps 无界增长 + 注释漂移（= §3.1，此处不重复）

机制/量级/修复形态见 §3.1。〔亲验：push/onCleanup 代码逐行核实；注释宣称「体量≤浮层数」与实现矛盾。〕

### P2-4 服务端：文档写路径缺「书注册重验」+ 伏笔串行链不在删书/改名 drain 清单——在途写可落旧路径成孤儿文件

`src/studio/server/api/documents.ts:149-156,186-199`；对照兄弟路径 `files.ts:150-158`（BOOK_MOVED 重验）与 `files.ts:202-212`（链尾自清理）；漏接点 `books.ts:398-402`（删书 drain）/ `books.ts:634-638`（改名 drain）。

```ts
// documents.ts 写单元：无任何书存在性重验，直接写 handler 开头捕获的 r.bookRoot
const runSave = async (): Promise<SaveOutcome> => {
  const fsPrev = foreshadowSnapshot(r.bookRoot, path, docId)
  const o = await svc.save(docId, path, input)
```
```ts
// books.ts 删书 drain 清单：drainDocumentSaves + drainFilePutChainsUnder，无伏笔链
await drainDocumentSaves(join(ctx.workDir, entry.path))
await drainFilePutChainsUnder(join(ctx.workDir, entry.path))
```

触发路径：PUT /documents/:docId/content 的 handler 开头 resolveBook 捕获 bookRoot，随后 readJson（30s 闲置超时内任意长）与伏笔链排队均可跨过改名/删书的 drain 时点；伏笔域保存（`设定/伏笔/` 前缀）挂在 foreshadowSaveChains 上，而已入队未启动的单元对 drain 不可见（documents.ts:148 注释自认「四处本就不入该计数」）。后果：改名场景写旧书路径残留孤儿文件（旧路径无 book.yaml，repairBooks 不认领）；删书场景写进墓地目录与后台 rm 竞态可成永久孤儿。防线缺口：files.ts 对同型窗口建了双防线（R69-25 前缀 drain + R70-6 临界段重验），documents.ts 两道皆缺——「兄弟路径修复不同步」典型。〔亲验：无重验（grep 为空）、drain 清单缺项、单元体直写捕获路径三面核实；触发窗口窄（需与改名/删书并发）。〕

### P2-5 AI 链路：批量暂停记录的 detached 落盘未入后台任务表——settling 收口后可在删书/改名后重建目录

`src/ai/orchestrate/self-heal.ts:342-349`（recordPause fire-and-forget）；对照 `:700-706`（M-2：leadDraft 已登记 registerBackgroundTask）。

```ts
const recordPause = (atChapter: number, reason: string, detail: string): void => {
  void writeBatchPause(opts.bookRoot, { atChapter, reason, detail }).catch((e) => { ... })
}
// 对照（:706）：M-2 已把同族 detached 写登记进 per-book 后台表——
registerBackgroundTask(opts.bookName, logLeadDraftFailure(generateLeadUpdateDraft(...)))
```

触发路径：批量连写中止（aborted/failed/escalate）时 recordPause fire-and-forget；writeBatchPause 内部先抢跨进程锁（竞争下最长 2000ms）再 mkdirSync recursive + 原子写。waitSelfHealSettled 只等 settling Promise，不等这条 detached 写——批停 → 锁竞争使写在途 → 调用方在 settling 返回后立即删书/改名 → mkdirSync 重建已删书的孤儿目录（或写进改名后的旧路径）。防线缺口：M-2 修复明示设计契约「后台写须登记进 settle 等待面」，暂停记录是漏网的同类 detached 写。〔亲验：fire-and-forget 代码与 M-2 对照注释核实；机制确定，真实频率低（需锁竞争 + 立即删/改名叠加）。〕

### P2-6 核心域：章号提取双源未收敛——volumeChainState 仍持窄正则，宽容命名的定稿章被卷摘要链静默遗漏

`src/process/summary.ts:440-445`（单源，R1010 修复）× `:518-524`（同文件另一处旧源）。

```ts
// :440-442——同日早轮修复批已升格单源：
// R1010-P3：窄正则升格 chapterNoFromName 单源（与 tree 排序同宽容集…）
const 章号 = chapterNoFromName(name)
// :522——volumeChainState 仍持窄正则：
const m = /^(\d+)-/.exec(e.path.split('/').pop() ?? '')
```

触发路径：`chapterNoFromName`（`/^(\d+)(?:[-—]|\s|$)/`）接受连字符/破折号/空格/裸数字四种章号形态；定稿章文件名为 `1—开局.md`、`1 开局.md`、`1.md` 时：自愈摘要生成（:442）识别该章，卷链完整性检查（:522）不识别 → finalizedChapters 不含该章 → 该章摘要被**静默**排除出卷摘要输入（既不进 chain 也不进 missing，无任何告警）。防线缺口：missing 通道只对「已识别定稿但摘要缺失」报缺，识别本身漏掉时无告警；R1010 修复批宣称「单源/同批收敛」而同文件双源并存——修复宣称与代码现状直接矛盾。〔亲验：两处正则与注释逐一核实。〕

## 五、P3 清单（26 条，按域）

**桌面壳（7）**：①字体枚举孤儿进程（熔断封顶 ≤2/会话，PM-12 待拍板）②doRestart 覆写 starting 通道不做在途检查（窄竞态，作者单向设防已知）③uncaughtException 200ms 窗 utility child 孤儿（R44-17 备案）④isTrustedSender 拒绝路径静默返回 undefined 与 preload 类型契约不符 ⑤isTrustedSender 兜底分支信任本进程任意 BrowserWindow（宽于白名单语义，纯前向防御缺口）⑥context-menu 取消补发 100ms timer 裸排（§3.2）⑦server-main 重复信号重复排 2s 退出兜底 timer（§3.2）。

**前端状态层（3）**：①workbench droppedTypesWarned Set 只增（§3.2，界≈类型字符串数）②check 误报灰显 localStorage 键在文档改名路径孤儿化（盘上残留，同路径复用 legacy id 才有感）③prefs 迁移循环变量命名 `ref` 遮蔽 Vue `ref` 导入（维护陷阱）。

**前端组件层（2）**：①FontPicker typeahead timer 卸载未清（§3.2，800ms 自清）②若干低敏异步动作 await 后写已卸载实例 ref（无外部副作用，纪律不一致备忘）。

**服务端（1）**：①foreshadowSaveChains 无链尾自清理 + 不在 forgetBookKeyedCaches（§3.2，与 P2-4 同根）。

**AI 链路（3）**：①chat 历史 LRU 逐出在途书（§3.2，注释留账取舍）②waitConfirm 对重复 tool_use id 的覆盖（模型退化边界，超时兜底，无资源泄漏）③chat 超时文案硬绑缺省 30min 而 deadlineMs 可注入（注释自认口径差）。

**核心域（2）**：①rebuild 只读探测 PRAGMA 异常路径句柄泄漏窗口（§3.2，R65-22 同类未同步）②execRing 会话级单环不支持并发 owner（chat×self-heal 并发时回放丢段/断流，诊断质量面）。

**文档数据域（5）**：①md 文本缓存 stat→read 间隙指纹-文本错配（ns 级碰撞才持续，自愈型）②跨进程锁续期 timer 丢失 release 空转（§3.2，当前无违约调用方）③style 条目序号解析固定 3 位，≥1000 时场景名错位（O_EXCL 重试自愈但编号割裂）④stringifyPieceList 无尾换行（生产零接线，浏览器端 MetaFormPanel 经它生成会落偏差文本）⑤候选箱「标签」标量形态静默丢弃（同族三处修复的漏网点）。

**校验+RAG+工具链（3）**：①字节长度损坏的 RAG 向量行计为「维度不匹配」而非毒行——占 produced 名额且永不触发毒行告警（需外部损坏才可达，结果面 fail-closed）②双包宇宙版本偏斜（根 typescript ~5.5 vs web-next ^5.6，靠 vitest alias 人工钉同步，升级期风险）③check-counts 的 .skip/.only 门禁是正则模式枚举，新跳过 API 形态需人工补模式。

## 六、域质量观察汇总（八域精选）

1. **防御密度成体系且持续受维护**：代守卫（bookGen/opGen/reqGen/connectGen 族）贯穿全部异步路径；编号修复锚点（R/PM/Z 系）与代码现状抽查基本零漂移（本轮实锤漂移仅 P2-3 注释与 P2-6 修复宣称两处）；停机状态机（close/quit/session-end 三链互斥 + 七旗）、五闸编排互斥矩阵、跨进程锁（stale 复核 + 活 pid 超龄 + 释放前逐字节校验）均为反复评审迭代出的成熟形态。
2. **「兄弟路径修复不同步」是本轮最主要的系统性风险模式**：4/6 条 P2 同族（files↔documents、leadDraft↔recordPause、summary 单源收敛漏一处、session-end 认知未回灌 close 链）——单点修复时未做同型扫描。建议后续修复批固定加「同型路径扫描」步骤。
3. **错误面契约化纪律好**：三态/结构化错误信封贯穿（{ok:false} 信封逐分支收编、拒写不裸抛、降级黄化不丢弃）；「宁可红不可错」口径全库一致。
4. **缓存统一范式扎实**：(mtimeNs,size) bigint 指纹逐读复验 + FIFO/LRU 上限 + 写侧失效 + 书级 forget 挂点四件套在 11+ 缓存上模式一致，无野缓存。
5. **测试体系评估（抽样 8 文件 + helpers 4）**：断言质量高（checkId 检索不依赖数组序、正负对照成对、DB 行级断言）；flaky 治理成熟（waitFor 单源轮询、墙钟类 retry:2 + 本机×12 复校、playwright workers:1 有理由分工）；真双进程锁验证非 mock 自证；golden-master 语料门双向断言。弱点：web-next 聚合档 statements 43% 为全库最低覆盖闸。
6. **安全面分层清晰未见洞**：IPC 白名单 + 载荷预算、Host/Origin/token 三闸 + timingSafeEqual、路径穿越四处独立校验、密钥 0600 原子写 + redact 出口脱敏。

## 七、完成进度评估

| 口径 | 状态 |
|---|---|
| 实施路线（总览第三节） | 24 阶段 23 收口；阶段 24「章节结构操作」设计方案 + 执行方案已落盘（2026-09-04），**待作者开工指令**——唯一开放任务 |
| 功能面 | 八域逐文件读码未见 stub/TODO/半成品接线；早轮报告宣称的「0 处真实 TODO/FIXME」与本轮观察一致；生成物（catalog.gen.ts）有源头脚本 |
| 工程面 | 版本 1.0.0-rc.1；tsup 双入口 + vite 前端 + electron-builder 双平台；CI 三腿矩阵 + 覆盖率阈值门 + 发布冒烟；1010 单测文件 / 6548 用例 / 29 e2e spec 全绿（§二实跑复验） |
| 未提交面 | 工作树有 53 文件修复批未提交（早轮收口批），建议随下轮修复批一并提交 |

**结论：≈95%〔94–96%〕**——扣分项：阶段 24 未实施（≈4%）+ 本轮 6 条 P2 待修（打磨层，≈1%）。

## 八、完成质量评估

**评级：A-（维持）**。依据：

- **零 P1**：无数据丢失/崩溃/安全洞/必然无界泄露路径；数据安全主线（原子写 + 版本快照字节保真 + 保存协议锁内复核 + 拒写不裸抛）在本轮独立重读下再次确证。
- **6 条 P2 全部窄窗/小量级**：关机竞窗弹框（停机时序）/ 显示串扰（不落数据）/ 无界增长（数百 KB 级）/ 孤儿文件（需并发删改）/ 孤儿目录（需锁竞争叠加）/ 摘要静默遗漏（需宽容命名）——无一条触及红线。
- **内存专项**（本轮重点）：除 1 处小量级无界增长外全域干净，缓存/监听器/定时器/子进程/SSE 生命周期纪律体系化，量化稳态驻留有界。
- **工程纪律**：客观门九件套全绿（本工作树实测）；测试断言质量与 flaky 治理高于业界基线；注释-实现漂移率极低（本轮 8 域全量读码实锤 2 处）。
- **未扣至 A 的原因**：4/6 P2 同族（同型扫描机制缺位）+ A11y/卫生面仍有 26 条 P3 尾巴 + web-next 覆盖闸 43% 为最低档。

## 九、建议修复编排（待作者拍板后执行）

- **批 A 前端组**（FE-P2-2 + FE-P2-3 + FTC-P3-1 + FE-P3-3）：loadEnvelope 入口按 docId 复位 collected；activeTraps onCleanup 收缩（splice 或收缩式重排）；FontPicker 卸载清 typeTimer；prefs 迁移变量改名。回归：review 跨文档用例 + focus-trap 嵌套用例扩展。
- **批 B 服务端/编排组**（P2-4 + P2-5 + SRV-P3-1）：documents.ts 写单元加 BOOK_MOVED 同款重验；foreshadowSaveChains 进 drain 清单 + 链尾自清理 + forgetBookKeyedCaches 挂点；recordPause 登记 registerBackgroundTask。同型扫描：全服务端「handler 捕获 bookRoot 后 await 再写」路径复查一遍。
- **批 C 桌面壳/核心组**（P2-1 + P2-6 + DSK-P3-6/7 + CORE-P3-1）：close 链 IIFE 落定后复查 sessionEnding；summary.ts:522 窄正则换 chapterNoFromName（同型扫描：全仓 `/^(\d+)-/` 残留位）；卫生三件随手收。
- **P3 其余**：建议随批收同域触达项，备案类（PM-12 / P3-3 / execRing）维持登记。

## 十、收口记（2026-09-10 修复批同日办结）

作者指令「全部修复，编排下任务做。」——**P2×6 必修全修 + P3×17 随批收**（9 条维持登记，见下），锚点编号 `R1010b-*`。执行方式：**两波七路文件互斥并发代理**（波 1 桌面壳/前端状态层/服务端/AI 链路，波 2 核心+RAG/文档格式/前端组件；每波 ≤4 遵守派发上限）+ 主审逐 diff 复核（两波全部 R1010b 块逐一过目通过）。改动面 25 源文件 + 11 新增测试文件 + 既有测试适配。

**P2×6 落地**：①DSK-P2-1 close 链 flush 落定后补 `sessionEnding || appTearingDown` 复查（skipConfirms 跳过两个同步确认 + warn 留痕，三时序注释；main.test.ts 回归）②FE-P2-1 review store 归属键 `lastLoadKey`（`书::docId`）——loadEnvelope 跨文档先清 collected、run 成功推进键、clear 复位；6 用例回归（不串显/回填 B/run 豁免/setVerdict 链/跨书/clear 后）③FE-P2-2 useFocusTrap onCleanup 按 seq splice 摘除 + 注释漂移修正 + `__focusTrapActiveCountForTest` 探针（3 用例：N 轮归零/开着卸载/嵌套让渡不回归）④SRV-P2-1 面 A：documents.ts 五处链内写单元临界段首行补书注册重验（`bookMovedFailure` 单源 + structStatus 补 BOOK_MOVED→409，等价结构化出口信封一致）+ 面 B：`drainForeshadowSaveChains` 接入删书/改名两 drain 段（死锁核查在案）+ 同型扫描接线 words-diary.post；6 用例（假 req 悬持 body 确定性复现竞窗）⑤AI-P2-1 recordPause 收编 `registerBackgroundTask`（照 M-2 先例；红绿对照：撤修复跑恰红于 hasBackgroundTasks 断言）⑥CORE-P2-1 summary.ts:522 升格 chapterNoFromName 单源 + 全仓同型扫描干净（3 用例：`1—开局`/`1 开局` 进卷链）。

**P3×17 随批收**：DSK×4（doRestart 在途复用 / 工厂窗 WeakSet 收窄兜底〔测试侧 trustedEvent 锚适配 14 处跨实例借用〕/ context-menu timer 单槽句柄化 / server-main 信号兜底 timer 单发）/ FE×3（workbench Set 封顶 64 / 改名链补 clearFalsePositiveMarksForDoc / prefs 循环变量改名）/ FTC×2（FontPicker 卸载清 typeTimer / 三代表例 armed 门含 finally 复位，7 用例红绿验证）/ SRV×1（伏笔链尾身份校验自清理 + forgetBookKeyedCaches 挂点 + 测试钩子）/ AI×2（waitConfirm 重复 id 先收口旧项再登记〔消 timer 误删次生面〕/ 超时文案按实际 deadline 现算〔chat-exits 两断言随批更新〕）/ CORE×1（rebuild 探测 PRAGMA 异常 close，照 R65-22）/ DOC×3（序号 `(\d{3,})` 单源 parseSampleFileName / stringifyPieceList 尾换行 / 候选箱标量标签归一，8 用例）/ CHK×1（RAG 坏长度 BLOB 归毒行两处同款〔norm 两态都剔，超任务字面方向 fail-closed 一致〕，4 用例 UPDATE 直改 BLOB）。

**维持登记 9 条**（台账 §三 R1010b 行）：DSK-P3-1 字体枚举孤儿（= PM-12 待拍板）/ DSK-P3-3 uncaught 200ms 窗（R44-17 备案）/ DSK-P3-4 isTrustedSender undefined 类型契约（d.ts 全 widen 面大，单立）/ AI-P3-1 历史 LRU 逐出在途书（注释留账）/ CORE-P3-2 execRing 单环并发 owner（per-owner 环单立）/ DOC-P3-1 md 缓存指纹错配（ns 级自愈型）/ DOC-P3-2 锁续期 timer 空转（零违约调用方）/ CHK-P3-2 双包版本偏斜（workspace 化单立）/ CHK-P3-3 skip 门禁正则（AST 化单立）。

**批内新观察**（修复代理发现，同录台账 §三）：FE onSaveMeta/doMove 同族 fp 键孤儿 / SRV config.ts·prefs.ts 同型越界命中（下批同款收口）+ finalize 重验需动第三文件 + 单元首行重验后 rename 微任务残窗（files.ts R70-6 架构同源）/ CORE `1.md` 裸数字形态不在单源宽容集（R1010-P3 既定边界）/ DOC leads.ts:537 劈分语义备案 + piece-list-core 头注 MetaFormPanel import 宣言与现状不符（零 import，历史注释）/ DSK server-main 修复无测试装置（import 期副作用）。

**L2 终门九件套一轮全绿**（主审亲跑，2026-09-10）：tsc 0 错 + vue-tsc 0 错 + eslint 0/0 + **vitest 1021 文件 = 6594 过 + 4 跳 0 败**（145.36s）+ e2e 43 过 2 跳（28.5s，含 build:web 前置）+ check:counts 过（1021/6594 对账一致）+ check:packaging 过 + check:knowledge 过。根 README 修账 1010/6548→1021/6594 四处（新增用例均平台无关，win 口径 −75 恒定差不变待 CI 复验）。零提交（工作树待作者指令）。

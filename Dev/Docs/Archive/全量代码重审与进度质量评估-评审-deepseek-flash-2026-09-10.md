# 全量代码重审与进度质量评估-评审-deepseek-flash-2026-09-10

> 📦 **归档记（2026-09-13）**：已收口（收口记 = §十一），随作者指令「入库，如果已经完成，那就直接归档。」的游离件入库收编批自 `01-评审/` 移入 `Archive/`（扁平冷库）；头部此前无归档记故本批补记，历史正文不改写。

- 日期：2026-09-10
- 执行模型：**deepseek-flash**（主审）。子代理 8 路同模型分域并行（波 1：桌面壳 / Studio 服务端 / AI 链路 / 前端；波 2：持久化与状态 / 领域管线 / 跨模块生命周期接线核查 / 测试与 CI 工具链），主审逐条复核关键结论并亲跑终门。
- 评审基线：分支 `win`，HEAD `267e6864`（merge win←dev），工作树干净。
- 评审范围：`src/**` 全量（约 106,930 行 TS/Vue；`src/studio` 240 文件、`src/ai` 76 文件）+ `test/**`（1008 单测文件 / 29 e2e spec）+ `scripts/**` + `.github/workflows/**` + 构建配置（tsup / electron-builder / vitest / playwright / eslint）。
- 方法：文件互斥分域并行审查 + 主审逐条独立复核。关键结论均经独立复现（含真实 Electron 进程实验、定向重复跑、残留物取证），不采信注释自述。
- **作者指令**：本报告为「忽略现有评审文档」的**全新独立评审**，全文不引用、不继承任何既有评审结论；一切判断来自代码与实测。评审命名为新规（2026-09-09 起）首次适用，头部记执行模型。
- 状态：**已收口**（2026-09-10 修复批落地 + 回归全绿，收口记见 §十一）。按文档链，报告完成 ≠ 收口；残留登记随收口记落台账 §三。

---

## 一、结论摘要

**三句话结论：**

1. **进度**：功能面已完整落地并有大面积测试背书（README 描述的书库/设定/正文/机检/三审/定稿/防吃书/伏笔/文风/改写/对话助手/导出全链有实现），计划面只剩**阶段 24（章节结构操作）1 个阶段**待作者指令开工。软件处于 `1.0.0-rc.1`。
2. **质量**：**工程纪律显著高于同类规模项目**——本次专项目标「内存泄露」在 8 个分域里几乎全部清查为「干净且是刻意设计」（SSE 句柄生命周期、事件库引用计数、文件锁、Worker 回收、启动退出链、前端监听器配对均经独立复验成立）。但存在 **1 个必修 P1**：**主进程窗口关闭即崩溃**（`main.ts:760`），且它是 **2026-09-09 那个修复批自己引入的回归**——正好落在全套测试与 CI 都覆盖不到的位置。
3. **结论口径**：**发布就绪度为「未达」**。不是工程质量差，而是「最后一改引入了一个必现崩溃，而现有验证体系结构性地抓不到它」。修掉 P1 + 补上 Electron 运行时冒烟门即可回到可发布态。

**数字一览（本次亲跑实测，win 平台）：**

| 门 | 实测 | 结论 |
|---|---|---|
| `vitest run` | 1000 文件过 + 8 跳（共 1008）；**6450 用例过 + 79 跳**（共 6529）；298.42s | ✅ 绿 |
| `tsc --noEmit` | 0 错 | ✅ 绿 |
| `eslint .` | 0 问题 | ✅ 绿 |
| `check:counts` | 通过（1008 文件 / 6450 单测 / 29 spec / 45 用例） | ✅ 绿 |
| `playwright test`（e2e） | **42 过 + 2 跳 + 1 失败**（52.3s） | ❌ **红** |

> 与 README 声称的「e2e 43 过 2 跳」不符：win 上当前实跑为 42 过 + 1 败。失败项 `test/e2e/ai-degrade.spec.ts` 独立复跑 3 次 = 过、过、**败**（偶发，约 1/3）。

---

## 二、完成进度评估

进度分三个轴看，不合成单一百分比（三个轴的证据强度不同）：

### 2.1 功能面：完整落地

README「写一本书的流程」五步 + 配套能力，逐项在代码中确认有实现与测试：

| 能力 | 落点 | 测试面 |
|---|---|---|
| 建书/书库管理 | `src/install/books.ts`、`studio/server/api/books.ts` | `test/install` 29 文件 / 171 用例 |
| 设定（大纲/角色/世界观/物品） | `src/format/**`、`src/document/**` | `test/format` 62 / 499、`test/document` 90 / 569 |
| 正文 AI 起草 + 机检 + 自动重写 | `src/process/draft-pipeline.ts`、`src/check/**`、`src/ai/orchestrate/self-heal.ts` | `test/process` 44 / 304、`test/check` 48 / 346、`test/ai` 121 / 942 |
| 三审（读者/编辑/设定视角） | `src/review/**`、`studio/server/api/review.ts` | 含 e2e 动线 |
| 定稿 + 防吃书检查 | `src/document/version.ts`、`src/state/**` | `test/state` 18 / 68 |
| 伏笔追踪 / 字数曲线 / 文风系统 / 改写 / 对话助手 / 导出 | `document/foreshadow.ts`、`metrics/**`、`ai/tools/**`、`export/**` | 各域专测齐备 |

**判断：功能面 ≈ 完成。** 这是「代码已实现且被测试覆盖」，不等于「产品在 200 万字量级下验证过可用」——后者无任何实测背书（见 6.2 T-2）。

### 2.2 计划面：仅剩 1 个阶段

`Dev/Main/00-总览与实施路线` 第三节「开放任务」当前**只有一行**：阶段 24 章节结构操作（留洞制 fm `序`/`并入`、合并/拆分/回收站），状态为「执行方案已落盘（2026-09-04），实施待作者指令」。第五节决策状态表记「真开放待拍板：无」。

**判断：计划完成度 ≈ 95%**（唯一开放项未开工，且属体验增强类，非核心链路）。

### 2.3 发布面：未达

- 打包链齐备（nsis / dmg）、产物门与启动冒烟在 tag 流程中有（`desktop.yml`）。
- 但：**P1 必现崩溃**（§五 W-1）+ **win 平台 e2e 当前红**（§五 W-3）+ **PR/push CI 完全不跑 Electron**（§六 T-1）。
- README 中「长篇写到两百万字量级还不崩」是设计目标声明，**仓库无任何 soak/内存门**验证它（§六 T-2）。

**判断：发布就绪度未达。** 建议按 §八 顺序处置后再判 RC。

---

## 三、完成质量评估

### 3.1 强项（经独立复核确认，非注释自述）

1. **资源生命周期纪律是「刻意设计」而非「恰好没炸」。** 本次专项核查的每一类资源都有明确归宿：
   - 事件库 SQLite **引用计数**（`events/store.ts:483-492, 1047-1072`）：归零才关库、先清 marker 计时器再 `db.close()` 且 try/catch、`close()` 幂等；13 个 `openSessionStoreAsync` 调用点全部 `finally { close() }`，失败首开自行关闭且不入登记表（`store.ts:707-724`）。
   - **SSE 句柄表**（`server/api/stream.ts:53-75`）用 Set-of-handles 而非裸计数（规避「计数漂移到 0 绕过上限」经典缺陷），`forgetSseCount` 先清表再销毁句柄使迟到的 close 回调成幂等空操作；心跳与卡死看门狗计时器 `.unref()` 且在各出口清除。
   - **文件锁**（`fs/cross-process-lock.ts`）：fd 在 `finally` 关闭、续租计时器在释放与续租失败两路都清、`.unref()`。
   - **Worker**（`cache/run-rebuild-async.ts`、`export/run-async.ts`、`server/api/style-scan-async.ts`）：单次 settle 保证 `clearTimeout` + `terminate()`。
   - **前端监听器**：主审独立跑了全树 add/remove 配对审计（466 文件），**仅 2 个文件不对称**——`useShelf.ts`（2/0，模块级页生命周期单例，刻意）与 `fullscreen.ts`（2/1，`typeof document.addEventListener` 字符串误报）；`setInterval` 7 处全部有对应 `clearInterval`。与子代理结论一致。
2. **模块级缓存几乎全部「有上限 + 有失效钩子」双保险。** 约 120 个模块级 Map/Set 逐一清点：book 键缓存全部 FIFO/LRU 封顶且有 `forget*Cache` 钩子，并统一由 `forgetBookKeyedCaches(bookRoot)`（`server/api/books.ts:92-125`）扇出，在删书（`books.ts:477`）与改名（`books.ts:712`）两路调用；写完即删的链式 Map（`writeChains`/`filePutChains`/`leadUpdateChains`）在 settle 后自删。
3. **安全纵深成体系**：IPC 白名单 + 顶层主帧判据 + `BrowserWindow.fromWebContents` 反查兜底；Host 精确匹配、Origin 白名单、会话令牌闸；`readJson` 1MB 上限 + 空闲超时；错误信封统一 `replyError` 并集中脱敏密钥。
4. **前端异步竞态防护是「房屋风格」**：`bookGen`/`reqGen`/`connectGen`/`compReqId` 等世代守卫在 stores 与视图里一致铺开，跨书串态被系统性拦截。

### 3.2 弱项（结构性的，不是个别疏忽）

1. **验证体系与「桌面应用」这个交付形态错位。** 单测把 `electron` 整体 mock 掉（12 处），e2e 从不启动 Electron（`test/e2e/**` 全文无 `electron` 引用，跑的是「真实 studio server + 真实 Chromium + mock driver」）。真正的桌面运行时（BrowserWindow 生命周期 / preload / IPC / server-manager 拉起）**在 PR/push 上零集成覆盖**，只在 tag 打包时有一个 25s 存活冒烟。**本轮 P1 正是这一类缺陷。**
2. **覆盖率门存在「形同虚设」的桶。** `vitest.config.ts` 的 web-next 聚合桶 `lines: 43 / branches: 81`，而实测约 90/90——意味着 `composables/**`（`useChapterTreeActions` 72.3%、`useRelationGraph` 73.5%、`useShelf` 79.3%）回退近一半都触发不了门。另有 0% 覆盖的入口/Worker 文件（`desktop/server-main.ts`、`cache/rebuild-worker.ts`、`export/export-worker.ts`、`server/api/analysis-worker.ts`）被 91% 的主桶均值稀释。
3. **平台偏斜发生在「出货平台」上。** win 腿少跑 ~74 个用例（`skipIf(win32)`），且这些用例恰好集中在 symlink / realpath / EACCES / 非法文件名 / 大小写折叠——Windows 自身的风险面；同时 `check-counts.mjs` 在 win 腿**主动跳过单测数核对**，README 的 6525 从未在 Windows 上被验证过。
4. **e2e 稳健性靠「冻结执行顺序」而非隔离。** 29 个 spec 中 22 个共享同一临时 workDir 与 server，spec 间靠前序写盘供后续消费，`retries: 0`；顺序由快照门锁死。单次串扰即硬红无重试。
5. **CI 触发面不含当前开发分支。** `ci.yml` 仅 `push: [main]` + `pull_request: [main]` + 手动；当前工作分支 `win`（及 `dev`）推送不触发任何 CI。
6. **文档—代码存在少量失真。** 例：`src/document/tree.ts:239` 的 `clearProbeCache` 注释宣称被 `invalidateTreeIndex` 调用，实际没有；4 个 `clear*/forget*` 导出零生产调用点。本项目把注释当契约用，这类失真值得当成缺陷处理。

---

## 四、内存泄露专项（本次核心）

### 4.1 分域清查结论

| 分域 | 机制 | 结论 |
|---|---|---|
| 桌面壳（Electron 主进程） | IPC/app/session 监听器、窗口表、utilityProcess、退避计时器、stdout 缓冲 | ⚠️ **1×P1**（W-1）+ 4 项 P3。其余干净：`registerIpc()` 单次注册且 `bootstrap()` 不重入；子进程 `active`/`starting` 在各 `finally` 清；stdout 切行有 1MB 强截断；退避计时器 `unref` + 取消在停机路 |
| Studio 服务端 | SSE 注册表、心跳/看门狗、请求体、缓存、任务闸、Worker、sqlite | ✅ **无 P1**。SSE 注册表经复验「干净」；~25 个 book 键缓存全部 TTL+FIFO+forget 钩子；每个 `openSessionStoreAsync`/`openRagDb` 调用点 `try/finally` 闭合；请求体 1MB 上限 |
| AI 链路 | 历史数组、AbortController、流读取、重试/自愈循环、看门狗、会话 Map | ✅ **无 P1**。历史 LRU 8 / 上限 10 轮 / agent 5 轮；每个长活信号监听器都有对应移除（2 处 `{once:true}` + 显式移除）；重试上界 3、自愈受 `maxAttempts` 约束且替换而非追加；看门狗计时器全路径清除 |
| 前端（Vue/Pinia/CM6） | 监听器、watcher、计时器、EditorView、EventSource、store 缓存 | ✅ **无 P1/P2**。`CmHost.vue` `onUnmounted` 销毁视图；`useSse.ts` `disconnect()` 关流清退避；doc LRU 20 / messages 200 / workbench log 500；主审独立配对审计仅 2 处不对称（均刻意/误报） |
| 持久化与状态 | 事件库引用计数、RAG 开闭、缓存失效、锁、临时文件、Worker | ⚠️ **1×P2**（W-2）+ P3。事件库引用计数与 RAG 开闭经复验「干净」 |
| 领域管线 | 批处理累积、正则 `/g` 状态、Worker、spill 文件 | ⚠️ 2×P3（L-1/L-2）。**`/g` 正则状态性缺陷经全量枚举确认「零命中」**（所有 `g` 标志模块正则均只走 `match`/`replace`，无 `.test()`/`.exec()` 状态污染） |
| 跨模块接线 | forget/清钩子调用点、spill GC、事件库/RAG 引用计数、模块级注册表、启停链 | ⚠️ 发现 `foreshadowSaveChains` 无失效钩子（W-4）、spill 无生命周期 GC（L-3）、停机不等待在飞 Worker（W-3 根因） |

**结论：内存泄露面整体健康，未发现「正常使用下持续线性增长」的泄漏路径。** 唯一 P1 是崩溃而非泄漏；`trustedSenders` 的 Set 条目确实永不释放，但因崩溃先发生，实际表现为崩溃而非增长。

### 4.2 独立复现证据（主审亲验）

**P1 复现（真实 Electron 42.5.0 进程，最小复现脚本，`show:false` 不扰屏）：**

```
用 src/desktop/main.ts:760 的原样形态（无 try/catch）：
  win.on('closed', () => { void readWC(win) })   // trackWindow
  win.on('closed', () => { /* 后续清理 */ })
结果：RESULT=["!! uncaughtException: Object has been destroyed"]
     → 后续监听器一条都没跑；uncaughtException 触发
对照组（L1 不读 webContents）：RESULT=["L1 ran","L2 ran"]  → 说明确是抛出所致
```

**e2e 红的残留物取证（证明是句柄未释放，不是测试写错）：**

```
失败 run 的 workDir 残留（rmSync 已尽力删，剩下的就是被占用的）：
  .../clwriting-dual-aoWKBV/长篇/长篇测试书/.cache/index.db
→ server.close() 返回后，仍有 .cache/index.db 的句柄未释放（win 下目录删不掉）
```

---

## 五、缺陷清单

严重度定义：**P1** = 正常使用下必现崩溃/数据丢失/真实泄露；**P2** = 真实缺陷、影响受限或需特定条件；**P3** = 卫生与性能。

### P1（必修，发布阻断）

| id | 位置 | 标题 | 失败场景（复现路径） | 最小修复 |
|---|---|---|---|---|
| **W-1** | `src/desktop/main.ts:760`（`trackWindow`） | **窗口关闭即整进程崩溃**——`closed` 处理器读已销毁窗口的 `win.webContents` | `win.on('closed', () => trustedSenders.delete(win.webContents))`。窗口销毁后取 `webContents` 抛 `Object has been destroyed`。因该监听器是 `createSecureWindow` 里**第一个**注册的 `closed` 监听器（`main.ts:832` 先于 `attachRendererCrashSelfHeal` 的 834 与调用方各自的 `on('closed')`），抛出后 Electron 中止本次 emit：<br>（a）**后续所有 `closed` 清理全部被跳过**：崩溃自愈的 `stabilityTimer`/`failLoadTimer` 撤销（`main.ts:195-204`）、`shelfWindow`/`libraryWindow` 置空（`886`/`936`）、`mainWindow = null; app.quit()`（`1309`）；<br>（b）抛出经 `uncaughtException`（`main.ts:1858`）→ **`process.exit(1)`**，且 `stopChild()` 是 fire-and-forget 不等待 → 优雅停机（会话 flush / 事件落库）被跳过。<br>**触发路径（全部正常操作）**：打开「书库」或「书架」窗口后关闭它；或**切回主窗口**——`mainWindow.on('focus')` 会 `libraryWindow.close()`（`main.ts:1305`）。 | `const wc = win.webContents; trustedSenders.add(wc); win.on('closed', () => trustedSenders.delete(wc))`——销毁前捕获引用（与 `shelfWindow` 处 R48-16「先捕获局部引用」的既有做法同款）。<br>建议同批加固：① 各 `closed` 清理处理器各自 `try/catch`，避免单点抛出连坐；② `uncaughtException` 不应对「监听器抛出的清理型异常」直接 `process.exit(1)`，至少不应抢占优雅停机链。 |

> **回归来源**：`trackWindow` 出自 2026-09-09 修复批的 R4-P2-1（IPC 白名单，安全纵深）。属**修复批自引入回归**。
> **为何全绿还漏**：`test/desktop/main.test.ts` 的 `FakeWin`/`FakeWebContents` 用普通属性承载 `webContents`（`main.test.ts:128`），永不抛 `Object has been destroyed`；`main.test.ts:144` 照常调用 `closed` 处理器因而「通过」。e2e 不启动 Electron。CI 无 Electron 集成。

### P2（应修）

| id | 位置 | 标题 | 失败场景 | 最小修复 |
|---|---|---|---|---|
| **W-2** | `src/cache/rebuild.ts:248-256` | 增量探测分支只读 `DatabaseSync` 泄漏句柄 | `new DatabaseSync(cachePath,{readOnly:true})` 成功后 `db.exec('PRAGMA busy_timeout = 5000')` 抛错（index.db 损坏/被锁）→ `catch { return null }` **未 `db.close()`**。全量 `rebuild()` 分支有同款 R65-22 修复（`:426`），增量分支漏了——典型「非对称修复」。win 下泄漏的句柄会让「删掉 `.cache/index.db` 重试」这一文档化自愈路径 EBUSY/EPERM 失败。 | 照抄 R65-22：`catch (e) { try { db.close() } catch {} ; return null }` |
| **W-3** | `src/studio/server/index.ts:491-493`、`src/desktop/graceful-shutdown.ts` | 停机不释放 per-book 库句柄 / 不等待在飞 Worker；`server.close()` 不自足 | `server.on('close')` 只重置 `initialBook`，不关 SSE、不关在飞的重建/导出 Worker。**实测后果**：e2e `ai-degrade` 的 `afterAll` 在 `server.close()` 后用 `rmSync(workDir)` 失败 `ENOTEMPTY`，残留取证为 `.cache/index.db`（3 次独立复跑 1 败）。对产品：退出时在飞 Worker 被 `process.exit(0)` 拦腰截断，可能在原子写中途留下 `.tmp`。 | 导出 `closeAllSseConnections()` 并在 `server.on('close')` 调用；停机链内在预算内 `await` 在飞 Worker 与 DocumentService 保存队列 |
| **A-1** | `src/ai/orchestrate/chat/turns.ts:331` | `read_skill` 把整包内容无上限塞进模型历史 | 该 case 直接 `return { ok:true, summary: skill.content }`，而同函数 `read_chapter` 有 `READ_CHAPTER_MAX_CHARS = 20_000`（`:82`）。大技巧包 × 5 轮 agent 循环 → 每轮重发全史，上下文/成本膨胀，且可能触发 `CONTEXT_WINDOW_EXCEEDED` 重试循环。 | 照 `read_chapter` 口径 `clipByCodePoints(skill.content, N)` + 截断提示 |
| **L-2** | `src/ai/llm-call-read.ts:67`（消费方 `cost-stats.ts` / `trace-stats.ts`） | 成本/轨迹统计把整条 `llm/call` 事件流读进内存 | `listEvents` 返回全量过滤结果（`events/store.ts:900,915` 物化整表到 `out[]`），重度使用的书（十万级调用）刷新一次指标即构建大数组 + 每任务分组数组。 | SQL 层加时间窗/上限参数，或改异步迭代流式聚合 |
| **T-1** | `.github/workflows/ci.yml:141-186`；`desktop.yml:4-8` | PR/push CI 零 Electron 集成测试 | 出货形态是 Electron 桌面应用，但 PR 门只跑 web 包 + 源码 server；Electron 唯一自动化是 tag 打包时的 25s 存活冒烟（且 mac 腿）。**W-1 正是该类缺陷**，机制上无法被现有门发现。 | 加 headless Electron 启动冒烟 spec（ubuntu 用 `xvfb-run`）接进 `e2e` job |
| **T-2** | 全仓库 | 「两百万字不崩」无任何内存/长跑门 | grep `memoryUsage|heapUsed|max-old-space` 于 workflows = 0 命中；无 soak 用例。稳定性主张无测试背书。 | 加 1 个 soak 用例（N 章生成后断言 `heapUsed` 增长上界，配 `global.gc`）+ CI 步骤 |
| **T-3** | `vitest.config.ts:133` | web-next 聚合覆盖桶阈值形同虚设 | `lines: 43 / branches: 81` 对比实测 ~90/90；`composables/**`（最低覆盖区）回退近半不触门。 | 为 `src/studio/web-next/src/composables/**` 单列桶（实测 −2pp），或把聚合桶提到实测 −2pp |
| **T-4** | `test/e2e/global-setup.ts:22`、`test/e2e/spec-order.guard.test.ts` | 22/29 e2e spec 共享可变 on-disk 状态 | spec 间靠写盘传递状态，`retries: 0`；一次串扰即硬红且无法自愈。 | 每 spec 独立 `makeDualTrackWorkdir`（现成参数化），或 spec 间重置 workDir |
| **T-5** | 47 个文件 `skipIf(win32)`；`scripts/check-counts.mjs:446-449` | 出货平台少跑 ~74 用例，且不核单测数 | win 腿跳过的正是 symlink/EACCES/非法名/大小写折叠用例；`check-counts` 在 win 腿主动跳过单测数核对，README 的 6525 在 Windows 上从未被验。 | 把平台无关子集用 mock fs 错误改写为跨平台用例；至少在一个非 linux 腿核对单测数 |
| **T-6** | `.github/workflows/ci.yml:11-15` | 当前开发分支不在 CI 触发面 | 仅 `push main` / `PR→main` / 手动；`win`、`dev` 推送零 CI。 | 恢复 `dev`/`win` push 腿或补手动预检说明 |
| **W-4** | `src/studio/server/api/documents.ts:149,154` | `foreshadowSaveChains` 无失效钩子 | 按 `bookRoot` 建 key，`set` 后**从不 delete**，且不在 `forgetBookKeyedCaches` 扇出里——是唯一漏钩子的 per-book Map（兄弟 `filePutChains`/`leadUpdateQueues` 都自删）。改名会换 root 导致条目累积。 | 链尾 settle 后比对删除（照 `files.ts:210`），或纳入 `forgetBookKeyedCaches` |

### P3（卫生/性能，择机）

| id | 位置 | 标题 |
|---|---|---|
| L-1 | `src/learn/index.ts:185-254` | `sampleCandidates`/`quoteCandidates` 全书累积后才取 top-10/top-5，峰值与书长同阶；且注释自称「峰值从全书降为单章」，与实现不符（误导性注释） |
| L-3 | `src/process/spill.ts:72,173` | spill 文件 GC 仅「写触发」（下次写 spill 时清 30 天以上），无启动/停机/生命周期清扫；只在编辑过的书会自清 |
| L-4 | `src/studio/web-next/src/composables/useFocusTrap.ts:21,78` | 模块级 `activeTraps` 只标 `disposed` 不移除，长会话无限增长；每次 Tab 全表扫描 O(n) |
| L-5 | `src/studio/web-next/src/composables/useShelf.ts:99-105` | 模块级 `scroll` 监听用 `{capture:true}`，全应用任意滚动都触发；每次触发 `new WeakMap()` 重建缓存（全局热路径分配） |
| L-6 | `src/studio/web-next/src/components/ui/FontPicker.vue:56,69` | `typeTimer` 未在 unmount 清理（回调无捕获，纯卫生） |
| L-7 | `src/studio/web-next/src/composables/useSse.ts:103-150` | `probeSseBusy` 的在飞 fetch 未随 unmount 中止；跨书切换后可能弹过期 429 提示 |
| P-1 | `src/rag/store.ts:308`（`openRagDb` 调用） | `ensureNormColumn` 每次开库全表扫 `chunks`（`norm IS NULL` 无索引）；`recallDetailed` 每次召回开库两次 → 大书每次 2 次全扫 |
| P-2 | `src/check/count.ts:722,738`；`src/format/piece-list-core.ts:29-31` | 正则每次调用重编译（同文件别处已模块级提级，属非对称） |
| P-3 | `src/process/skills.ts:147`；`src/process/materials.ts:37-49` | `loadSkill` 每次重扫三根目录；`renderRecallHits` 每个召回命中整树走查（最多 5 次全树 readdir） |
| P-4 | `src/desktop/main.ts:265,667`（`shutdownSettledWaiters`）；`src/studio/server/http.ts:155,179`（grace 计时器未 `unref`）；`src/desktop/preload.ts:103`（`pendingMenuSelect` 滞留） | 边界级卫生项 |
| D-1 | `src/document/tree.ts:239`、`src/ai/provider/registry.ts:117`、`src/format/chapters.ts:295`、`src/process/settings-context.ts:48` | 1 处注释失真（`clearProbeCache` 宣称被 `invalidateTreeIndex` 调用，实际没有）+ 4 个零调用点的 `clear*` 导出 |
| H-1 | `test/e2e/**` 临时目录 | Windows 临时区已残留 **1383 个 / 44MB** `clwriting-*` 夹具目录（Aug 27 起），是 W-3 同源症状的批量体现 |

---

## 六、测试与 CI 质量评估（是否「以量取胜」）

### 6.1 量化画像

| 指标 | 值 |
|---|---|
| 单测文件 / 用例（win 实收集） | 1008 / 6529（过 6450 + 跳 79） |
| 断言总数 / 每用例均值 | 19,895 / ~3.09（零断言文件 0 个） |
| 快照断言 | **0**（无 snapshot-only 测试） |
| `.only` / `.todo` / `.fixme` | 0 / 0 / 0（均被 `check-counts` 机械拦截） |
| `skipIf(win32)` 声明 | 74 处 / 47 文件（另 2 处 win-only） |
| 覆盖率（主桶 / ai / events / server / api / stores） | 91.32/85.74/97.22 · 92.10/88.92/98.54 · 96.28/91.39/100 · 88.55/75.60/93.84 · 89.32/95.83 · 91.82/90.20 |

### 6.2 判断

**这是真实的证据，不是 CI 表演——但它的重心在「后端逻辑 + web 前端逻辑」，而「桌面应用」这个交付形态恰恰是它最薄弱处。**

- **强**：无快照注水、断言密度正常、mock 打在真实边界（fs/child_process/API）、存在真实跨书竞态守卫测试；`check:counts` 的漂移门（文件数/用例数/e2e spec 顺序快照/拒绝 `.only`）设计扎实。
- **弱（幻觉面）**：
  1. **e2e 证明的是 web 前端 + 源码 server，从不启动 Electron。** 出货的集成层在 tag 前无任何自动化。
  2. **「两百万字不崩」全仓库无测试。**
  3. **覆盖率门有两处结构性空洞**（web-next 聚合桶 43 vs ~90；0% Worker/入口被 91% 均值稀释）。
  4. **e2e 稳健性借自「冻结顺序」而非隔离**，且 `retries: 0`。
  5. **出货平台少跑 ~74 用例且不核单测数。**
  6. 219 处 `setTimeout` 真实等待散布 121 个测试文件（CI 负载下的 flake 源）；当前 e2e 在 win 上实测为红。
- 结论：**单测层与门禁工具链是可信的质量证据；桌面运行时、长跑稳定性、UI 组件覆盖率三项主张无背书，应视为「未验证」。**

---

## 七、与「既有评审结论」的关系

本报告按要求为独立重评，不引用既有结论。方法论上值得记档的差异：

- 既有轮次（含 2026-09-09 批）在「安全纵深 / 交互静默 / 键盘 a11y / 测试稳定性」上做了大量收口，且**确有实效**（SSE 句柄表、事件库引用计数、缓存 forget 扇出等经本次独立复验成立）。
- 但 2026-09-09 批的 R4-P2-1（IPC 白名单）在引入安全纵深的同时引入了 **W-1**，而其验证方式是「补假件适配」——把测试夹具改成永远不抛的形态，恰好绕过了真实运行时的关键行为。**这是本次 P1 能穿过全套门禁的直接原因**：不是门禁不够多，而是假件与真实运行时行为不一致，且没有真实 Electron 门兜底。

---

## 八、处置建议（按优先级）

1. **立即修 W-1**：`trackWindow` 改为捕获局部 `webContents`；同批给 `closed` 清理处理器加独立 `try/catch`，并复核 `uncaughtException` 直接 `process.exit(1)` 的策略是否过激（当前它把任何监听器异常升级为崩溃退出）。回归：补一条能在 `webContents` 访问抛错时暴露问题的用例（夹具改为「销毁后取 `webContents` 抛错」），或加真实 Electron 启动冒烟。
2. **修 W-3 + 补 T-1**：`server.close()` 自足化（关 SSE / 等在飞 Worker / 关 per-book 库），并把 e2e 红转为绿；同时把 headless Electron 冒烟接进 PR 门——这是补上「桌面形态无集成覆盖」这一结构性缺口的最小动作。
3. **修 W-2 / A-1**：两个都是「同文件已有正确范式、此处漏做」的非对称修复，成本极低。
4. **收紧验证门**：T-3（composables 覆盖桶）、T-2（soak 门）、T-5（win 少跑 + 不核数）、T-6（分支触发面）。
5. **P2/P3 余项**按域排期，L-2（统计全量读）与 W-4 建议随下批一并。

---

## 九、未验证与不确定性

1. **未做运行时堆采样。** 全部泄露结论来自静态审查 + 生命周期接线核查 + 定向复现，未采 heap snapshot / RSS 曲线；因此「无线性增长泄漏」是**结构性论证**而非压测结论（W-1 的崩溃与 W-3 的 `index.db` 占用是实测的）。
2. **未打包验证。** 未跑 `build:desktop`，未在打包态复现 W-1；`Object has been destroyed` 系 Electron 核心行为（跨平台），但打包态表现未亲验。
3. **未审 `dist/` / `dist-electron/` 产物**，不排除源码与产物分歧。
4. **`yaml.ts` 往返保真未做对抗性输入测试**（含 `#`/`: `/引号/多行块标量的值），仅静态阅读；建议单立一轮输入审计。
5. **CJK 覆盖**：`HANZI` 仅 U+4E00–U+9FFF + Ext-A，不含 Ext-B+ 代理对区间（代码自述为有意取舍）——目标语料是否可接受需产品拍板。
6. **性能类 P3（P-1/P-2/P-3）未做实测基准**，仅静态判断调用次数与算法阶。
7. **`learn/index.ts` L-1 的量级为估算**（按片段长度上界推 tens of MB / 2000 章），未实测。

---

## 十、评审执行留痕

- 分域并行：8 路（≤4/波，符合子 agent 派发上限），均要求「忽略 `Dev/` 既有评审文档、只读不改、带 file:line 证据、禁止跑全量测试以免与主审终门互相干扰」。
- 主审独立复核项：W-1（真实 Electron 进程实验 + 控制组 + 代码路径与注册顺序核对）、W-2/W-3（读码 + 3 次定向复跑 + 残留物取证）、A-1/L-1/W-4（读码核对）、前端监听器配对（自写脚本全树审计 466 文件）、L2 终门九件套亲跑。
- 交叉印证：W-3 由「服务端分域（停机无 SSE 拆解）」与「跨模块接线分域（停机不等 Worker）」两路独立发现，并经主审 e2e 复现取证互证。

---

## 十一、收口记（2026-09-10）

- **作者指令**：「全部修复！编排任务做。」——本报告全部缺陷按 §八 处置顺序落地修复批，本记登记收口状态、修复面与终门实据；报告状态行同批回改「已收口」（历史正文不改写）。
- **执行方式**：两波八路文件互斥并发子代理（波 1 桌面壳 / 服务端停机 / 前端泄露 / AI 与管线；波 2 持久化与性能 / CI 门禁 / e2e 稳健性 + 计数门），每波 ≤4 在途，符合子 agent 派发上限；主审逐项复核关键结论并亲跑 L2 终门。

### 11.1 P1 修复与「修复确实生效」的独立验证

- **修复**（`src/desktop/main.ts` `trackWindow`）：`const wc = win.webContents` 局部捕获后注册 `win.on('closed', () => trustedSenders.delete(wc))`——销毁后不再触碰 `win.webContents`。同批加固：各 `closed` 清理处理器经 `guardClosedCleanup(label, fn)` 各自 `try/catch` 隔离（单点抛出不再连坐其余清理）；`uncaughtException` 由「fire-and-forget `stopChild()` + 固定 200ms 退出」改为「200ms 兜底计时器 + `stopChild()` 完成后清兜底并退出」，不再截断优雅停机（会话 flush / 事件落库）。
- **为什么这次不能再靠假件蒙混**：新增真实 Electron 启动冒烟门 `scripts/electron-smoke.mjs`（`npm run smoke:electron`）——真起 `createSecureWindow` → 关机 → 复核白名单条目被剪除且无未捕获异常；主进程侧加 `runSmokeWindowCycle()`（`CLW_SMOKE_WINDOW_CYCLE=1` 触发，吐 `[CLW_SMOKE] window-cycle-ok`）+ `__testHooks.trustedSenderCount/hasTrustedSender`。
- **控制实验（本循环关键证据，主审亲跑）**：把 `trackWindow` 临时改回报告 §五 W-1 的原样缺陷形态 → `npm run build` → `npm run smoke:electron` 得 **exit 1**、日志 `[CLW_SMOKE] crash Object has been destroyed`、冒烟脚本报「应用报告主进程未捕获异常」；还原修复 → 重建 → 冒烟 **exit 0**、`PASS：捕获到 window-cycle-ok`。**结论：该冒烟门真能拦住 W-1，不是摆设。**
- **回归用例**：`test/desktop/main.test.ts` 假件改为「销毁后取 `webContents` 抛错」形态（复现真实运行时行为），使同类回归在单测层即可暴露。

### 11.2 缺陷销项对照

| 档 | 销项 |
|---|---|
| **P1** | W-1 全修（含 try/catch 隔离 + `uncaughtException` 不停机链 + 真壳冒烟门 + 假件行为对齐） |
| **P2 全修** | W-2（`cache/rebuild.ts` 增量分支 `db.close()` 补对称，回归 `test/cache/rebuild-readonly-close.test.ts`）/ W-3（`closeAllSseConnections()` 导出并在 `server.on('close')` 调用；`server.close` 包裹至在飞工作在预算内落定〔`CLOSE_FLUSH_BUDGET_MS=2s`〕；新增 `src/studio/server/api/in-flight-work.ts` 有界登记表；`graceful-shutdown.ts` 排空 DocumentService 队列 + 等在工作；回归 `test/studio/r0910-w-shutdown-teardown.test.ts`）/ A-1（`read_skill` 照 `read_chapter` 口径 `READ_SKILL_MAX_CHARS=20000` 码点安全截断 + 截断提示）/ L-2（`llm-call-read.ts` 增流式迭代 + `iterateEvents` 生成器，`cost-stats`/`trace-stats` 改增量聚合；回归 `test/events/iterate-events.test.ts`）/ W-4（`foreshadowSaveChains` 链尾比对自删 + `forgetForeshadowSaveChain` 纳入 `forgetBookKeyedCaches` 扇出）/ T-1（Electron 冒烟接进 CI e2e job，ubuntu 用 `xvfb-run` + apt 装 GTK/NSS/ALSA）/ T-2（`test/soak/soak.ts` + `npm run soak`，有界 10 万次纯路径往返 + `--expose-gc` 堆增长断言；故意不带 `.test.`，不进计数套件）/ T-3（`vitest.config.ts` 单列 `src/studio/web-next/src/composables/**` 覆盖桶 lines 82 / branches 81，`EXPECTED_GLOBS` 双向锁同步登记）/ T-5（`scripts/check-counts.mjs` win 腿改为同时核对文件数、e2e 数与**单测数**——解析 README「实测差 N 恒定」推 win 期望值） |
| **P3 全修** | L-1（`learn/index.ts` 有界 top-N 池 `SAMPLE_KEEP 10/POOL_CAP 20`、`QUOTE_KEEP 5/POOL_CAP 10` + 共享比较器，注释与实现对齐）/ L-3（`process/spill.ts` 导出 `sweepOldSpills` + 1h 节流，接入 `state.ts` 既有节流清扫；回归 `test/state/spill-sweep-wire.test.ts`）/ L-4（`useFocusTrap` 清理时 splice 移除登记项，去 `disposed` 标志）/ L-5（`useShelf` 光晕用 `glowRectsDirty` 布尔代替每帧 `new WeakMap()`）/ L-6（`FontPicker` `onBeforeUnmount` 清 `typeTimer`）/ L-7（`useSse` `probeCtrl` AbortController + 世代门，回归 `test/studio/webnext/r0910-w-sse-probe-switch.test.ts`）/ P-1（`rag/store.ts` 补 `chunks(id) WHERE norm IS NULL` 部分索引；回归 `test/rag/norm-null-index.test.ts`）/ P-2（`check/count.ts` 正则入 Map 记忆化；`piece-list-core.ts` 段头正则提模块级）/ P-3（`process/skills.ts` 根指纹 name→meta 索引缓存 FIFO 64；`process/materials.ts` 单次遍历读章体）/ P-4（`http.ts` grace 计时器 `.unref()`；`preload.ts` `unload` 时清 `pendingMenuSelect`；`server-manager.ts` waiter 自摘；`main.ts` `shutdownSettledWaiters`）/ D-1（删 `document/tree.ts` 注释失真的 `clearProbeCache` 死导出；三处 test-only 导出补标注）/ H-1（清理 Windows 临时区残留 **1353 个 / 19MB** `clwriting-*` 夹具目录〔保留 2 小时内可能活跃者〕；配套 `test/e2e/tmp-cleanup.ts` `rmTempDirRetry` 仅对 ENOTEMPTY/EPERM/EBUSY 重试、其余原样抛出，e2e 各自清理接入） |

### 11.3 维持登记（不修，落台账 §三 R0910-W 行）

- **T-4**（22/29 e2e spec 共享可变 on-disk 状态）：架构级解耦维持登记——此为既有已拍板取舍，全量改造非本批范围；本批只把其**症状**（teardown 竞态红）修稳，缓解已在位（globalSetup 每跑全新 workDir + `workers:1` 顺序契约 + spec-order 快照门 + `retries:0` 刻意取舍）。
- **T-6**（`ci.yml` 触发面不含 `win`/`dev`）：属**待作者拍板**事项（台账已有「dev 分支 CI 空窗待作者拍板」挂账），改它等于替作者做取舍，本批不动。

> H-1 的**存量**已清，但「跑 e2e 会留夹具」这一**机制**只做到「尽力清理 + 重试」；因 T-4 共享 workDir 未解耦，夹具根因仍在，故 H-1 与 T-4 同源，随 T-4 一并登记。

### 11.4 L2 终门实据（主审亲跑，win 平台，修复后终态）

| 门 | 实测 | 结论 |
|---|---|---|
| `vitest run` | 1014 文件 = **6470 过 + 79 跳 0 败**（共 6549 收集）；306.56s | ✅ 绿 |
| `tsc --noEmit` | 0 错 | ✅ 绿 |
| `vue-tsc --noEmit` | 0 错 | ✅ 绿 |
| `eslint .` | 0 问题 | ✅ 绿 |
| `check:counts` | 通过（1014 文件 / 6470 单测 / 29 spec / 45 用例，README 声称值对账一致） | ✅ 绿 |
| `check:packaging` | 通过 | ✅ 绿 |
| `check:knowledge` | 通过 | ✅ 绿 |
| `build:web` | 通过（仅既有 chunk >500kB 提示，非错误） | ✅ 绿 |
| `playwright test`（e2e） | **43 过 + 2 跳 + 0 败**（53.7s）——报告 §一 的 `ai-degrade` 偶发红已随 W-3 修复转绿 | ✅ 绿 |
| `npm run soak` | 100k 迭代 · 基线 7.37MB → 终值 7.35MB（−0.02MB）· 上界 24MB | ✅ 绿 |
| `npm run smoke:electron` | PASS（window-cycle-ok）；对照：复现缺陷形态时 exit 1 + crash 标记 | ✅ 绿 |

- **测试面净增**：1008 文件 / 6450 过 → **1014 文件 / 6470 过**（+6 文件 / +20 用例全平台无关）；README 四处修账 6525 → **6545**（win 口径 1014 文件 / 6470 过 + 79 跳；mac/linux 口径 = win 过数 + 75 恒定差，待 CI macos/ubuntu 腿复验）。
- **改动面**：69 文件变更（59 改 + 10 新增，含 `test/soak/` 目录），+2032 / −253。
- **提交**：已提交 `win` 分支 `5bbee416`（2026-09-10 作者指令「提交改动」），工作树零残留。
- **零破坏性变更**：全部为缺陷修复、门禁收紧与卫生清理，无对外契约变更（`listEvents` 行为不变，新增为 additive `iterateEvents`）。

### 11.5 未验证项顺延（不减损收口）

- 打包态（`build:desktop`）未亲验，W-1 在打包态的表现未复现（`Object has been destroyed` 系 Electron 核心行为，跨平台；§九 第 2 条）。
- 未做运行时堆采样；内存结论仍为结构性论证（§九 第 1 条）——本批以 `npm run soak` 补上「有界纯路径无线性增长」的**机器断言**，但非全链路压测。
- CI 三腿矩阵（macos/ubuntu）实跑数字待 CI 回填（本地仅 win 腿）。
- 归档移动：本报告已收口，按文档链暂存 `01-评审/`，归档移动随下一整理批（沿 2026-09-10 整理批先例）。

### 11.6 过程如实记档

- 子代理执行中一度把 `vitest list` 的 JSON 输出重定向覆盖了 `test/ai/calls.test.ts`（25882 增 / 354 删），并在仓根落下 `mac-err.txt` / `mac-list.json` 两个垃圾文件；已用 `git checkout -- test/ai/calls.test.ts` 还原（354 行 / 57 断言）并删垃圾文件，终门复跑确认无残留。
- 首轮全量跑暴露「R65-58 双向覆盖桶守卫」拦下子代理新增覆盖桶未登记 `EXPECTED_GLOBS`（2 用例红）——补登记后治理测试转绿，终门复跑全绿。此红为守卫**按设计工作**，非缺陷。

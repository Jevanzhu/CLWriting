# 全库代码重评——进度与质量（独立评审报告）

- 日期：2026-09-14（落盘批）。
- 执行模型：GLM-5.3（主审）。九路分区评审子代理与主审同模型，头部不再另列。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」
- 评审对象：当前工作树全量源码（基线 = 提交 `3dd44f87` + 工作树未提交的 0914 优化修复批改动，如实记档；评审即对此树态负责）。
- **独立性声明**：本报告为零读取既有评审的独立评审——`01-评审/` 与 `Archive/` 下全部评审正本零读取；进度基线仅取总览第三节阶段行、冻结件 §六阶段清单与根 README。
- 状态：**已收口**（2026-09-14 修复批——P2×6 全修 + P3 择收 25 全收 + 回归 L2 全绿；收口记 = §十；正本随批移 `Archive/`）。

---

## 一、结论速览

| 维度 | 结论 |
|---|---|
| **完成进度（功能面）** | **24/24 阶段全部落地，代码实证全覆盖**——设计范围内无缺失功能块；综合完成度 **≈98%**（差项 = 6 个窄触发 P2 + 33 个 P3 边角 + 台账三项待拍板语义细化，非功能缺块） |
| **完成质量** | **A−**（0 P1 / P2×6 全部窄触发并发或边角 / P3×33；九件套质量门禁主审亲跑实测全绿） |
| 缺陷判定 | **P1×0 / P2×6（全部主审亲验成立）/ P3×33**（子代理报出 35，主审销案 2） |
| 质量门禁 | vitest **1126 文件 = 7282 过 + 7 跳 0 败** + tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过 + e2e **49 过 + 2 跳**（§二实测） |
| 安全与数据保护 | 安全三件套（Host/Origin/令牌）、路径穿越防护、跨进程锁、vault 加密、git spawn 注入面、迁移不覆盖作者数据——七个专项面全部核查闭合，未发现破口（§七） |

**质量印象总评**：这是一套防御纵深异常体系化的代码库——错误信封单一出口、fail-closed 方向全局一致、竞态守卫（请求代/书名捕获/在途锁/引用计数）成网、R 编号修复注释使历史决策可现场追溯；本轮独立评审 495 文件（113,185 行）仅得 6 个窄触发 P2，且全部集中在「并发窗口的单向丢失更新」「同族修复漏网点」「双源口径漂移」三类边缘，无一处数据损坏或安全破口。测试面 1126 文件/7282 用例与 README 声称逐位对账一致。

---

## 二、质量门禁实测（2026-09-14 主审亲跑，darwin 实机）

| 门 | 结果 |
|---|---|
| `npm test`（vitest 全量） | ✅ **1126 文件 = 7282 过 + 7 跳 0 败**（140.28s；7 跳 = win32 平台门用例按 `skipIf(win32)` 收集后跳过） |
| `npm run typecheck`（tsc --noEmit） | ✅ 0 错 |
| `npm run typecheck:web-next`（vue-tsc） | ✅ 0 错 |
| `npm run lint`（eslint --max-warnings 0） | ✅ 0 问题 |
| `npm run check:counts` | ✅ 过——README 声称值与实测一致（1126 文件/7282 单测；31 e2e spec/51 用例） |
| `npm run check:packaging` | ✅ 过（打包清单/prompt 版本表对账一致） |
| `npm run check:knowledge` | ✅ 过（知识层 13 条 manifest 与磁盘一致） |
| `npm run test:e2e`（Playwright） | ✅ **49 过 + 2 跳**（37.7s；2 跳 = 发布 smoke 需 `CLWRITING_E2E_RELEASE`） |

本批未复跑：coverage（CI 三腿矩阵 + 阈值门兜底）、soak、electron-builder 出包（本批零代码改动；CI 兜底）——如实记档。

---

## 三、P2 缺陷明细（×6，全部主审逐条亲验成立）

### P2-1〔server〕三审完成写可静默清除作者已确认的裁决（单向丢失更新）

- **证据**：`src/studio/server/api/review.ts:253-261`（三审完成写 payload 全新构造 `{ collected, lenses, ... }`，**不含 verdict**、写前不重读不合并）＋ `:285-345`（review-verdict 端点**无 `reviewRunning` 运行闸**——对照同文件 :119-123 三审端点自身有 409 闸）；R-16 双读合并（:302-327）只防护「三审在本端点两读之间完成」这一**反方向**竞态。
- **亲验（前端可达性）**：ReviewPanel.vue:174-187 裁决「通过/驳回」按钮仅 `verdictSaving` 禁用、`v-if="isReviewable"` 展示——**三审进行中（review.loading）按钮可点**，竞窗 UI 可达，非仅 API 面理论值。
- **触发**：三审（分钟级）运行中作者点裁决 → 端点 200 ok 落盘 verdict → 三审随后完成 → 完成写以不含 verdict 的 payload 整体替换同 kind 信封 → **已返回成功的裁决被静默丢弃**；`api/check.ts:184-187` 树红点随裁决丢失回跳。违反本模块自述不变量（review.ts:300-301「裁决是作者最后动作，唯一允许覆写的字段」）。
- **建议**：review-verdict 入口对 `reviewRunning.has(reviewRunKey(name, docId))` 回 409（与三审端点同口径，最小修复）；彻底闭合则 review 完成写改锁内 RMW 合并（保留/显式弃置 verdict 语义留作者拍板）。

### P2-2〔document〕doCopy 目录段 `.` 不拒——清单登记路径与物理落位分裂（R51-D-3 同族漏网）

- **证据**：`src/document/service.ts:1796` 只拒 `..`（`relSegs.includes('..')`）；:1797-1799 目录段「已存在则原样保留」分支对 `.` 恒命中（`existsSync(join(root,'a','.'))` 即父目录，必真）→ `copyRelPath` 原文含 `./` 段登记清单；物理落位经 `resolveSafePath` 词法 resolve 折叠掉点段。对照同族已修点 `normalizeMoveToDir`（:213-219）`..`/`.` **双拒**。
- **触发**：调 copy API 传含 `.` 目录段的 relPath（`./写作/正文/0005-副本.md`）。前端正常路径（树派生）不含点段，触发面 = API/AI/CLI 侧。
- **后果**：清单条目 `a/./b.md` ≠ 盘上 `a/b.md` → 树 annotate 按 `docJoinKey` 失配 → docId 退化 legacyId、身份分裂，树/清单/版本链按分裂身份走（R66-5/R51-D-3 同族终点）。
- **建议**：doCopy 入口 `relSegs.includes('.')` 一并拒绝（对齐 :217）。

### P2-3〔web〕全自动写章收工跳转在「工作台未挂载」窗口整链失效（R27-77 同型漏配）

- **证据**：`WorkbenchView.vue:149-166` `watch(() => wb.healResult, …)`（openTab + 「已写完，已转到编辑器」toast）挂在本视图、**无 immediate**；`Book.vue:366-381` 视图经 `Transition` + `v-else-if` 切换、无 KeepAlive——切走即整实例卸载。同文件 :168-170（R27-77）已为 `wb.warning` 修复**完全同型**问题（消费面上移 WorkspaceShell 常驻层），healResult 漏配。
- **触发**：全自动写章运行中切到编辑器/总览等视图 → `self_heal_result` SSE 到达时 watch 已随实例卸载不触发；返回工作台重挂后无 immediate 不补放（全库 grep：healResult 仅 WorkbenchView 与 WbHealCard 消费）。
- **后果**：代码自述「tool_use 模式下无逐字流，收工跳转是作者看到成品的唯一通道」——该通道在此窗口被跳过（不跳转、不 toast）。草稿已落盘、回工作台仍见终局卡，故不升 P1。
- **建议**：比照 R27-77 把 healResult 消费上移 WorkspaceShell（或 Book 常驻层）。

### P2-4〔web〕文风铁律编辑：收起再展开静默覆盖未保存修改

- **证据**：`StyleBaselineCard.vue:90-96` 收起分支直接 `editingRules = false` 返回、不查 `rulesDirty`（:89 脏标记已存在）；:100-105 重展开无条件重取服务器内容覆盖 `rulesText`。
- **触发**：展开「编辑铁律原文」→ 修改 textarea → 点「收起」（或误触）→ 再展开 → 未保存修改被旧版静默覆盖，无确认。库内同型场景均已配脏守卫（OnboardView R8a-P2-2「手改未保存不静默丢稿」口径），此处漏配。
- **建议**：收起时 `rulesDirty` 先 danger 确认；或重展开时本地脏且 baseRev 未变则保留本地文本。

### P2-5〔process〕账本推进归档的时间戳变体对全部消费方不可见（写入-读取契约破裂）

- **证据**：写侧 `src/process/lead-update-draft.ts:193-197`——目标已存在时落 `第N章-${Date.now()}.md`（L-P6 保两代）；消费侧一 `src/check/run.ts:310` 正则 `^第(\d+)章\.md$`（带后缀不匹配即 `continue`）；消费侧二 `src/check/lead-updates.ts:178` `archivePath` 精确拼接标准名只读一处。**两个消费方都只认标准名。**
- **触发**：`工作区/.账本推进暂存/第N章.md` 已存在时再次归档同章条目（归档生成后未确认/未定稿且主文件再载同章条目）。
- **后果**：第二代归档的推进声明对机检两端闭合预扫与定稿防吃书闸/履历回写**完全不可见**——已声明的推进被静默丢弃（履历漏记、`declared-not-done` 闭合判定失明）。文件在盘非物理丢失，定 P2。
- **建议**：择一——读侧放宽正则多文件按章合并；**写侧去时间戳化（同 tag 读旧+追加合并重写标准名，推荐，锁内原子性已有）**；或消费后删档使重存概率归零。

### P2-6〔rag〕openRagDb PRAGMA 顺序与 events 侧 N3 修复不同步——并发首开可立即 SQLITE_BUSY

- **证据**：`src/rag/store.ts:219-220` `journal_mode = WAL` **先于** `busy_timeout = 5000`、无重试；对照 `src/events/store.ts:666-690`（N3，五十九轮修复）注释明确「busy_timeout 必须先于 journal_mode=WAL 设置——WAL 切换需拿写锁，另一进程持锁时立即抛 SQLITE_BUSY」，且 events 侧 WAL 切换带 8 次退避重试。rag 侧注释自称「P2-2：WAL + 忙等 5s 防并发 BUSY」——顺序恰使该防护在首开窗口失效。
- **触发**：双进程（桌面第二实例 + CLI/dev-api，项目明确支持的双进程形态）并发首开同一 RAG 库且库尚处 delete 模式（新建/重建/legacy 迁移后）。
- **后果**：`buildIndex`/`recallDetailed` 即抛 SQLITE_BUSY（信封化报错，可重试不损坏）——events 侧已确认真实发生过的同款缺陷在 rag 侧漏修。
- **建议**：对齐 events 侧——busy_timeout 前置 + WAL 切换退避重试（或引同款 `switchJournalModeWAL` 单源）。

---

## 四、P3 汇总（×33，含主审抽验标注；另有销案 2）

> 分区报出 35 条，主审销案 2 条（见 §四末）。处置建议列「择收」= 建议修复批顺手收口，「登记」= 建议记台账备查不急修。

| # | 分区 | 概述 | 证据锚点 | 主审核验 | 建议 |
|---|---|---|---|---|---|
| 1 | ai | Responses 适配器对缺省 description 发空串，另两线条件 omit（当前 ToolDef 全带 description 不可触发） | provider/responses-adapter.ts:183 | — | 择收 |
| 2 | ai | anthropic 线保留空 text 块，正确性依赖上游 sanitizeHistory 隐式耦合 | provider/anthropic-adapter.ts:99 | — | 择收（一行防御） |
| 3 | ai | assembleChapter 四枚举字段宿主侧不复验域，域外值落 fm（概率极低，误报面） | contract/chapter.ts:112-119 | — | 登记 |
| 4 | server | journal acknowledge 落账后 /state 5s TTL 缓存不失效——前端确认后立即 refreshState() 恰撞陈旧窗，崩溃提醒回显最长 5s | api/state.ts:188 + WorkbenchView onAcknowledgeCrashed | **亲验成立**（前端写后立即重拉） | 择收（一行 forgetStateCache） |
| 5 | desktop | vitest coverage exclude 缺 `._*`（AppleDouble），与测试收集口径不对称（外置卷跑 coverage 假红方向） | vitest.config.ts:57 vs :105 | — | 择收 |
| 6 | desktop | dev-api.ts 双信号兜底 timer 无单槽查重（server-main.ts 同型已修） | scripts/dev-api.ts:99-106 | — | 择收 |
| 7 | desktop | electron-smoke.mjs 日志缓冲无上限（Chromium 全量日志可达数十 MB） | scripts/electron-smoke.mjs:119 | — | 择收（保尾即可） |
| 8 | desktop | calibrate-tokens.ts argValue 宽松口径（代码自注挂账复核确认） | scripts/calibrate-tokens.ts:25-29 | — | 登记（既有挂账） |
| 9 | desktop | initial-book 名命中臂返回原始 ref（NFD 不归一），非 CJK 书名下游严格匹配可落空 | desktop/initial-book.ts:40 | **亲验成立**（纯 CJK 不受影响） | 择收（一行返回登记名） |
| 10 | desktop | electron-builder files 未排除 `._*`（构建卷产生 AppleDouble 时副本进 asar，无功能实害） | electron-builder.yml:9-12 | — | 择收（补否定模式+门锚） |
| 11 | document | 章号推断窄正则三处与 chapterNoFromName 单源不一致（全角破折号/空格分隔名失明→定稿账面静默缺失） | finalize.ts:376-379 等 | — | 择收（三处收编） |
| 12 | format | iron-rules 段采集标题前置闸 `\s+` 强制空格，段锚定 `\s*` 零空白容忍被拦截永不生效（紧凑标题段静默失明，双重静默） | iron-rules.ts:236 vs :205-206 | **亲验成立**（读全函数体） | 择收 |
| 13 | document | 树 probe parsePublishedValue 不剥行内注释/不认数组形态，与 status.ts readPublished 口径分裂（注释宣称同口径不实） | tree.ts:357-367 vs status.ts:59-68 | **亲验成立** | 择收（收编单源） |
| 14 | document | lead-finalize unresolved `lock-timeout` 档位不可达（死码，类型暗示设计意图未实现） | lead-finalize.ts:234/:388-395 | — | 登记（拍板意图） |
| 15 | format | writePieceList 生产零接线（既有备案挂账，接线前需先补文本级补丁） | manifest.ts:45-48 | — | 登记（既有挂账） |
| 16 | format | yaml.ts book.title 空值不拦截，与 genre 空串归一口径不一 | yaml.ts:327-331 | — | 择收 |
| 17 | web | CmHost clipboardCut：await 剪贴板授权期间选区偏移陈旧可删错文本（桌面态窗口极小，undo 可挽回；paste 侧正确对照） | editor/CmHost.vue:487/:497 | — | 择收 |
| 18 | web | useHeartbeat leave() 的 DELETE 无超时（beat 已修同型，悬挂 promise 无泄漏实害） | composables/useHeartbeat.ts:90 | — | 择收 |
| 19 | web | 章节树 onDrop 源落空与「目录不支持」同一分支，文案误导（无数据动作） | useChapterTreeActions.ts:752-758 | — | 择收 |
| 20 | web | api/stream.ts 文件名与内容不符（全是工作台端点，无流代码；服务端另有同名文件加剧混淆） | api/stream.ts | — | 择收（改名随批改指） |
| 21 | web | stores/doc.ts 五处 `bookName.value!` 非空断言（现状接线保证非空，防御缺口） | stores/doc.ts:151 等 | — | 择收 |
| 22 | web | AiProviderList configuredRows 冗余死码（模板只消费 length） | ui/AiProviderList.vue:32-34 | — | 择收 |
| 23 | web | ExportDialog onKeydown 缺 defaultPrevented 首行短路，脱离 Esc 让渡链惯例 | ui/ExportDialog.vue:57-64 | — | 择收 |
| 24 | web | SettingsBookAnalysis 注释宣称 KeepAlive 关窗仅 deactivated——实测关窗即真实 unmount，注释失实 | SettingsBookAnalysis.vue:399 | — | 择收（改注释） |
| 25 | web | OnboardView 保存成功不回写 lastGenerated，切步骤误报「未保存修改」（编辑后保存常见路径必现） | OnboardView.vue:94/:126/:157-176 | — | 择收（一行） |
| 26 | web | Shelf 新建书弹窗关闭后 createError 残留 | pages/Shelf.vue:63-66 | — | 择收 |
| 27 | web | 工作台状态未载入窗口 chapter 回落 1，生成族按钮不因 state===null 禁用 | WorkbenchView.vue:93/:451-481 | — | 择收（禁用或先刷） |
| 28 | web | OnboardStepPanel 结果相位「重新生成」缺 AI 可用性闸（与详情相位口径不一） | onboard/OnboardStepPanel.vue:57 vs :88 | — | 择收 |
| 29 | fs | isWithinRoot 对不存在路径不消解中间 symlink，与 resolveWithinRoot 不对称（头注已登记，当前调用点均为存在路径） | fs/safe-path.ts:106-111 | — | 登记（既有记档） |
| 30 | process | book-search 同步/异步双版本手写平行无单源约束（当前逐位一致，单侧修改即漂移） | process/book-search.ts | — | 择收（抽共享核心） |
| 31 | check | rosterNamesCache 无 forget 挂点（纯内存卫生，32 条上限有界） | check/count.ts:340-341 | — | 登记 |
| 32 | events | chat-bridge 丢最旧平移不覆盖调用方持有 sourceIdxs（越界被 store 校验兜住整批回滚，不越界静默错链；跨丢弃窗引用概率低） | events/chat-bridge.ts:211-226 + turns.ts:535-550 | 亲核消费面（lineageIdx 回合内消费，持续落库失败>256 才可达） | 登记 |
| 33 | rag | RAG 重建互斥完全依赖外部任务闸，本域内无跨进程互斥（单实例由闸兜住；建议头注登记依赖） | rag/index.ts:231 附近 | — | 登记（头注显式化） |

**销案 2 条（主审核验后撤销）**：
- ~~renderRecallHits 按 UTF-16 码元切片可劈代理对~~——rag 侧 chunk 边界有 isHighSurrogate 防护且偏移即 chunk 边界（rag 分区代理核验 + 主审对 `start_offset: chunk.start` 源头复核），切片不会劈代理对。
- ~~export 分区外调用面 finalizedPathSet 可抛错致 worker 120s 超时退化~~——finalizedPathSet 契约为失败返 null 不抛（document/manifest.ts:211-222 主审亲读），信封缺口不存在。

---

## 五、分区覆盖与质量印象（九路汇总）

> 编排：三波九路文件互斥只读评审子代理（单波在途 ≤4，作者纪律），每路逐文件读全不得抽样；主审亲验全部 P2 + 关键待核 P3。覆盖 = src 495 实码文件（113,185 行）+ 配置/构建/CI/根直属/scripts 12 件。

| # | 分区 | 文件数 | P1/P2/P3 | 质量印象（摘要） |
|---|---|---|---|---|
| 1 | src/ai（orchestrate/provider/prompts/rules/tools/contract/tasks） | 79 | 0/0/3 | 极高——「模型可见⟺已记录」铁律贯穿（promptMeta 五要素 + 溯源五处单源化）；runTask 重试/超时/预算闭环；vault 信封加密 + redact 全覆盖；三适配器错误归一/用量归一/流中断契约高度对齐 |
| 2 | src/studio/server（HTTP + api/ 45 端点族） | 53 | 0/1/1 | 优——安全三件套闭合（origin-form 强制/Host 精确/恒时比较令牌/GET 豁免单源）；穿越防护段级+双侧 realpath+symlink fail-closed；busyGate/串行链/任务闸三层互斥；SSE 背压双阈值强杀 |
| 3 | src/desktop + 根直属 + 构建链 + CI + scripts | 19+3+6配置+12脚本 | 0/0/6 | 极高——IPC 14 通道全白名单 + \0 防御 + 穿越双侧；flush 三链/kill 三路升级/崩溃退避三档；fontlist asar 外置四环一致；CI 三腿矩阵守卫无空洞 |
| 4 | src/document + src/format | 43 | 0/1/6 | 极高——保存协议三层锁+journal 全配对；定稿原子写+指纹校验+pinned；回收站先登记后移+三态幂等恢复；YAML/frontmatter 表驱动边界完备；唯一 P2 是既有修复家族（点段）边缘漏网 |
| 5 | web-next 核心层（api/composables/stores/shared/editor/入口） | 92 | 0/0/5 | 顶级——SSE 双段式换票+代守卫+指数退避全链；CM6 IME 挂起/undo 真重置深水区处理；stores 切书清理闭环；TODO/FIXME 扫描 0 条 |
| 6 | web-next 组件 ui/shell/panels | 72 | 0/0/3 | 极高——useStaleGuard 代守卫遍布；Esc 让渡链分层 + IME 让渡；焦点陷阱全覆盖；v-html 面 grep 零命中；RENDER_CAP=100 单源 |
| 7 | web-next 其余组件 + views/pages/styles | 43 | 0/2/4 | 高——三态降级全覆盖、危险操作确认成网、事件监听成对清理；两处 P2 均为「视图卸载窗口/脏守卫漏配」边角 |
| 8 | src/process + check + fs + driver + cache + state | 55 | 0/1/4 | 极高——14 类机检码点防护+正则回溯封死；跨进程锁 pid+bootTime+续期+接管完整；指纹缓存族自洽；safe-path 穿越闭环（唯一 P2 是归档命名契约缝隙） |
| 9 | 后端杂项（install/events/rag/export/review/metrics/log/learn/knowledge/git/shared） | 40 | 0/1/3 | 非常高——迁移链 v2/v3 幂等+回滚+不覆盖作者数据；事件库 append-only+引用计数+墓碑；RAG 码点安全+指纹幂等；git spawn 数组+白名单编码零注入；export 流式原子+批注净化 |

**跨分区共性观察**（正面）：错误信封 `{ok:false,code,reason}` 全库单形；fail-closed（安全面拒/观测面降级留痕）方向全局一致；R 编号注释密度约每 5-10 行一条，历史坑全部现场可溯；平台分支单源收窄（isWin32/platformCaseFold/normalizeWinSeparators/mod-key）。

---

## 六、进度对照：24 阶段 vs 代码实证

方法：以总览第三节阶段行 + 冻结件 §六阶段清单为基线，逐阶段找代码实证（九路分区的功能清单为证据面）。**结论：24/24 全部落地，无「阶段行宣称已完成但代码无迹」项。**

| 阶段 | 内容 | 代码实证域 |
|---|---|---|
| w/x/y/aa 清偿 + 0 前置决策 | 性能债/P1-P2 清偿/事件化基础/版本指纹缓存 | ai/orchestrate + events/（事件五层、血缘、指纹缓存族）✅ |
| 1 agent 化 + F1-P1 | 工具面白名单 + 事件库基础 | ai/tools（11 工具执行器 + 执行注册表）+ events/store ✅ |
| 2-6 批次 A-E | 注册表/prompt 资源化/回合切割/checkpoint/overlay/预算/目录管线/adapter 注册表/steer 队列/defineRoute | ai/prompts + ai/orchestrate/chat（checkpoint 压缩/spill/steer）+ server defineRoute 45 端点 ✅ |
| 7 F1 全量 | 五层事件/血缘/分支树/审计 UI | events/chain-bridge + 分支树投影 + AuditView ✅ |
| 8-12 批次 G-H + bb/cc/dd 轮 | 分支 UI/Origin 白名单+boot token/RAG 三端点+GUI | server 安全三件套 + rag/ + server/api/rag* + RagProviderEditor ✅ |
| 13 Responses 启用 | responses-adapter + quirks + 真机验证 | provider/responses-adapter.ts + model-quirks.ts + scripts/verify-responses-relay.ts ✅ |
| 14 服务提供方管理 | 卡片化/store 化/Key 校验/模型编辑器 | provider/store + vault + AiServicePanel/AiProviderList/ModelListEditor ✅ |
| 15-17 ff/gg/ii 轮 | CI 门/防吃书闸单源/备料接线/YAML 边界 | check/ + process/prepare + format/yaml ✅ |
| 18 迭代方向批 | 结构化日志/树红点缓存/摘要闭环/token 校准/RAG 惰性指纹/用量卡 | log/ + check/tree-issues-cache + process/summary + scripts/calibrate-tokens + WbUsageCard ✅ |
| 19 工作区事故重建 | S0-S7 | 全库保存协议族（journal/快照/锁）现状即重建后形态 ✅ |
| 20 docs 十轮复审 + rc.1 | 发版 | package.json `1.0.0-rc.1` + 发版冒烟 ✅ |
| 21 win 系统适配 | 批 0-4 + J0-J7 | isWin32 单源族/normalizeWinSeparators/win 打包 NSIS/EPERM 退避/跨进程锁 J7 ✅ |
| 22 desktop 进程拆分 | utilityProcess 崩溃隔离 | desktop/server-manager（fork 握手/退避三档/账目单列）✅ |
| 23 迭代建议清偿 | CI 性能回归门/确认闸/冷启动守护/知识层双步 | test/check/scale.test + CLAUDE.md/AGENTS.md + scripts/knowledge-{update,commit} ✅ |
| 24 章节结构操作 | 留洞制 fm 序/并入 + 合并/拆分/撤销 | document/structure（幂等续跑/planHash 复核/undo 四级定位）+ chapters 单源 + structure-ops e2e ✅ |

**挂账/半成品盘点**（均系有意保留/已备案，非失控，不影响 24/24 判定）：
- 代码内备案：writePieceList 未接线（P3-15）、MODEL_CATALOG 预建零消费（Z-P2-4 口径）、switch-provider 决策无自动消费者、claude thinking 完整回传留待跨批、estimateTokens 系数表待校准。
- 台账三项待拍板（阶段 24 残留，语义细化非缺功能）：inline 裸标题建章章号盲区 / 树显示序跨卷分组语义 / undo 回收站同章号反查歧义。
- WbStateCard 崩溃「忽略」链本轮核验**已接线**（服务端 /state 暴露 crashedPendingOpIds + acknowledge 端点 + 前端消费均在），组件内「契约未对齐」注释疑滞后，随批记正即可。

**完成度测算口径**：
- 功能面 = 24/24 阶段 × 代码实证 = **100%**（设计范围内无缺块；以上挂账均为边角语义/预建资产）。
- 综合完成度 = 功能 100% − 质量差项（P2×6 窄触发 + P3×33 边角 + 三项待拍板）≈ **98%**。

---

## 七、安全与数据保护专项结论（七面全闭）

1. **服务安全三件套**：origin-form 强制 → Host 精确匹配实际监听 → Origin 白名单（403）→ 令牌恒时比较；GET/HEAD 豁免表单源（/api/boot + SSE 模式）；apiPathname WHATWG 归一先于令牌闸（`/foo/../api/` 绕过不成立）。**无破口。**
2. **路径穿越**：resolveWithinRoot 段级越出判定 + 双侧 realpath + 不存在路径最近祖先锚 + suffix 逐段 lstat 拒 symlink；safeDocId 三入口；normalizeWinSeparators win32-only 收窄。唯一漏点 = P2-2（doCopy 点段，清单分裂非穿越）。
3. **并发与锁**：busyGate/串行链/任务闸三层互斥 + 跨进程 O_EXCL 锁（pid+bootTime+续期+陈锁接管）；写入点普遍挂 bookMovedFailure 贴近写盘重验。残余 = P2-1 裁决竞窗（无闸端点）与 P2-6（rag 首开锁序）。
4. **密钥保护**：vault 信封加密（HKDF→KEK→DEK→AES-256-GCM + providerId 绑 AAD + 版本守卫）；providers.json 明文剥离 + 0600 原子写；redactSecret 覆盖全部 SSE 错误出口；日志侧 maskKeys 双防线。**未发现泄漏面。**
5. **git spawn 注入**：全部数组形式免 shell；ref 段白名单编码；ENOENT 分平台人话提示；无凭据经 argv。**零注入面。**
6. **迁移不覆盖作者数据**：v2/v3 布局迁移同名跳过记档 + moved 子树过滤；默认值清理值等值才删 + 保注释保未知段；事件库迁移墓碑原子 + 失败逆序回滚。**未发现覆盖路径。**
7. **前端 XSS**：三目录 v-html/innerHTML/insertAdjacentHTML/document.write 全 grep 零命中，一律插值渲染。

---

## 八、建议处置（待作者指令，本批不执行）

1. **修复批建议**（P2×6 全修 + P3 择收）：P2 六件均有明确窄修法（§三各条），预估一波四路文件互斥修复代理 + 主审收尾可收口；P3 建议择收 §四标「择收」的 22 件（多数一行级），「登记」11 件记台账备查。
2. **回归门槛**：修复批按 L2 终门铁律（vitest 全量 + tsc/vue-tsc + eslint + 三 check + e2e）。
3. 本报告**未收口不归档**；收口后按文档操作链归档。

---

## 九、评审方法与范围披露

- **覆盖**：src 495 实码文件（.ts/.vue，113,185 行）全量逐文件读全 + 根直属 3 + 构建配置 6 + CI 工作流 2 + scripts 12（实测 12 件，任务书原写 13 已勘误）。
- **test/ 1179 文件（178,212 行）未逐文件精读**：测试面质量以全量套件实测（1126/7282+7 全绿）+ check:counts 对账 + CI coverage 阈值门兜底，如实记档。
- **门禁**：九件套主审亲跑（§二）；coverage/soak/出包未复跑（CI 兜底，如实记档）。
- **纪律**：九路子代理三波派发（在途 ≤4/波，作者纪律）；全程只读零修改；既有评审文档零读取（独立性）；主审亲验 P2×6 全部 + 待核 P3 抽验 7 件（成立 5 / 销案 2）。
- 台账联动：本报告 P2×6 + P3「登记」件待修复批处置后按文档链回填台账。

---

## 十、收口记（2026-09-14 全库重评修复批）

- **作者指令**：「全部修复！」（后续「继续」×2 续批）。
- **处置总账**：P2×6 全修 + P3 择收 25 件全收 + 登记 8 件处置（7 件维持登记 + #33 RAG 重建外部闸依赖头注显式化落地）+ 销案 2 条维持销案。**记正**：§八 prose 曾写「择收 §四标『择收』的 22 件 /「登记」11 件」系笔误——§四 表逐行实为**择收 25 / 登记 8**（25+8=33，与表逐行一致），本批按 25 件执行。
- **P2×6 处置明细**：
  1. **P2-1〔server〕**：裁决端点挂 `reviewRunning` 409 闸（`REVIEW_RUNNING` 同码同文案对齐同文件三审端点自身闸；不排队——排队会把旧 verdict 在完成写之后覆写回去、时机不可预期；R-16 写前重读保留不动）；回归 = `r0914b-review-verdict-gate` 2 用例。
  2. **P2-2〔document〕**：doCopy 归一后 `relSegs.includes('..') || includes('.')` 双拒（口径对齐 normalizeMoveToDir）；回归 = `r0914b-copy-dot-seg` 2 用例。
  3. **P2-3〔web〕**：healResult 消费面上移 WorkspaceShell 常驻层（比照 R27-77 wb.warning 同型先例）；缓存刷新语义抽 `shared/doc-freshness.ts` 单源（WorkbenchView 局部副本删除改指，防双份漂移）。
  4. **P2-4〔web〕**：铁律收起分支加 `rulesDirty` danger 确认（「收起并丢弃」，取消则不收起），对齐 OnboardView R8a-P2-2「手改未保存不静默丢稿」口径。
  5. **P2-5〔process〕**：归档写侧去时间戳化——同 tag 已存在标准名时读旧 + 按键（leadId+动词）合并重写（新证据覆同键旧值、旧序保留、新键追加）；旧档读失败/新档零有效条目回落时间戳变体（L-P6 两代保全不破坏）；回归 = `r0914b-lead-archive-merge` 4 用例（含读侧闭环 `readChapterUpdatesForChapterChecked` 可见性钉定）。
  6. **P2-6〔rag〕**：openRagDb 对齐 events 侧 N3——`busy_timeout` 前置 + WAL 切换 8 次线性退避重试（已切 wal 短路；损坏错误立即上抛不误判删库链，R73-48 fail-closed 出口）。
- **P3 择收 25 件全收**：明细随代码注释「全库重评-0914 P3-N」锚逐处落地（ai 2 / server 1 / desktop 5 / document 2 / format 2 / web 12 / process 1——web 含 `api/stream.ts` → `api/workbench.ts` 改名：3 处 src importer 改指 + 22 个测试文件 import 改指、测试文件同步改名 `api-workbench.test.ts`）；回归 = 新增 8 件 `r0914b-*` 用例文件 21 用例 + `service-struct` N-11 面 +1 用例（宽分隔符前缀）+ 既有 webnext 套件兜底。
- **登记 8 件处置**：7 件维持登记（#3 ai contract 枚举域外值 / #8 calibrate-tokens argValue〔归并既有 G 域行〕/ #14 lead-finalize lock-timeout 死码〔拍板意图〕/ #15 writePieceList 零接线〔归并既有 E 域行〕/ #29 isWithinRoot 不对称 / #31 rosterNamesCache 无 forget / #32 chat-bridge sourceIdxs）；#33 头注显式化落地（`rag/index.ts` 依赖登记头注）；台账 §三 回填 E×2 / F×2 四条。
- **编排与实抓（如实记档）**：波 1 四路文件互斥修复代理（A 服务端+机检+RAG+进程搜索 / B document+format / C desktop+脚本+配置 / D ai 适配器；在途 ≤4）——B 路撞 5 小时用量限额阵亡、阵亡前改动已落盘，余量由主审接续并逐 diff 复核零回退；主审另亲修 web P3 十二件 + P2-3/P2-4/P2-5 三件。**主审改道两件**：P3-11 实施取「识别单源化 + 前缀原文保留」而非位宽归一（N-11 既有 verbatim 契约不破坏——首版实现把 `1-` 归一成 `001-` 被 N-11 回归当场抓出后修正为原文保留，并补宽分隔符回归用例）；P3-21 doc.ts 五处非空断言改 fail-closed 守卫后，r29 四个用例需补 `doc.setBook('书A')` 种子（生产侧 Book.vue 路由 watch 保证非空，测试装置补种子非产品回退——临时中和守卫验证 8/8 通过后定谳）。另：e6-heartbeat 两条 DELETE 断言随 `signal` 增参放宽为 `objectContaining`。
- **L2 终门（主审亲跑，darwin 实机）**：vitest 全量 **1134 文件 = 7304 过 + 7 跳 0 败**（净增 8 文件 / +22 用例：8 件全 `r0914b-*` 无平台门，差值锚 80 口径不变）+ tsc / vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 1134/7304 / packaging / knowledge）+ e2e **49 过 + 2 跳**（38.1s）；根 README 修账五处（徽章 / npm test 行 / 门槛行 / win 预期行 / 技术栈行）后 `check:counts` 复跑过。coverage / soak / 出包未复跑（CI 三腿矩阵 + 上批 L2 记录兜底，如实记档）。
- **文档链联动**：台账 §一 行收口改写（原行冻结 `Archive/台账历史明细-归档-2026-09-08.md` §十七）+ §三 P2×6 处置回填（含落盘批登记位置纠偏：P2-3/P2-4 移 C 域、P2-2/P2-5 移 E 域、P2-6 移 F 域——落盘批原行落于 D/F/G 邻域，与册注「按域入 B/C/E/F」不符，随处置回填归位）+ P3 批注收口（22/11 记正为 25/8）+ 登记四条回填（E 域 isWithinRoot·chat-bridge sourceIdxs / F 域 rosterNamesCache·RAG 重建外部闸）；总览 §1.3 行收口改写（原行冻结 `Archive/总览历史明细-归档-2026-09-08.md` §十七）。
- **归档**：本报告正本移入 `Archive/`（扁平）；`Archive/README.md` 批记行 + 当前含篇数 31 → 32。

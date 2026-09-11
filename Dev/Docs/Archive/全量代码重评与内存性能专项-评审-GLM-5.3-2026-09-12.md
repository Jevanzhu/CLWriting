# 全量代码重评与内存性能专项-评审-GLM-5.3-2026-09-12

> 〔收口与归档〕2026-09-12 修复批收口（作者指令「全部修复，编排下任务做。」）：P2×4 全修 + P3 随批收 38 / 维持登记 9 / 单立 1，主审逐 diff 复核（修正 1 处）+ L2 终门九件套亲跑全绿（1055 文件 = 6767 过 + 80 跳 0 败）——收口记 = 本报告 §十一；同日头注补记后 git mv 归档 `Archive/`（扁平，历史正文不改写）。

- 日期：2026-09-12
- 执行模型：**GLM-5.3-Flash**（主审）。子代理 10 路次同模型分域并行（波 1：A 桌面壳 / B 服务端 / C1 前端数据层 / D AI 链路；波 2：C2 前端组件 / E 核心持久化 / F 机检文本流程 / G 域中途被停后拆 G1 RAG知识 + G2 测试CI 重派——见 §七 编排记录），主审逐条对码核证全部 P1/P2 候选（含一项本机实测复现）并亲跑 L2 终门。
- 评审基线：分支 `win`，HEAD `9d78e6fe`，**工作树含在途未提交批**（80 文件跟踪改动 +635/−2024 + 3 新增源文件 + 1 新增测试，即同日《专项精简优化》批的落地增量，账目经主审独立复核吻合，见 §二）——评审对象 = 磁盘现状。
- 评审范围：`src/**` 全量（108,055 行 TS/Vue：363 .ts + 106 .vue，其中 studio/server 12,455 行 50 文件、web-next 38,589 行 192 文件、ai 13,615 行、desktop 4,815 行）+ `test/**`（1050 个 .test.ts ≈16.2 万行用例）+ scripts/ 治理脚本 + 双 CI 工作流 + 打包配置。
- 方法：按作者指令**忽略全部既有评审文档**（子代理纪律禁止读 Dev/Docs/），八域文件互斥并行逐文件完整读 + 主审横向模式扫描（定时器/监听器/模块级缓存/流缓冲/SQLite 生命周期）+ 主审逐条核证。台账（挂账登记表，非评审文档）仅用于区分「新发现 vs 已知挂账」，代码判断全部独立作出。
- **作者指令**：「忽略现有的评审文档，重新评审一遍项目所有代码，注意查找内存泄露和性能问题，以及代码的优化和精简问题，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务。」——本报告为**独立重评第十篇**，全文不引用、不继承任何既有评审结论；一切判断来自代码与实测。

---

## §一 结论摘要（三问直答）

| 问 | 答 |
|---|---|
| **完成进度** | **≈97%**。产品功能面全部收口（唯一开放任务 = 总览第三节阶段 24「章节结构操作」，执行方案已落盘、实施待作者指令）；测试/CI/打包门/文档链全部闭环运转。余量 = 阶段 24 未开工 + 台账 60 余条挂账（其中真开放待拍板仅 5 条，其余均为【维持】/【有意】/【单立】备案）。 |
| **完成质量** | **A−**（与上一轮持平）。0 P1 / P2×4（全部窄条件面：mac 打包态 / 高位机检配置 / 手编 manifest / 大书缓存窗）——无一伤及默认路径主链；内存泄漏轴九域全量对码**零新发现**（历史 ephemeron 环修复经 10 处开库点逐一核验闭环）。不给 A 的理由：A-P2-1 系上一修复批自身引入且回归门反向锚定错串（假绿）——「修复落地后打包态未实测」的流程缺口二次显形；F-P2-1 系既有回溯修复两次只封主通道的残余向量。 |
| **可否精简优化** | **可以，产品侧约 700–830 行可直接回收（≈107k 的 0.7–0.8%）+ 测试侧约 1100–1900 行**；另有约 610 行「有决策记录的刻意保留」非活代码（登记性，不构成欠账）。大头在前端组件模板/CSS 重复面（C2 域 ~490–570）与测试造书脚手架参数化（G2 域 ~800–1500）。无一处建议为删而删——每项均给出消费面核证。 |

L2 终门九件套主审亲跑**全绿**（win 口径，详见 §九）：vitest 1050 文件 = 6739 过 + 80 跳 0 败〔323.50s〕+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过 + e2e 43 过 2 跳〔50.4s〕+ soak 两段绿（−0.02MB / +0.06MB）。

---

## §二 评审对象与基线账目

- HEAD `9d78e6fe`（fix(review): 重评修复批，win 分支最新）+ 工作树在途批。
- 在途批 = 同日《专项精简优化-评审-GLM-5.3-2026-09-12》（01-评审/ 第九篇，并行会话产物）的执行增量。按作者「忽略现有评审文档」指令，本评审**未读该报告**，但对工作树改动逐块独立核证：
  - 产品侧净 **−882 行**（跟踪改动 +481/−1437 + 新文件 74 行）——报告称 −881，一位误差系统计口径（尾行换行符），账实吻合；
  - 测试侧净 −577/+137 = **−440 行**显改 + 2 整删文件（r1w11/r47 各 ~107 行）≈ −207 按净文件口径吻合；
  - 删除项零残留抽查 10 项全过：snapshot.ts 别名层 / enableRag+writeApiKey（活替代 = config PATCH 端点，SettingsBookAnalysis 实测走该路径）/ unlinkWithRetry / formatStyleReport+width / leadUpdatesInScopeForChapter / buildOutlinePrompt 薄壳 / getAnalysisEnvelope+runAnalyze / useDebouncedSource / ProviderRow busy prop / learn 测试注入钩子（钩子与生效值全仓零消费）——`grep` 全仓（src+test）零引用，测试面已同步直写复刻或同删；
  - 单源化项核证：`src/async.ts` yieldToEventLoop 六处导入方接线（progress.ts re-export 保持 import 面）；`chapterInput`→shared.ts（leads.ts 漏网第三份，见 D-P3-5）；`sigStatFor`→rhythm.ts 三处归一；prefs 33 setter 表驱动 + 233 行钉界锚测试；SettingItem/SettingToggle 新组件 55 块抽取（C2 域核证**无遗漏点**，唯一同名异形残留 ContextQuickPanel.vue:66 不属抽取对象）。
- 测试基线（主审实跑）：1050 测试文件 / 6739 过 + 80 跳 0 败 / 29 e2e spec 45 用例。

---

## §三 P2 发现（4 条，全部主审对码核证）

### A-P2-1｜electron-builder asarUnpack 通配缺 `dist/` 前缀——上一修复批的 mac 打包态字体外置实际无效，且配套静态门锚定同款错串（假绿）

- **位置**：`electron-builder.yml:20-21`（`asarUnpack: - desktop/fontlist`）；连带 `scripts/check-packaging.mjs:153` covers 判定与 `src/desktop/font-cache.ts:268-274`（darwinFontListCommand 期望 `app.asar.unpacked/dist/desktop/fontlist`）。
- **证据链（主审复核成立）**：`files: dist/**/*` 决定 asar 内路径为 `dist/desktop/fontlist`；app-builder-lib@26.15.3 的 FileMatcher 以 appDir 相对路径做 minimatch（子代理读上游源码并以同款 Minimatch 实测：`desktop/fontlist` 对 `dist/desktop/fontlist` 恒 false）→ 二进制留 asar 内；而运行时 `bin.replace('app.asar'+sep, 'app.asar.unpacked'+sep)` 保序替换产出 `app.asar.unpacked/dist/desktop/fontlist` → 必 ENOENT → 自管 spawn 落 `fontListSetupFailure` → 回落 load（execFile 找 `__dirname/fontlist` 亦在 asar 内）→ 再回落 system_profiler 慢路径——正是上一批 R0911-A-P2-1 要消灭的「打包态慢路径→超时熔断→字体下拉返空」形态。`check-packaging.mjs` 第四层门 `covers = entry === 'desktop/fontlist' || entry.startsWith('desktop/fontlist/')` 与错误配置互为印证：**配置改对了门反而会红**。
- **定性**：P2（mac 打包态真实功能回归，有三级降级链故非 P1；win/linux 腿 dist 无此文件零命中不受影响）。这是「上批修复批」引入的缺陷——修复批对 asarUnpack 生效性的验证停留在静态门，未做 `build:desktop:dir` 实测落位。
- **修复**：yml 改 `- dist/desktop/fontlist`；同步改 check-packaging covers 判定与锚定测试；以 `build:desktop:dir` 实测 `app.asar.unpacked/dist/desktop/fontlist` 落位 + darwin 真机字体下拉（台账既有【单立·打包态实测】项随之收口）。

### B-P2-1｜五处 TTL 缓存「出生即折旧」：`ts` 取计算开始时刻而非写入时刻，大书有效缓存窗被计算时长吃掉

- **位置**（五处同型，主审逐一核实在位）：`api/state.ts:66→118`、`api/overview.ts:142→170`、`api/check.ts:170→212`、`api/health.ts:56→75`、`api/knowledge.ts:110→128`——全部是「捕获 `now` → await 秒级全书计算 → `set(k, {…, ts: now})`」。
- **后果**：这些缓存 TTL 均 5s 档；大书计算 2–4s（health/overview 注释自认）→ 有效窗压缩到 1–3s，计算时长 ≥ TTL 时**写完即过期、缓存完全失效**（每次重扫 + 白写）。多窗口/轮询场景退化为重复全书扫描。同文件族已有九处（rhythm/settings/overview 二处/foreshadows 二处/snapshots/search/analysis 二处）改用 `ts: Date.now()` 的既修纪律，此五处为同批漏网。
- **定性**：P2（真实性能缺陷，非风格挑剔；`ts: now` 计算前时刻无任何语义优势）。主审边注：扫描起点时间戳理论上可辩解为「保守陈旧语义」，但九既修处的存在证伪该辩护——就是漏网。
- **修复**：五处 set 行 `ts: now` → `ts: Date.now()`，五行改动零风险（`now` 仍可用于命中判断）。

### F-P2-1｜adjStack 嵌套量词残余回溯向量：4–7 连「的」游程 × 高位 maxAdjStack，实测 12KB 病理正文 18 秒同步阻塞（主审复现坐实）

- **位置**：`src/check/count.ts:736`（正则本体）、`:750`（守卫 `DE_RUN_SPLIT_RE = /的{8,}/`）、`src/format/iron-rules.ts:45`（clamp [0,20]）。
- **机理**：`(?:[汉字]{1,6}的(?:[、，,]\s*)?){N+1,}` 中「的」∈ HANZI 字符类 → 单元分解歧义；既有守卫只切 ≥8 连「的」游程，**4–7 连游程**（每游程 2–8 种分解）不在守卫内；maxAdjStack 高位（clamp 允许 20，脚手架默认 3）+ 「总单元数恰差几个」的失败形态 → 每起始位探索全部分解组合，指数爆炸。
- **主审实测（本机 Node，非转述）**：41 字符病理片段（5×7 连「的」+ 断链尾）@maxAdjStack=20：现状守卫 **469ms**；守卫收紧 `/的{3,}/` 后 **0.1ms**（~4700 倍）。F 域代理另测 12KB 正文混 20 病理簇：18,350ms 同步阻塞（与主审数据线性吻合；该调用在扫描管线内不可被 25 章让出中断）。正常文本（合法 25 单元堆叠）两组守卫命中一致（hits=1）且 <0.1ms——**修复零语义损失**。
- **定性**：P2（条件触发：高位书级配置 × 病理正文——但触发面是作者自己配的合法值区间 + AI 生成体/粘贴事故均可产生病理文本；18s 同步阻塞足以卡死服务事件循环上的全部请求与 SSE 心跳）。系 R27-23（clamp）与 R46-46（{8,} 守卫）两次修复只封主通道的残余向量。
- **修复**：`DE_RUN_SPLIT_RE` 由 `/的{8,}/` 收紧为 `/的{3,}/`（一行；≥3 连「的」必非合法定语堆叠，与既有守卫同一丢弃理由，界收到歧义起点 c(2)=1 以下），补钉值测试。

### G1-P2-1｜knowledge manifest 为 JSON 字面量 `null` 时校验/登记链 TypeError 崩，穿透 KnowledgeManifestReport 信封

- **位置**：`src/knowledge/manifest.ts:67-69`（`JSON.parse("null")` → null 不抛，`ok: true, manifest: null`）、`:76`（守卫只查 `=== undefined` 漏 null）、`:81`（`manifest.version` → TypeError）；`src/knowledge/update.ts:180-184`（同型崩点）。
- **主审核证成立**。JSON 顶层各标量中唯一崩点即 `null`（`123`/`false` 装箱取属性得 undefined 不崩）。违背本模块自设口径——R73-4 刚把「entries 非数组」从裸崩改形状守卫，「manifest 本体非对象」是同款漏网。触发面：手编辑/半写 `_manifest.json` 存成 `null`（低概率可构造）。
- **定性**：P2 中低（契约破坏 + 与自设守卫纪律相悖；触发概率低）。
- **修复**：`readKnowledgeManifest` 单点收口——parse 后 `manifest === null || typeof manifest !== 'object'` → 返 `{ ok: false, issues: […] }`，约 3–4 行；两处消费方守卫不动。

### P2 归并与定性说明（不新立缺陷账）

- G2 域报的「e2e 29-spec 顺序契约 + 单一共享 workDir，单 spec 故障级联连坐」：经查为**台账既有登记行**（§三 G「维持」项——架构级耦合，缓解三重守卫已立：顺序快照门 + 运行期 reporter 探针 + check-counts 静态比对；主审本轮独立核证守卫在位）。维持既有定性，不重复立案；独立 fixture 化（7 spec 已迁先例）维持【单立】方向。
- G2 域报的「makeBook 造书脚手架 78 文件复制」（主审 grep 复核实测恰 78）归入精简总账测试侧大项（§五），不属缺陷。

---

## §四 P3 发现（分域清单；含精简、观察、登记三类）

**A 域（桌面壳 6 条）**
- A-P3-1 `initial-book.ts:16-21` initialBookArgvOnly 与 initialBookArg({allowEnvFallback:false}) 逐位等价，删一（~10 行）。
- A-P3-2 `server-manager.ts:586-593/627-634` stopChild/shutdown 的「预算耗尽→kill 在途 fork」块逐字同构，提取闭包（~8-10 行）。
- A-P3-3 `font-cache.ts:161-219` × `win-fonts.ts:91-140` spawn+超时+结算骨架结构性重复，参数化合并（~30-50 行；保持两套测试注入口径）。
- A-P3-4 `server-manager.ts:395` 崩溃封顶决断链无 .catch——onRestartExhausted（内含 dialog.showMessageBox 的 async 回调）reject 时决断永久落空（不重启不退出无对话框）。补 .catch 兜底终态。
- A-P3-5 `main.ts:1184-1186` bootstrap 的 storeCache 整覆赋值窄竞窗：registerIpc/buildMenu 先于 runBootstrap，冷启动 await 窗内菜单链写盘后内存面被旧 store 过滤结果回滚（磁盘正确、后果有界）。过滤结果仅回填 recent 字段即可。
- A-P3-6 `main.ts:1681/1947` 无插值反引号模板串日志改单引号（2 行）。
- 内存/性能轴结论：泄漏零发现（trustedSenders 随窗摘除、计时器单槽排新清旧+unref、restartTimer/startingProc/waiters 全有清理路径、零 setInterval）；启动同步 IO 全有界或预算防线；readBooks 指纹缓存/字体 60s TTL+熔断在位。

**B 域（服务端 2 条）**
- B-P3-1 `api/review.ts:291-296` review-verdict 无条件整章同步读盘，而 body 仅在信封链全空时兜底 sourceHash——常态白付（惰性化到兜底分支）。
- B-P3-2 `bookMovedFailure` 四处同构（documents/style/knowledge/config 各 ~9-16 行含头注），归一 book-context.ts（~35-50 行；先例 revision-guard X-25）。
- 已核伪不报：progress.ts 同步 computeProgress（测试等价 oracle 面惯例）；书架 30s 不可见疑虑（shelfGuardCache 有正向失效）；chat-history 全量投影（契约必需已流式化）。
- 内存/安全轴结论：SSE 全生命周期清理、四层互斥矩阵、缓存族 FIFO+指纹+forget、readJson 1MB/30s 双限——零缺陷。

**C1 域（前端数据层 5 条，无 P1/P2）**
- C1-P3-1 `stores/check.ts:31,78,104,139` lastDocId 死字段（全仓零消费，守卫由 opGen 承担）——删 ~4 行。
- C1-P3-2 `stores/review.ts:25,49,81,101,118` lastDocId 同型死导出（职能已由 lastLoadKey 承担）——删 ~5 行。
- C1-P3-3 `api/books.ts:29-45` getConfig 与 getConfigWithRevision 同端点双函数——getConfig 委托后者（净 2-3 行 + 消重复端点声明）。
- C1-P3-4 api 层 53 处 `headers Content-Type + JSON.stringify` 成对样板——apiJson 增 `json` 选项（净 ~40-55 行）。
- C1-P3-5 OverviewView/AuditView 每进入全量重拉无节流——可选轻量 TTL（非缺陷，最低优先）。
- 内存/性能轴结论：竞态三件套（gen token + 书名捕获复检 + inflight 台账）与内存封顶（doc LRU 20/chat 200/audit 2000/textOut 1M 码元）全覆盖；SSE/心跳/autosave/window 监听全成对清理——零泄漏实锤。

**C2 域（前端组件层 7 条，无 P1/P2）**
- C2-P3-1 `ChatMessages.vue:128-148` variantGroups O(消息×分支) 嵌套 find+重复 sort——单趟区间索引 + Map 缓存变体组（热路径优化非缺陷）。
- C2-P3-2 `TierSection.vue:72-209` 三张 tier-card 模板逐字同构——抽 TierCard 子组件（~80-90 行）。
- C2-P3-3 style/ 四文件 `.panel`/`.btn-*`/`.kind-badge`/`.token-chip` CSS 逐字重复（注释自认同式）——建 style-shared.css（~150-180 行）。
- C2-P3-4 ChatPanel × ChatDock composer 模板+~150 行 CSS 双份（逻辑层已共享 useChatComposer）——抽 ChatComposer（~150-180 行）。
- C2-P3-5 ShelfHeroCard × ShelfModalHero hero-list 段重复（~70-80 行）。
- C2-P3-6 ReviewPanel/CheckPanel 红/黄两组 item 模板逐字重复——v-for 化（~40 行）。
- C2-P3-7 `SettingsAi.vue:58-59` 空 style 块 2 行。
- 内存轴结论：92 文件零缺陷（capture 监听/定时器/rAF/轮询全成对清理）；在途 SettingItem/SettingToggle 抽取批核证**无遗漏点**。

**D 域（AI 链路 6 条，无 P1/P2）**
- D-P3-1 `prompts/chat.ts:238,247-248` + `prompts/compaction.ts:68,72-73,118` 码点计量 `Array.from(text).length` 全量物化数组——chat 轮循环热路径每轮全历史重复分配（长会话十几万元素瞬时数组/轮，纯 GC 垃圾）。就地改写零分配计数循环（±0 行，收益在分配压力）。
- D-P3-2 `orchestrate/chat/turns.ts:576`（resolveProvider 在 for 循环体内单会话 5 遍）、`:680`/`finish.ts:122`（chatTools.map 每轮重算）、`runner.ts:647,688`（已收窄分支内冗余 instanceof）——微开销清理（净 2-3 行）。
- D-P3-3 三适配器 tool_choice 意图翻译块三份同构（openai:188-209/anthropic:155-176/responses:151-165）——抽共享意图解析器（净 ~25-35 行 + 口径单源）。
- D-P3-4 `gen.ts:104-132` withFirstByteTimeout 每 chunk 新建 Promise+setTimeout（正确性无虞，数千 chunk 数千次瞬时分配）——可选 timer.refresh() 模式。
- D-P3-5 `tools/leads.ts:9-10` 手抄章号校验——单源 chapterInput 漏网的第三份，接入（净 1-2 行）。
- D-P3-6 登记性：catalog 三件套 ~454 行 + writeChains 排队分支 ~60 行，均运行时零消费但**有决策记录的刻意保留**（A7 预建资产 / 锁异步化接管面）——不计入可删账，随 A7/锁改造拍板回收。
- 内存轴结论：driver 三队列上限、chat histories LRU 四 Map 同步清、有界缓存族、abort/deadline finally 摘除——零泄漏。

**E 域（核心持久化 6 条，无 P1/P2）**
- E-P3-1 `service.ts:337,436` executeSave 热路径回收站清单双重全量读盘（trash.ts 零缓存；量级 0.1-0.5ms/次故 P3）——仿 manifestCache 加单槽指纹缓存（+12-15 行换热路径）。
- E-P3-2 `version.ts:236→356→612` writeVersion→pruneVersions 链 listVersions 重复整目录扫描——pruneVersions 增可选入参（净 −3 行）。
- E-P3-3 `events/store.ts:1258,1267` migrateBookSession checkpoint 连接裸 close——违反本文件自设「close 一律走 closeEventsDb」纪律（事实安全：未入 prepared 缓存，构造上无 ephemeron 面，但属纪律地雷）——改 `closeEventsDb(cp)`（1 行加固）。
- E-P3-4 `service.ts` 21 处 `return Promise.resolve({...})` 冗余包裹（async 内直返等价）——风格收敛净 0 行。
- E-P3-5 登记性：生产零调用的同步孪生/仅测试导出五族（finalizeRevisionImpl ~40 / writeAnalysis 同步壳 ~30 / appendEvent+latestSession ~16 / loadLeadFromCache ~34 / getGoal 等 ~13）合计 ~130 行——均有成文保留理由（测试 oracle/CLI 预留），列可选收编不构成欠账。
- E-P3-6 `export/index.ts` 函数体插 import 区之间（下移零风险）+ `:306` 纯别名行（−1）。
- 内存轴结论：**SQLite ephemeron 史伤修复核验全覆盖**——closeEventsDb 三条关库路径齐备、全域 14 个模块级缓存逐一验证有界（manifestCache 32/md-text 4096+64MB/chapterCache 2048/log 队列 1024 背压…）、worker settle-once+terminate、rebuild.ts 裸 close 不经缓存助手构造安全。

**F 域（机检文本流程 3 条 P3 + 2 条 P2 见 §三）**
- F-P3-1 `check/count.ts` 同一 body 的 stripQuotedSpans 每章 6 次重复全文剥引号（产出恒同）——runner 每章一次传入或 2-slot memo（~10-15 行，收益在口径心智负担）。
- F-P3-2 `check/count.ts:447` checkNewNames 名册线性查——改 Set（1 行）。
- F-P3-3 `process/settings-injection.ts:31-33` cpLen 与 summary.codePointLength 双实现（更优解 = codePointLength 下沉轻量层反向收编全仓 5 处 Array.from().length 写法，~3 行）；`format/manifest.ts:45` writePieceList 生产零接线 ~14 行（作者已备案，删否属拍板项）。
- 内存/性能轴结论：模块级缓存全 FIFO/TTL 上界、正则常量化纪律严格、HTTP 长链 async 孪生+让出——默认配置下零功能性错误。

**G1 域（RAG/知识/学习 7 条 P3 + 1 条 P2 见 §三）**
- G1-P3-1 `rag/store.ts:89-94` 唯一裸 `legacy.close()`（checkpoint 段；构造安全——未入 prepared 缓存）+ `:236-239` prepared() 头注宣称「close 后随 GC 消失」**与 ephemeron 环实测结论直接矛盾**（该注释未随修复批更新，会误导维护者拆除断链）——改 closeRagDb + 修注释（3 行）。
- G1-P3-2 `rag/store.ts:482,536,574` 召回热路径 3 条固定 SQL 绕过 prepared() 缓存每次重编译（µs 级微开销，一致性为主）——各改 1 行。
- G1-P3-3 「吞 ROLLBACK 自身异常」样板 5 处同构（index.ts ×4 + store.ts ×1）——提 safeRollback（净 ~12 行）。
- G1-P3-4 登记性：readAllChunks + recall() 包装 ~79 行生产零调用仅测试消费——维持既有「暂不收」判断，测试面改造后可回收。
- G1-P3-5 `learn/index.ts:243` `hasHook && hasEmotion || (hasContrast && hasEmotion)` 依赖优先级且重复——改写 `hasEmotion && (hasHook || hasContrast)`（1 行）。
- G1-P3-6 knowledge 登记链 O(N) 全场重校验 + md 条目双读（低频手动操作有对账语义理由）——观察不动。
- G1-P3-7 `rag/store.ts:184-186` deleteRagDbFiles 对 TOCTOU 窗口 ENOENT 误报失败（重跑可愈）——unlink 循环 `if (code === 'ENOENT') break`（2 行）。
- 内存轴结论：**10 处开库点全部配对 closeRagDb 核验通过**（含损坏自愈二次开库与双段开库每个早退）；BLOB 用后即弃、watchdog 生命周期、ragBuildTasks 删书清理、lastWarnAt FIFO——零泄漏。

**G2 域（测试/CI/工具链 5 条 P3 + 2 条 P2 见 §三/归并说明）**
- G2-P3-3 最小 driver 假件 20 文件各一份 + tempUserData 6 文件本地定义（fixtures.ts 已有同名导出）——提 test/helpers 单源（~300 行）。
- G2-P3-4 真睡眠存量 ~19s 合计且 ≥400ms 仅 2 处正当；22 处固定睡眠负窗断言有余量注释——逐步换 waitFor 负向轮询（<100 行 + 秒级墙钟，无迫切 flake 证据）。
- G2-P3-5 `desktop.yml:63-64` win 腿裸 `npm test` 无 tinypool 收尾竞态重跑兜底，与 ci.yml:109-123 专用步**不对称**（主审核证在位）——tag 出包门假红风险，复制同款重跑块（或上游修复后两处同撤）。
- G2-P3-6 check-counts 全量 `vitest list` 在 7 条 CI 腿重复执行，mac/linux 断言完全相同——二选一省分钟级时长（门语义不变）。
- G2-P3-7 `test/desktop/main.test.ts` 2583 行 god-file，135 用例共享可变 M + 显式顺序依赖注释——按关注点拆文件（纯结构，0 行精简；台账既有行随 H 档三）。
- 正面核验：死测试零残留（7 个已删产品符号 test/ 零 import）；59 个写 env 测试文件全带还原；门禁全部接线真实（含反向守卫）；flaky 防线机器闭环。

---

## §五 精简总账

| 档 | 内容 | 估算 |
|---|---|---|
| **产品侧·可直接回收** | C2 组件模板/CSS 重复面（TierCard/style-shared/ChatComposer/hero-list/Review·Check 分组）~490-570 + B bookMovedFailure 归一 35-50 + C1 api 样板与死字段 50-65 + A 三件 50-70 + D tool_choice 归一与杂项 30-40 + E/F/G1 杂项 ~40 | **约 700–830 行（≈产品代码 0.7–0.8%）** |
| **产品侧·登记性保留（不构成欠账）** | D catalog 三件套 ~454（A7 预建，`generate:catalog` 全可再生——若 A7 流产建议删）/ writeChains 接管面 ~60 / E 同步孪生五族 ~130 | ~610 行随拍板回收 |
| **测试侧·机械批** | makeBook 族参数化（78 文件实数）800–1500 + makeDriver/tempUserData 单源 ~300 + 负窗轮询化 <100 | **约 1100–1900 行（≈测试面 0.7–1.2%）** |
| 结构项（随重构批） | 13 件 >800 行拆分（main.ts 2224/service.ts 1958/events store 1360/yaml 1164/count 1096…）、ai→studio 反向依赖解环（台账既有单立）、main.test.ts 拆 | 不计行数 |

合计可回收 ≈ **1.8k–2.7k 行**。在途批（同日第九篇）已收走 ~1.1k 行（产品 −882 + 测试 −207 净口径）；本账为**其之上的剩余空间**。所有建议均经消费面核证，「不建议动清单」（foreshadow 孪生、测试 oracle 面等）见各域条目内边注——不为删而删。

---

## §六 内存与性能专项结论（作者重点轴）

**内存泄漏：零新增实锤。** 九域全量对码 + 主审横向模式扫描（15 处 setInterval 全对称清理且 unref/onUnmounted 齐、.on() 监听面逐点甄别——preload 四订阅全返退订函数、68 处 .on 均一次性 boot 注册或随对象销毁、模块级 Map/Set 缓存逐个验上限/TTL/指纹逐出）。历史两大伤（RAG/events SQLite ephemeron 环、前端 typeahead 定时器）的修复经本轮**逐一开库点/清理点核验全部闭环**；仅存的 3 处裸 close（cache/rebuild ×5 不经缓存助手构造安全、events checkpoint 1 处、rag checkpoint 1 处）均事实安全，已列 P3 纪律加固防回流。

**性能：3 条 P2 + 若干 P3 微项。** F-P2-1（18s 同步阻塞，条件触发）为唯一有体量项；B-P2-1（缓存窗折旧）影响多窗大书轮询场景；A-P2-1（打包态字体慢路径）为功能回归。其余为热路径微优化（码点物化、每 chunk 定时器、6× 剥引号、双 listVersions、O(N×M) variantGroups）——均有界、非瓶颈，列改写型优化不列缺陷。热路径防线（stat 指纹缓存族、让出粒度、worker 卸载、预存范数、部分索引）经核验系统性在位。

---

## §七 编排记录（如实记档）

- 波 1 四路（A/B/C1/D）+ 主审并行横向扫描与 L2 终门后台链；波 1 回齐后派波 2 四路（C2/E/F/G）。
- **违规与纠正**：波 1 未回齐时主审误派波 2，在途瞬时达 8（超作者全局指令「在途 ≤4」）——约 52 秒后察觉，四路全部 TaskStop 止损（未产出污染），波 1 回齐后波 2 重派合规执行。
- 波 2 的 G 域（RAG+测试 CI 合域）在途 ~11 分钟被宿主停止（未回报），拆为 G1（RAG/知识产品码精读）+ G2（测试/CI 结构性采样）两路重派，均正常回报。
- 全程在途 ≤4（两段合规窗口），主审逐条核证 P2×4（A-P2-1 读配置+运行时代码+门脚本三方对码；B-P2-1 五处逐一 in-situ 核实；F-P2-1 本机 Node 实测复现+修复对照+正常文本零影响验证；G1-P2-1 读崩点双文件核实）+ 在途批 10 项删除零残留抽查 + 精简关键断言（catalog 454/MODEL_CATALOG 零消费、makeBook 78、desktop.yml 不对称、deleteAiVersions 零调用）独立复核。
- 子代理纪律遵守：全部只读、未读 Dev/Docs（作者指令），发现必须对码，撤销候选如实记档（B 域 3 项/C2 域若干/G1 域 1 项）。

---

## §八 处置建议

1. **必修批（随下一修复批，建议一并）**：P2×4——F-P2-1 一行守卫收紧+钉值测试；A-P2-1 yml+check-packaging 门+锚测试+`build:desktop:dir` 实测落位；B-P2-1 五行 `ts: Date.now()`；G1-P2-1 单点 null 守卫 3-4 行。四条合计改动 <20 行，风险低。
2. **顺手批**：G2-P3-5 desktop.yml 重跑兜底对称（3 行 yml）；G1-P3-1/E-P3-3 两处裸 close 纪律加固 + G1-P3-1 失实注释修账（防 ephemeron 断链被误解拆）。
3. **机械精简批（可开工）**：产品侧 C2 四件抽取（ChatComposer/style-shared.css 优先——重复面积最大且单份事实源）+ B-P3-2 + C1 死字段；测试侧 makeBook/makeDriver 参数化。
4. **单立/拍板维持**：D-P3-6 登记性 610 行随 A7 与锁改造拍板；E-P3-5 同步孪生随测试面迁移批；e2e 顺序契约 fixture 化维持台账既有单立方向。
5. 结构项（>800 行拆分、ai↔studio 解环）维持既有建议不随小批动。

## §九 L2 终门实测（主审亲跑，win 口径，2026-09-12）

| 门 | 结果 |
|---|---|
| vitest 全量 | 1050 文件（1042 过 + 8 文件级跳）/ **6739 过 + 80 跳 0 败**〔323.50s〕 |
| tsc --noEmit / vue-tsc --noEmit | 0 错 / 0 错 |
| eslint --max-warnings 0 | 0 错 0 警 |
| check:counts | 过（1050/6739 + 29 spec/45 用例对账一致） |
| check:packaging | 过 |
| check:knowledge | 过（13 条 manifest 一致、无未登记资产） |
| e2e（build:web + playwright） | **43 过 2 跳**〔50.4s〕 |
| soak（--expose-gc） | 有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.06MB（上界 24MB）两段 OK |

与根 README 现声称（1050 文件/6814 单测 mac 口径；win 实测 6739+80）及 check-counts 对账全部一致。本评审**零代码改动**（纯评审 + 文档链）。

## §十 文档链同步记

- 本报告落 `Dev/Docs/01-评审/`（第十篇；同日第九篇《专项精简优化》为并行会话在途件，处置按 CLAUDE.md 评审链独立走）。
- 同步三处：`Dev/Docs/README.md` 计数 1→2、总览 §1.3 增行、台账 §一 增行 + §三 新登记（P2×4 与 P3 重点项按域并入；P3 全量以本报告为正本，台账只记路由）。根 README 无评审计数行，不涉及。

## §十一 收口记（2026-09-12 修复批）

作者指令「全部修复，编排下任务做。」→ 两波文件互斥编排落地（波 1 四路并发代理：A+打包+CI / B+D+events / C1+C2轻 / E+F+G1，全程在途 ≤4；波 2 单路 C2 组件抽取），主审逐 diff 复核全量；复核中主审修正一处——**C2-P3-1** 代理改法按 rootSeq 排序取区间首命中，与原 `find`（服务端 listBranches 的 lastSeq 降序数组序）在重叠区间极端场景口径漂移且锚注论据失实（「rootSeq 序即数组序」不成立），已改回沿原数组序并修正注释。

- **P2×4 = 4/4 全修**：A-P2-1 yml 补 `dist/` 前缀 + check-packaging 门随改（旧错误形态判红 + 反向锚测试）+ Minimatch 9.0.9 实证（darwin DMG 打包态实测仍挂台账既有单立项）/ B-P2-1 五处 `ts: Date.now()`（锚测试五用例，临时还原旧写法即红=证伪验证）/ F-P2-1 守卫 `/的{3,}/`（钉值测试 3 例；病理片段 469ms→0.1ms）/ G1-P2-1 manifest null/非对象守卫（3 用例含标量形态）。
- **P3 随批收 38**：A 域 6（A-P3-1/2/3/4/5/6）+ B 域 2（B-P3-1/2）+ C1 域 4（C1-P3-1/2/3/4）+ C2 域 7（C2-P3-1～7）+ D 域 5（D-P3-1～5）+ E 域 5（E-P3-1/2/3/4/6）+ F 域 3（F-P3-1/2/3）+ G1 域 5（G1-P3-1/2/3/5/7）+ G2 域 1（G2-P3-5）。选型差异与要点如实记档：**E-P3-2** 传 knownList 须补入新条目并按 listVersions 同款比较器重排——裸 append 会把新版本排到队尾被数量兜底当最旧误删（修复中抓出的真 bug，双档案等价性/幂等测试钉定）；**E-P3-1** 指纹取 size:mtimeNs（较 §四建议的 mtimeMs 失效覆盖严格更宽，锁内复核保真有测试钉）；**A-P3-4** 兜底 = 记错误日志保持不重启（deps 无 quit 钩子，quit 缺省语义即此）+ unhandledRejection 哨兵测试；**D-P3-4** 单 deferred + `timer.refresh()`（悬挂期显式 clearTimeout 解武装防滞留 rejected）；**C2-P3-3** 照 settings-shared 先例全局非 scoped 装载，`.panel` 全库八处声明逐字核对一致、kind-badge/token-chip 全库仅 style 四件——零视觉差核证；**C2-P3-4** 差异面实测 5 处（评审已知 2 + 新发现 3）由单一 glass prop 承载，R48-97 v-if 不渲染不实例化语义保持；**C2-P3-2** 捕获 Vue 3.5 缺省 Boolean prop 无 default 时被 cast 为 false 的三态失效坑（首跑被 tier-timeout 用例拦截，照 CollapseSection `open: undefined` 先例抑制）。
- **维持登记 9 + 单立 1**：C1-P3-5（可选轻量 TTL）/ D-P3-6（登记性 ~610 行随 A7/锁拍板）/ E-P3-5（同步孪生五族）/ G1-P3-4（readAllChunks 维持暂不收）/ G1-P3-6（观察不动）/ G2-P3-3（makeDriver/tempUserData 单源）/ G2-P3-4（真睡眠轮询化）/ G2-P3-6（check-counts 七腿二选一）/ G2-P3-7（main.test.ts 拆分，既有行）+ 单立 G2-P2-2（makeBook 78 文件参数化）。测试侧精简 1100–1900 与结构项（13 件 >800 行拆分 / ai↔studio 解环）不随本批，台账维持登记。
- **L2 终门九件套亲跑全绿（收口态，win 口径）**：vitest 1055 文件 = 6767 过 + 80 跳 0 败〔306.91s〕+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 1055/6767 + 29 spec/45 用例对账一致；packaging 含新门；knowledge 13 条一致）+ build:web 过 + e2e 43 过 2 跳〔43.1s〕+ soak 两段绿（有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.06MB，上界 24MB）。根 README 修账 1050/6814 → 1055/6842 四处 + win 实跑口径句更新（1055 文件 / 6767 过 + 80 跳，实测差 75 恒定保持——5 个新增测试文件均无平台门）。
- **改动面**：全树跟踪 src/test 148 文件（+1928/−3940）+ 新增 14 件（本批 5 源件〔tool-choice.ts / TierCard.vue / ChatComposer.vue / ShelfHeroList.vue / style-shared.css〕+ 5 测试件〔r0912- 锚〕；async.ts / SettingItem.vue / SettingToggle.vue / r0911-prefs-setter-table 系同日第九篇并行会话在途件）；两批同树不可分拆，收口 L2 以合并树亲跑（各批身份以 R0912-/R0911- 锚注释区分）。文档链收口：台账 §一 报告行移出（原行冻结 台账历史明细 尾续）+ §三 处置态回改 + H 行回改；总览 §1.3 移出（原行冻结 总览历史明细 §九 尾续）；本报告头注补收口归档记后 git mv 归档 `Archive/`（扁平）；`Dev/Docs/README.md` 计数 2→1；`Archive/README.md` 批记行 + 计数。

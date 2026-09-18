# 全量源码独立重评三轮（2026-09-18）

- **执行模型**：GLM-5.3（主审 = 会话模型；分域评审子代理 ×8 同为 GLM-5.3——第一波 4〔ai / studio-server / document·format·export·fs / desktop·driver·process·events〕+ 第二波 4〔web-next 逻辑层 / web-next UI 层 / check·metrics·review·state·cache·rag·knowledge·learn / install·git·log·shared·scripts·根配置〕，单波 ≤4；主审对 P2×2 全量与 P3×9 逐条对源码复核锚点，复核记 = §六）。
- **性质**：评审报告——**已收口**（2026-09-18 0918三轮修复批，作者指令「全部修复！」）——P2×2 + P3×9 全量真修（D204 拆半处置：noImplicitReturns 启用；exactOptionalPropertyTypes 实测全树 127 错超出单批搅动面按缓办处置、tsconfig 注留痕，G102 先例），L2 九门 mac 亲跑全绿，报告随收口批归档 `Archive/`（扁平）。评审批自身零代码改动（L0）。
- **基线**：git `1759b97a`（= 0918二轮修复批提交后树；一轮报告基线 `094043a1`、二轮 `4a3d5333`）。**工作树实况注记**：评审期间工作树存在**并行未提交批**（非本轮产物、非本轮所改——形态 = B004 章号双轨闸落地〔structure-core/structure-split/documents-core + 新测试 chapter-no-mismatch-gate，含 2026-09-18 作者拍板注「fail-loud 拦存量失配书」〕+ vault KEK 接 OS 钥匙链〔provider/vault 族 + os-kek 新件两域 + 迁移测试〕+ chat 失败回显族〔orchestrate/chat·finish·driver types·前端 chat store·ChatMessages〕，20 文件 +339/−27 + 新测试 7 件）。本轮 11 条发现中 10 条的锚点文件与其零重叠；B201 锚点文件 structure-split.ts 的并行改动仅 B004 闸接线（+9 行，不触及 B001 互斥与取号临界区），B201 机理对 HEAD 与工作树两口径均成立（本报告引用行号 = 工作树实读行号，与 HEAD 差至多 9 行）。本批自身零代码改动（L0）。
- **方法与纪律**：同日作者指令「忽略掉现有文档，重新评审下当前项目源代码，结果形成一个文档」的第三次独立重跑——评审全程不读 Dev/Docs 既有文档与一轮/二轮报告正本，各域结论独立产生；全部回收后主审才与两轮归档报告及其处置记对照，裁定本轮为**二轮修复后基线上的增量复评**（对照记 = §五）。分级同前：P1 = 正确性/安全/数据丢失必须修；P2 = 应修；P3 = 低危/一致性。核实不了的不报、风格偏好不报。
- **覆盖面**：`src/` 22 域全量（ai 14.0k 行 / studio-server 14.2k / document·format·export·fs 18.4k / desktop·driver·process·events 14.6k / check·metrics·review·state·cache·rag·knowledge·learn 11.5k / install·git·log·shared 4.1k）+ web-next 前端约 40k 行（stores·api·composables·editor·shared·types 逻辑层与 components·pages·views·styles UI 层两分）+ scripts 11 件 + 根配置七件（tsup/vitest/eslint/electron-builder/playwright/tsconfig/package.json）；`test/`（1302 文件）仅作行为语义参照，不作评审对象。

## 一、总体结论

1. **零 P1；两轮修复后已修项零复发**。一轮 P1×1/P2×11、二轮 P2×3/P3×36 的修复面在本轮 8 域不知情走查中无一被重新发现为缺陷（重点复核面 = 一轮 E001/E002 chat 回放与假忙、B001 进程内拆分互斥、B002/B004 章号定位与双轨闸、D002 providers revision 复验，二轮 A101 historyBudget clamp、E101 flushDirty、F101 二次 decode、B101 代理对守卫、B105 undo 续跑、G103/G104 books-repair 与 appendBook 收口——§五对照）。8 域子代理对「优点」的独立描述（原子写族、跨进程锁体系、竞态守卫单源化、SSE 生命周期、Electron 安全五件套、路径三重 fail-closed、日志三层脱敏）与前两轮画像互相印证，**主干防御密度未退化**。
2. **本轮增量 = P2×2 + P3×9**，全部为主审逐条源码复核证实。P2 两条：**B201** 章拆分取号临界区无跨进程互斥——一轮 B001 修复作用域为进程内（头注自书「进程内」，跨进程形态从未在任何一轮立项或宣称已修），双进程并发拆分同书可静默产生重复章号；**G201** books.jsonl 扫盘「新发现」分支无同名判重——R44-6/R74-10 两道同名防线只覆盖改名/重关联分支，两本未登记同名书（典型形态 = 手工复制书目录做备份）双双入账，删一书连删两条登记、第二本成无登记幽灵且不可自愈。
3. **发现面继续向边缘迁移**（与前两轮同构）：11 条全部落在既有修复的收窄残留（B201/A201/B202）、低频分支（G201/G202）、工具脚本人机工程（D201-D203）与配置补强（D204）；主链路四域（AI 编排 / server API / 事件存储 / 前端两层）中三域零发现，desktop 族仅 kill 升级链一处边缘不对称。
4. **安全面零新发现**：路径穿越/鉴权/SSE 生命周期/串行化（server 域专项）、XSS/输入丢失/监听器泄漏/竞态守卫（前端两域专项）、preload 暴露面/子进程生命周期（desktop 域专项）均核过干净。

## 二、增量发现汇总（P2 ×2 / P3 ×9）

| 编号 | 级别 | 域 | 标题 |
|---|---|---|---|
| B201 | **P2** | 文档数据 | 章拆分取号临界区只有进程内互斥——双进程并发拆分同书静默产生重复章号（B001 修复作用域残留） |
| G201 | **P2** | 书架登记 | books-repair 扫盘新发现分支无同名判重——两本未登记同名书双登记，删书连删两条登记且不可自愈（R44-6/R74-10 同族漏网） |
| A201 | P3 | AI 链路 | knowledge 注入已登记血缘，但未纳入「模型可见⟺已记录」抽样校验链——verifyVisibleSampled 签名缺 knowledge，CLW_VERIFY_VISIBLE 对该通道失明 |
| B202 | P3 | 文档数据 | 账本 fm `类型:`/`状态:` 空值 `??` 接不住空串，不回落默认值（R41-14 同型漏网：chapters.ts 已修、leads.ts 漏） |
| C201 | P3 | 运行时桌面 | 字体枚举子进程超时 kill 无 SIGKILL 升级、linux load 路径超时不杀——与本仓 server-proc kill 升级纪律不对称 |
| G202 | P3 | 书架登记 | init 半成品恢复的占用判重只查已登记书——大小写不敏感卷上 case 变体重试致同库双登记（R44-11 防线盲区） |
| G203 | P3 | 机检/指标 | `##` 标题识别口径分裂——metrics/collectBodyAnchors 与 check/count.ts 两正则不同源（紧排形式不识别 + 围栏内容误收） |
| D201 | P3 | 治理脚本 | corpus-commit 缺省语料目录按 cwd 相对解析——子目录直跑时语料落仓外、CI 回归门零新增且静默 |
| D202 | P3 | 治理脚本 | verify-responses-relay 错误出口未过脱敏——中转网关报错回显 URL 可带完整凭据打到终端，违反自身「输出永不回显完整 key」承诺 |
| D203 | P3 | 治理脚本 | electron-smoke 失败路径 console.error 后同步 process.exit——管道输出下（恰 CI 场景）日志尾可能截断 |
| D204 | P3 | 构建配置 | tsconfig 缺 exactOptionalPropertyTypes / noImplicitReturns——判别联合分支穷举无编译期兜底 |

## 三、P2 详报

### B201：章拆分取号临界区无跨进程互斥——双进程并发拆分同书可静默产生重复章号

- **锚点**：`src/document/structure-split.ts:11-15`（B001 头注自书作用域 = 进程内）、`:86`（互斥件）、`:183-226`（临界区）、`:190`（取号）、`:215-217`（新章路径与落位）；`src/document/structure-core.ts:172-185`（maxUsedChapter = 无锁扫盘）；`src/document/service.ts:919/935`（createDocument 仅按最终路径判重）。
- **证据**：互斥件是进程内 Map（structure-split.ts:86 `const splitApplyChains = new Map<string, Promise<unknown>>()`，头注明示「per-bookRoot 进程内串行互斥」）；锁内取号 `skipFinalized(maxUsedChapter(bookRoot) + 1, ...)` 是纯目录扫描（structure-core.ts:172-185，existsSync + walkMdEach + mergedIntoMap，全程无跨进程锁）；新章文件名含标题（`:215` `chapterFilePrefix(newChapterNo, 'chapter') + sanitizeFileNamePart(title)`），`createDocument` 的独占探测只按最终文件路径（service.ts:919 existsSync + :935 createFileExclusive）。
- **失效机理**：GUI + CLI 双进程同书并发拆分**不同的章**（双进程是本仓明确支持的场景——save/move/trash/copy/books.jsonl/ai-calls/providers 全配了跨进程锁，service.ts B-6 注释自认「双进程同 relPath 并发新建」是真实威胁面）：① 两进程在对方 createDocument 落盘前各自扫盘，maxUsedChapter 得同值 N；② 各自 planHash 复核均通过（互拆不同章，取号基线互不受影响）；③ 各自 save 截断各自原章（不同 docId → 不同 save 锁，互不阻塞）；④ 新章文件名含标题 → 不同标题不同路径 → createFileExclusive 不拦 → 双双成功，**两章同号 N**。B001 的「锁内重读得新号 → PLAN_STALE fail-loud」防御只覆盖同进程串行重放；取号→save（含 journal 写 + fsync）→create 窗口宽达百毫秒级，先双扫后双写交错可行。后果静默：detectStructureViolations 只查并入不变量、chapterNumberMismatches（B004）只查单文件 fm≡文件名号，均不查跨文件重号；重号落成后，留洞制/skipFinalized/finalizedChapterNumbers/按名定位 chapterPathByNumber 的章号唯一性前提全部受损。正文内容不丢（两文件俱在），故 P2；若双进程批处理属常规工作流，应上调。
- **修法**：为结构操作取号临界区加 per-bookRoot 跨进程锁——用既有 `acquireCrossProcessLockAsync` 原语（document 层已有先例：analysis.ts:15/journal.ts:15）取 `<bookRoot>/项目/.structure-op.lock`，包在 `enqueueSplitApply` 单元外层（跨进程锁 → 进程内链 → save 锁 → 布线 → 清单/journal，锁序一致向外扩展，不破坏「互斥内不再获取其他跨进程锁」纪律——recordStructureEvents 已在互斥外）。备选轻量方案：createDocument 成功后复扫正文区，发现非本次产物的同号前缀文件即 fail 并回滚新章（原章截断已有 external-merge 留底，可恢复）。

### G201：books-repair 扫盘「新发现」分支无同名判重——同名双登记且删书连删两条、不可自愈

- **锚点**：`src/install/books-repair.ts:120-131`（R44-6 防线，只覆盖 path 命中改名分支）、`:145-168`（重关联分支）、`:170-178`（新发现分支与 scanned 并入）；`src/install/books.ts:445` 附近（removeBookEntryLocked 按名 filter 连删）。
- **证据**：新发现分支只查已登记集（books-repair.ts:145 `rebuilt.findIndex((b) => b.name === bookName)`），同一轮循环里先前迭代 push 进 `scanned` 的同名条目对它不可见（`scanned` 在 :178 循环外才并入）；删书出口按名过滤（books.ts removeBookEntryLocked `writeBooks(workDir, books.filter((b) => b.name !== name))`）。
- **失效机理**：两个**均未登记**、book.yaml title 相同的书目录（典型形态：作者手工复制书目录做备份——title 随拷贝不变；或 books.jsonl 损失后 repair 扫盘重建）会被双双登记为同名条目。后果即 R44-6 注自述形态：resolveBook 首匹配遮蔽其一、removeBookEntry 按名过滤连删两条——删一本书时另一张同名卡登记也被清掉，第二本成无登记幽灵（书架失明）。且该状态**不可自愈**：后续 repair 两条 path 都在盘上、走 path 命中分支且 `entry.name === bookName`（:120/:145 均大小写敏感全等），永不触发判重。
- **修法**：新发现分支 push 前补「rebuilt ∪ scanned」联合同名判重，命中按 R74-10 口径 warn 跳过留痕（「请手动确认两处书名哪个是要保留的」），交作者手动消歧；补扫盘双同名目录的回归用例。

## 四、P3 清单（×9）

### A201：knowledge 注入未纳入「模型可见⟺已记录」抽样校验链

- **锚点**：`src/ai/orchestrate/chat/turns.ts:98-99`（digests 类型含 knowledge）、`:180-181`（登记侧已有——0917 批补的知识层方法论血缘事件）；`src/ai/prompts/chat.ts:86-90`（visibleInjections 不传 knowledge）、`:96-103`（visibleInjectionsFromDigests 单源只产 settings/chapter/skills 三档）；`src/ai/orchestrate/chat/turns-visibility.ts:29-31`（verifyVisibleSampled 签名无 knowledge）。
- **机理**：knowledge 确实注入 system prompt 且登记闭环（铁律①本体不违约），但校验面三处未同步：单源清单不产 knowledge 档、校验器签名无该字段（turns.ts:472 传变量引用，TS 结构化类型对多余属性不报错，knowledge 静默蒸发）、治理测试只覆盖三档全量 present——CLW_VERIFY_VISIBLE=1 抽样运行对最新注入通道失明，若后续改动丢失/错配 knowledge 登记，该诊断通道永远 silent-pass。附带：prompts/chat.ts:78-79 头注仍写「两个三元分支」，实为三个（注释漂移，同根因）。
- **修法**：visibleInjectionsFromDigests 增可选 knowledge 入参并产出 `{scope:'knowledge', digest}`（lineage.ts registeredRecords 对 settings/snapshot 按 data.scope 泛化归一，校验器侧零改动）；verifyVisibleSampled 签名补 `knowledge?: string` 并透传；visibleInjections 补 knowledge 档；治理测试补 knowledge 档正负向用例；顺手改写头注。

### B202：账本 fm `类型:`/`状态:` 空值不回落默认

- **锚点**：`src/format/leads.ts:357-358`（对照已修先例 `src/format/chapters.ts:157-174` R41-14）；校验豁免意图在 `leads.ts:322-328`。
- **机理**：校验段显式豁免空串（「空视同缺省回落」），实现却用 `??`——`parseValue('')` 返回 `''` 非_nullish，手写 `类型:`（空值）的账本解析得 `类型:''` 而非 `'悬念'`、`状态:''` 而非 `'进行中'`，与豁免意图相悖；`''` 流入 UI 分档与按类型/状态消费面（合法值判定恒 false）。错档不崩溃、不落数据。R41-14 在 chapters.ts 修过同型（`??`→`||`），leads.ts 漏网。
- **修法**：两行改 `||`（枚举合法值均非空串，语义面精确），对齐 R41-14。

### C201：字体枚举子进程超时 kill 无 SIGKILL 升级

- **锚点**：`src/desktop/font-cache.ts:209-221`（超时分支单发 SIGTERM 无升级）、`:338-354`（linux load 路径超时只 reject 不 kill）。
- **机理**：本仓自己的 kill 纪律（server-proc.ts 的 killProcAwaitEscalating：SIGTERM → 等 2s → SIGKILL + pid 重读）在字体枚举面未对齐——超时后仅一次 SIGTERM，子进程装 handler 或陷入不可中断状态即孤儿存续；linux load 路径连 SIGTERM 都没有。实际风险被 SIGTERM 默认处置 + PM-12 进程级熔断（连败 2 次封顶）+ win TerminateProcess 天然硬杀三层收窄。win-fonts 的 reg.exe/PowerShell 两通道同用此骨架。
- **修法**：超时分支补升级链（SIGTERM 后有界窗，close 未到则 SIGKILL 二次收口）；linux 路径可把 darwin 已接线的自管 spawn 骨架（runFontListCommandWithKill）推广到 fc-list 形态。

### G202：init 半成品恢复的占用判重只查已登记书——case 变体同库双登记

- **锚点**：`src/install/init.ts:140-153`（occupying 只在 books.jsonl 已登记集内找）、`:179-184`（半成品放行复跑）；`src/install/books-repair.ts:120/:145`（两处比对均大小写敏感）。
- **机理**：《Foo》上次 init 在 scaffold 与登记之间崩溃（未登记半成品）后，APFS 上以《foo》重试：占用判重空过（前任未登记）→ isResumableHalfScaffold 命中同一物理目录 → 复跑 scaffold（writeIfAbsent 全跳过，book.yaml title 仍是《Foo》）→ 登记 `{name:'foo', path:'长篇/foo'}`。下次 repair 扫盘取盘上真名 `长篇/Foo`，path/name 两处比对均 miss → 新发现分支再登记《Foo》→ 同一物理书双登记（两张书架卡，与 G201 后果同族）。触发窄（崩溃残留 + 拉丁名 case 变体），状态持续。
- **修法**：半成品恢复分支增加「目录内 book.yaml title 与新 bookName 不一致（case-fold/NFC 口径）即拒绝」，或在登记后回写 title 对齐。

### G203：`##` 标题识别口径分裂（metrics vs check）

- **锚点**：`src/metrics/short-index.ts:364-369`（`^##\s+(.+)\r?$`）vs `src/check/count.ts:368`（`^##(?!#)[ \t\u3000]*\S.*$`，且 :343-356 有围栏剔除）。
- **机理**：同一正文两套识别器——① 紧排 `##标题`（count.ts R26-43/R37-8 明确认可的合法形态）在 collectBodyAnchors 的 `\s+` 下不命中 → anchors 空 → scoreReversalQuality 走弱校验分支产假 issue「正文缺少 ## 段落锚点」、anchoredSetupCount 记 0，短篇索引质量报告系统性低估；② 反向，围栏代码块内的 `## 示例` 行被 collectBodyAnchors 照收 → anchoredSetupCount 可借假锚点虚增。仅影响报告层，不进机检门。
- **修法**：「`##` 段落标题行识别」抽成单一纯函数（采 count.ts 口径 + 围栏剔除复用 format/fence.ts），两处消费同源。

### D201：corpus-commit 缺省语料目录按 cwd 相对解析

- **锚点**：`scripts/corpus-commit.ts:18-20`（`process.argv[3] ?? join('test','corpus','checks')`）；对照同目录脚本 check-counts.mjs:37 / check-packaging.mjs:21 / knowledge-update.ts:33-34 一律 import.meta.url 锚定仓库根。
- **机理**：工作区路径含 `^`、从子目录直跑 `npx tsx scripts/corpus-commit.ts <bookRoot>`（npm run 之外合法形态）时，语料 JSON 落 `<cwd>/test/corpus/checks/`（仓外）；脚本打印「N 条入库」看似成功，CI 回归门（corpus.test.ts）读真仓目录——零新增、静默。
- **修法**：缺省 corpusDir 改 import.meta.url 锚定（knowledge-update 同款），测试注入口不变。

### D202：verify-responses-relay 错误出口未过脱敏

- **锚点**：`scripts/verify-responses-relay.ts:23`（头注承诺「输出永不回显完整 key」）、`:195-198`（errBrief 直出 `trunc(e.message, 120)`，无 redactSecret/maskKeys）。
- **机理**：本仓 redact.ts:9 自述的泄漏形态「部分网关把 key 放 query param」恰是本脚本要测的中转网关；网关 4xx 报错 message 常回显请求 URL，错误路径可把完整凭据打到终端（可能进 CI 日志/截图）。key 本体经 env 注入的正面承诺成立，错误回显面未闭环。
- **修法**：所有 message 出口统一过 redactSecret。

### D203：electron-smoke 失败诊断尾可被 process.exit 截断

- **锚点**：`scripts/electron-smoke.mjs:152-167`（finish 内 `console.error(tail)` 后同步 `process.exit(code)`）。
- **机理**：Node 对管道的 console 写是异步的，CI（输出即管道）失败时恰是最需要日志尾的场景，同步 exit 可在刷盘前终止进程——与头注「失败/超时即带日志尾失败」承诺相悖。
- **修法**：改 `process.exitCode = code` + 让事件循环自然排空（信号兜底路径同步退出可保留）。

### D204：tsconfig 严格度缺口

- **锚点**：`tsconfig.json:2-18`（strict 族已含 noUncheckedIndexedAccess/noImplicitOverride 等，缺 exactOptionalPropertyTypes 与 noImplicitReturns）。
- **机理**：可选属性精确类型与「分支隐式漏 return」无编译期防线——本面 InitStepOutcome 等判别联合正靠手工穷举分支，noImplicitReturns 能机器兜住「新增分支忘 return」。启用需全量评估，属低优先补强项。
- **修法**：评估后启用两旗（先 noImplicitReturns——预期改动面小）。

## 五、与前两轮的对照（增量复评属性）

- **零复发核对**：一轮 P1×1（E001）/P2×11 与二轮 P2×3/P3×36 的修复面，本轮 8 域不知情走查无一被重新发现为缺陷；主审回收后对重点修复锚（E001/E002/B001/B002/B004/D002/A101/E101/F101/B101/B105/G103/G104）抽读复核在位。
- **重叠核对**：本轮 11 条与一轮/二轮发现清单、二轮 §六处置记（G102 缓办 + 一轮维持 12 项 A005/A006/A008/A009/B004/B006/B008/G004/G005/G006/G007/G008）逐条对照**零重叠**。
- **B201 与一轮 B001 的关系**：B001 修复 = 进程内 per-bookRoot 串行互斥（structure-split.ts:11-15 头注自书「进程内」），跨进程形态从未在任何一轮立项或宣称已修——B201 是该作用域的独立增量发现，非复发、非重复立项。
- **二轮「升级信号」两项**（vault KEK 混淆级保护 / SSE `?token=` URL 兜底通道）本轮未见新证据，维持原档不动。

## 六、主审复核记（方法与可信度）

- **P2×2 全量亲验**：B201 = structure-split.ts:86（进程内 Map）+ structure-core.ts:172-185（maxUsedChapter 无锁扫盘）+ service.ts:919/935（createDocument 仅按最终路径判重）三锚读实，跨进程锁原语在本层先例（analysis.ts:15/journal.ts:15）确认、修法可行；G201 = books-repair.ts:120-178（两道防线分支覆盖面 + scanned 循环外并入）+ books.ts removeBookEntryLocked 按名 filter 连删除实、「不可自愈」路径（两处大小写敏感全等）读实。
- **P3×9 证据行全部亲读**：A201 四锚（turns.ts:98-99/:180-181 + prompts/chat.ts:86-103 + turns-visibility.ts:29-31）、B202（leads.ts:357-358 与校验段对照）、C201（font-cache.ts:209-221 + load 路径）、G202（init.ts:140-184）、G203（两正则原文对照）、D201-D204（各锚行原文）。
- **域发现分布**：8 域中 3 域零发现（studio/server、web-next 逻辑层、web-next UI 层）；ai 域 P3×1；document 族 P2×1+P3×1；desktop 族 P3×1；支撑域 P3×1；install·scripts·配置域 P2×1+P3×5。零发现域的重点核验面（server 的穿越/鉴权/SSE/串行化、前端两层的 XSS/输入丢失/监听器/竞态）均有子代理逐项排除记录在案，非草率结论。

## 七、处置建议（待作者拍板）

- **P2×2 建议真修**：B201 跨进程锁包临界段（§三 修法）；G201 扫盘分支联合判重（§三 修法）。
- **P3 分级**：D202（凭据回显面，安全承诺失实）建议优先；A201（治理链缺口）/B202/C201/G202/G203 低成本对齐既有先例；D201/D203 工具面小修；D204 需全量评估启用成本，可缓办。
- **预估修复面**：src/document ×2 件、src/install ×2 件、src/ai ×3 件、src/desktop ×1、src/metrics + src/check ×1、scripts ×3、tsconfig ×1；每条可独立回归；修复批随作者处置另立（届时按 L2 终门跑九门）。

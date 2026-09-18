# 全量源码独立重评五轮-评审-GLM-5.3-2026-09-19

- **执行模型**：GLM-5.3（主审 = 会话模型；只读评审子代理 8 分域 × 两波单波 ≤4，与主审同模型）
- **评审基线**：commit `6364d646`（mac 线，工作树净）；src 1018 件 + test 1267 件
- **评审方式**：作者指令「忽略掉现有文档，重新评审下当前项目源代码」——独立重评，不读 Dev/Docs/ 与 Archive/ 既有评审报告找线索；8 分域只读子代理逐文件通读（测试与治理面按抽查策略），主审逐条「声称 vs 实态」对码核实后成文。
- **总判定**：P1×0；P2×1；P3×13（其中 C103 子代理标「待核」，主审复核机理成立、触发形态为非标网关组合，按防御性修复处置）；口径勘误×1（H104，非代码缺陷）；零发现域×2（E 域文本管线 82 件、G 域组件 97 件）。该库经多轮评审修复（源码内 R-系列锚注密集），防御密度高，本轮净发现以深层组合形态与卫生级留白为主。
- **处置**：随作者指令「修复发现的全部问题」全量落批（P2×1 + P3×13 全修；H104 无代码面，记档即销）。

---

## 一、P2（1 项）

### F101 [P2] web-next 工作台「存草稿并编辑」第二 await 窗漏挂切书守卫——跨书状态与持久化污染

- **位置**：`src/studio/web-next/src/views/WorkbenchView.vue:364-367`（onSaveDraft）
- **机理**：函数自有的 L-F1 锚注点名「存草稿在途切书后 tree.load/openTab/toast 会落到 B 书界面」，但守卫 `if (props.bookName !== book) return` 只堵 `saveDraft` POST 这一窗；`await tree.load(book)` 落定后无复检，后续 `ws.openTab(r.docId)`（无条件 `activeView='editor'` + `activeDocId=r.docId`）、成功 toast、workspace 持久化 watch（500ms 后 `writeBookPrefs` 按 B 书落盘 A 书 docId）三件全部可落到 B 书。若 B 树先落地，Book.vue 的 validate watch 源不含 activeDocId，幽灵 docId 存活到作者手点章节，顶掉 B 自己的「最后打开文档」恢复。同库同型链 `useChapterTreeStructure.ts` onSplitCommit 在 `await tree.load(book)` 后有 `if (!stillIn(book)) return`，本处系漏挂。
- **触发**：点「存草稿并编辑」→ saveDraft 成功 → tree.load 在途窗口（大书树 GET 含 git status + 全盘字数，秒级）内切书。
- **修法**：`await tree.load(book)` 后补 `if (props.bookName !== book) return`（对齐 onSplitCommit 口径）。

## 二、P3（13 项）

### A101 [P3] journal compact 复用 findUnsettled 读失败降级语义——读失败时空集清空整个 journal

- **位置**：`src/document/journal.ts:363-388`（maybeCompactJournal）+ `:199-212`（findUnsettled）
- **机理**：findUnsettled 对文件级读失败按 R61-C-1 口径降级返回 `[]`（对「崩溃恢复扫描」消费方正确）；maybeCompactJournal 把同一函数当「保留集计算」——读失败（EACCES/EBUSY 等，POSIX rename 只需目录写权）时 unsettled 为空、before/after stat 全等（读失败不触碰 size/mtime），N4 复核防线不触发，`atomicWriteFile(journalPath, '')` 把在档全部未结算 pending（崩溃恢复唯一依据，含全文快照）清空，半截正文损坏自此静默存活。
- **触发**：journal ≥ 2MB（compact 归零-再增长常态循环）× journal 文件读权限异常但目录可写。双条件叠加，故 P3。
- **修法**：读内部函数改可辨信号（`{ ok, items }`），findUnsettled 包装维持 `[]` 降级；compact 收到读失败信号即放弃本轮压缩（与 N4「有变即弃」同款 best-effort）。

### A102 [P3] locateLatestMergeEvent 迭代段无 catch——事件库读异常击穿 undo 三级定位落裸 500

- **位置**：`src/document/structure-merge.ts:362-406`
- **机理**：同函数对「库打不开」有降级设计（`catch { return null }` 落回 body/disk 两级定位），但两趟 `store.iterateEvents(...)` 迭代无任何 catch——迭代中途抛错（SQLITE_IOERR/库损坏延迟故障）经 `finally` 关库后原样上抛，穿透 enqueueStructureOp 串行链与路由兜底压成无诊断信息的 `500 {code:'ERROR'}`；按设计意图本应 `return null` 降级定位（undo 仍可完成）。无数据损坏（undo 未开始执行）。
- **触发**：事件库迭代中途 IO 错误。
- **修法**：迭代段纳入 try/catch，失败 `log.warn` + `return null`，与 open 失败降级同款。

### B101 [P3] audit 两路全量事件迭代为同步单 tick 段——长书审计页冻结事件循环

- **位置**：`src/studio/server/api/audit.ts:123-127、168-172`（buildAuditView）
- **机理**：两路 `for (const ev of store.iterateEvents(...))` 循环体无 await，iterateEvents 系同步生成器（逐行 JSON.parse）；分页只截留出网与持有条目，迭代本身走全表。同域纪律（check.ts 每 25 章让出、snapshots.ts SCAN_YIELD_EVERY）均已逐块让出，此处漏网。长书（数万事件）每次打开/翻页审计页都全量重放两路迭代，期间同进程 SSE 心跳、保存、其它请求停摆（Electron 内嵌单进程 = 桌面整体卡顿）。低频管理页、无数据正确性影响，故 P3。
- **修法**：两路迭代各按 SCAN_YIELD_EVERY（25）粒度 `await yieldToEventLoop()`；buildAuditView 改 async，唯一调用点补 await。

### C101 [P3] openai 适配器「choice 在、finish_reason 不在」chunk 的 usage 被静默丢弃——实测计量降级估计入账

- **位置**：`src/ai/provider/openai-adapter.ts:361-373、418-455`
- **机理**：每 chunk 均计算 `effectiveUsage = usage ?? choiceUsage`（注释明示兜 Kimi 形态 usage 在 choices[0]），但 latestUsage 只在 `!choice`（usage-only chunk）与 `choice.finish_reason` 两个分支写入——content/reasoning/tool_calls 三段 delta 均不写。非标网关把 usage 放在先行 content chunk、末 chunk 只带 finish_reason 不重复携带时，实测计量被丢弃，流末 `isRealUsage(latestUsage) && sawFinishReason` 不成立落估计分支（`estimated:true`），预算闸/成本报表精度受损。`:455-461` 注释自称「usage 可随任意 chunk 先行到达」，实现未覆盖「任意」。
- **修法**：`if (!choice)` 判定前统一 `if (isRealUsage(effectiveUsage)) latestUsage = effectiveUsage`（末见 wins 对任意 chunk 生效），两处既有写入点收敛。

### C102 [P3] 知识层方法论截断按 UTF-16 码元切片——代理对可劈半，且与注释「码点」口径失配

- **位置**：`src/ai/prompts/chat.ts:186`
- **机理**：`body.slice(0, KNOWLEDGE_FILE_CAP)` 按 UTF-16 码元计，截断点恰落代理对（emoji/扩展区汉字）中间产出孤立代理进 system prompt；`:163-164` 注释明写预算帽口径是「篇数/单篇码点/合计码点」，实现（`body.length`/`total + body.length`）却是码元——注释与实现失配。仓内同族截断（clipByCodePoints/codePointLength 系列）均已收码点口径，此处漏网。
- **修法**：改 `clipByCodePoints`（单源 `src/process/summary.ts`），合计帽同步按 `codePointLength` 计。

### C103 [P3·待核转防御修复] responses 伪流回填只处理 message 项——「伪流 + 工具产出」形态工具调用方拿空产出

- **位置**：`src/ai/provider/responses-adapter.ts:429-455`
- **机理**：R35-18 伪流回填仅遍历 completed.output 中 `type === 'message'` 项回填文本；伪流网关 completed.output 只含 `function_call` 项时无 tool 事件、无文本回填，`hasOutput` 因 function_call 在场判 true → 正常 emitDone('tool_use' 不成立，落 'stop')，工具型调用方拿到 `input: null` 报「产出为空或非对象」。失败可见非静默腐坏、usage 已入账。子代理标待核（缺该网关形态实证）；主审裁定：机理代码级成立，Responses 线正规端点不会伪流，但兼容网关面防御成本极低，按防御性修复处置。
- **修法**：completed 回填段对称扩展 function_call 项——`!toolYielded` 时遍历产出 tool 事件（arguments JSON 解析 + R74-1 计费累计同口径）。

### C104 [P3] rag embed 非 2xx 路径不消费/不取消响应体——失败请求钉住 socket 至 body 超时

- **位置**：`src/rag/embed.ts:100-103`
- **机理**：`resp.json()` 只在 ok 路径调用；非 2xx 带 body 时响应体未读也未 cancel，undici 连接在 body 消费前不回池，需等默认 bodyTimeout（约 300s）或 GC 兜底。AI 侧两适配器错误路径由 SDK 读 body 构造 APIError，本文件是全库出站点孤例。buildIndex 首败即 break、recall 单请求单次，钉住连接数为重试次数量级，非无界泄漏——资源卫生项。
- **修法**：`return null` 前补 `await resp.body?.cancel()`（catch 兜底）。

### D101 [P3] os-kek.json **丢失**分支缺 v2 分诊——静默重建新 IKM 顶替路径、下游报错误导

- **位置**：`src/desktop/os-kek.ts:51-70`（loadOrGenerateOsKek）
- **机理**：C404② 损坏分诊只覆盖「文件存在但解不开」形态（v2 在库 → 绝不重建 + warn 指引）；`existsSync(fp)===false`（清理工具误删、跨机迁移只拷 providers.json）时直达生成路径——新 IKM 落盘顶替零 warn。旧 IKM 已不在盘，v2 凭据不可解在丢失瞬间已成事实（定级 P3 的理由），但增量伤害有三：①诊断误导——下游 vault 报「密文认证失败——文件损坏或密钥不匹配」指向 providers.json 损坏，而非 os-kek.json 缺失；②静默无留痕——跨机迁移场景（原机 os-kek.json 完好、数据本可恢复）用户被误导重配 key → saveProviders 覆盖 providers.json，可恢复凭据经误操作演化为永久丢失；③文件头宣称的「绝不重建」防线只护损坏形态，口径不对称。
- **修法**：生成路径前置同款分诊——文件缺失且 `v2VaultPresent` 为真时 warn（文案对齐 C404② 并注明「缺失」）+ `return null`（server 侧 openVault 抛 VaultOsKeyMissingError，与损坏形态可区分）；无 v2 消费者维持首启新建语义。

### F102 [P3] OverviewView loadFs 失败不置空——伏笔健康度面板陈旧展示，与兄弟加载器口径不一致

- **位置**：`src/studio/web-next/src/views/OverviewView.vue:105-112`
- **机理**：loadRhythm/loadAnalysis 的 catch 在过代检后置空（`rhythmData.value = null` / `analysis.value = null`），loadFs 的 catch 只 console.warn——注释与文案声称「面板保持空态」，实际是「保持上一轮旧值」：同书先前成功过一次后重试，getForeshadows 失败 → 面板继续展示旧红/黄/绿统计。
- **修法**：对齐兄弟函数——catch 过代检后 `foreshadows.value = []`。

### F103 [P3] CmHost 补全名单切书拉取失败不清旧值——A 书名单残留 B 书编辑器最长 5 分钟

- **位置**：`src/studio/web-next/src/editor/CmHost.vue:419-435`
- **机理**：补全名单按书作用域（readonly/falsy 分支显式清空），但切书拉取失败路径 `catch { /* 无设定数据 */ }` 不清 entries——A 书成功拉过名单后切 B 书恰逢请求失败，B 书编辑器 `@` 弹 A 书角色/物品名；completionFetchedAt 只在成功路径更新，TTL 补拉闸使陈旧窗最长 5 分钟。已核服务端对无设定书返回空数组不报错，仅真实 API 失败触发。
- **修法**：catch 内若本请求仍是最新（`myId === compReqId`）则 `completionEntries.value = []`（空优于错书）。

### H101 [P3] packaged-app-smoke 是「零接线死 spec」——任何脚本/工作流都不执行它

- **位置**：`test/e2e/packaged-app-smoke.spec.ts:29`
- **机理**：文件头挂 `CLWRITING_E2E_RELEASE` 环境门宣称「随 release 命令跑」，但唯一设该变量的 `test:e2e:release` 脚本 playwright 只点名 release-smoke.spec.ts 单文件，本 spec 不在收集集；全仓引用仅两处注释，零调用方。其独有钉面（打包态 fontlist 外置二进制 → spawn → IPC → UI 字体下拉整链）自动化覆盖为零，仅 2026-09-17 mac 实机人工验证在案；其 1 用例还计入 README「另 3 个发布 smoke」静态计数。
- **修法**：接线 desktop.yml mac 腿——`build:desktop` 产物在位后以 `CLWRITING_E2E_RELEASE=1 npx playwright test test/e2e/packaged-app-smoke.spec.ts` 真跑（打包态冒烟本就该在打包后执行；spec 自带产物缺失 fail-closed 断言）。

### H102 [P3] ci.yml soak 门失败文案硬编码「应为 5」与 G408 动态计数源脱钩

- **位置**：`.github/workflows/ci.yml:314`
- **机理**：断言本体已是动态 `[ "$OK_N" -eq "$SOAK_N" ]`（G408 单一真相源 soak.ts --plan，fail-closed 正确），但同一行报错文案写死「应为 5 = 段1…段5」枚举——PLAN_SEGMENTS 补段后断言照常工作而文案成假信息，排障误导；desktop.yml 同款门文案已不枚举段数，两处不一致。
- **修法**：删去文案中固定段数枚举，改引用 `$SOAK_N`，对齐 desktop.yml 口径。

### H103 [P3] 六处「观察档 continue-on-error」无机器到期机制——安全门与出货平台 e2e 门可无限期不阻断

- **位置**：`.github/workflows/ci.yml:77,80`（npm audit 双门）、`.github/workflows/desktop.yml:59,62`（同款双门）、`.github/workflows/desktop.yml:191,195`（win 腿 e2e / release-smoke）
- **机理**：六处均为 `continue-on-error: true` + 注释承诺（audit「连续绿后翻 blocker」、win e2e「连续 3 次绿后撤标志翻阻断」），翻正条件只存在于注释 prose，仓内无任何计数器/日期锚/机器校验强制兑现——依赖作者记忆。audit 门是依赖漏洞安全面（基线实测非绿，主审注：四轮复核 H405 实测根包 critical 1 + high 5），win e2e 门是出货平台发布物验证面，长期非阻塞与「发布门不再名存实亡」方向相悖。
- **修法**：两工作流各挂一步「观察档到期断言」——比较当前日期与锚日（本批定 2026-10-31），过期观察档仍挂即红（fail-closed 强制复盘）；翻正（撤 continue-on-error）时随本步一并删除或修订锚日。

## 三、口径勘误（非代码缺陷）

### H104 评审任务书「win 跳数 = mac 跳 + 4 平台门」为陈旧口径——仓库现行机器锚 = win 68 / linux 5

子代理据 README.md:119 唯一真相源与 check-counts.mjs 反推门实测对账：「过数实测差 68 恒定」（win，2026-09-18 实机重锚）与「linux 实测差 5 恒定」（2026-09-17 修账）两锚各恰配 1 处；「+4」系 linux 分账旧值（旧 4 = darwin 门 1 + linux 门 3，补 DISPLAY 门后 5）。win32 正向门位点普查 68 处（44 文件）、反向（win-only）6 处、环境条件门 10 处，与 README 锚无矛盾证据。**非代码缺陷**，无修复面；记档供后续批次任务书口径对齐。

## 四、零发现域与撤回候选记录

- **E 域（format/export/check/metrics/review/cache/driver/log/shared/scripts，82 件全量通读）：零发现。** 子代理自撤回候选 5 则（parseRatio 空捕获——正则 `\d+` 保证非空；purifyBody astral 前邻边缘——超出设计射程；check-counts diffSpecOrder 集合比较——两步 env 闸守卫；export 平台 label 回落——入口校验不可达；yaml-patch leafEquals 键序敏感——过松方向无损坏面），主审复核撤回判断均成立。
- **G 域（web-next components，97 件全量通读）：零发现。** 子代理证伪候选 2 则（EditorDocHead onFinalize 无 catch——doc.finalize 内部完整 try/catch 不可能 reject；OnboardPremise localStorage 防抖跨书——视图 :key 键控挂载不可达），主审复核证伪均成立。
- **A/B/C/D/F/H 五域正面风险面排除清单**（锁序/事务边界/鉴权豁免/凭据红线/abort 生命周期/IME 守卫/机密注入面/action 钉版/缓存键等）详见各子代理报告要点，主审对码未翻案。

## 五、覆盖面

| 波次 | 分域 | 范围 | 方式 |
|---|---|---|---|
| 1 | A 数据层 | src/events(11) + src/state(4) + src/document(24) + async.ts/worker-async.ts | 41 件逐文件通读 |
| 1 | B 服务层 | src/studio/server（61 件） | 逐文件通读 |
| 1 | C AI 链 | src/ai(82) + knowledge(2) + learn(2) + rag(8) | 94 件逐文件通读 |
| 1 | D 桌面/进程 | src/desktop(24) + process(18) + install(10) + git(2) + fs(11) | 65 件逐文件通读 |
| 2 | E 文本管线 | format(29)/export(3)/check(17)/metrics(2)/review(2)/cache(5)/driver(5)/log(2)/shared(4)/scripts(13) | 82 件逐文件通读 |
| 2 | F web-next 基建 | api(28)/composables(21)/stores(17)/shared(22)/views(8)/pages(4)/editor(2)/入口/子包配置 | 逐文件通读 |
| 2 | G web-next 组件 | components（97 件） | 97 件逐文件通读 |
| 2 | H 测试与治理 | workflows/actions/configs 逐件通读 + 测试面全库 grep 反模式扫描 + 分域抽读 + 实跑 vitest list 对账 7749 | 抽查策略 |

主审对码：14 条发现全部逐条读取现场核实（含 F101 守卫窗、A101 compact 全链、C101 双写入点、D101 分诊不对称、H101 收集集、H102/H103 工作流原文），无一翻案；C103 由「待核」升格为防御性修复处置。

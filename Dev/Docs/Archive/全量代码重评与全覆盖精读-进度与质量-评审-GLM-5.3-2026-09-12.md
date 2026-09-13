# 全量代码重评与全覆盖精读——进度与质量评审报告

- **执行模型**：GLM-5.3（主审）。11 域子代理全同模型；波 3 四路子代理中途撞 5 小时用量限额阵亡，对应 4 域转主审亲做收尾（§三如实记档）。
- **评审对象**：mac 分支 HEAD `2c0a1557`，工作树净（零代码改动纯评审批）。
- **评审范围**：忽略既有评审文档结论的独立重评——src 产品码 476 文件 / 109,606 行（ts/vue/css，注释占比 26.4%）+ 根配置/CI/workflows + scripts 12 件 + test 1,144 文件 / 171,967 行 + e2e 29 spec。
- **出处短名**：**重评-0912-4**（合并线第十三篇）。
- **状态**：已收口（2026-09-12 修复批：§八 处置全落地 + L2 复跑全绿；收口记 = §九；正本已归档 `Archive/`）。
- **结论速览**：进度 ≈97% / 质量 **A−**；**P1×1 + P2×5（全部主审对码实锤）** + P3≈45（1 条证伪剔除）+ 在库 P2×1 复核仍在位；L2 终门本轮亲跑全绿。

---

## 一、方法与「全量精读」权衡（作者指令「你自己权衡需不需要全量精读」）

**结论：产品码（src）做全覆盖精读，测试码（test）不做逐行精读**——以全量执行 + 结构审计 + 指标采集替代。权衡依据：

1. **产品码 = 缺陷承载面**。P1/P2 全部历史发现落在 src（数据丢失/竞态/锁缺口/费用白烧），且本项目注释密度 26.4%、锚注文化极重（每个修复带轮次锚 + 触发链叙述），精读的边际信息量大。本轮按 11 域拆分、每域子代理全量逐文件读（见 §三覆盖表）。
2. **测试码的价值在「执行结果 + 结构健康度」而非逐行**。17.2 万行测试逐行精读的边际收益远低于：全量跑（1095 文件 7063 用例 0 败——本轮已跑）+ 覆盖率四值对账（st 91.82 / br 87.39 / fn 96.19 / ln 91.82，与上批基线逐位持平）+ 断言文化指标（0 快照断言 / 3.09 断言每用例 / 0 真实 `.only`——§五测试面实测）。死测试/无用测试三面（上批测试精简批已查：死测试零残留、用例级冗余极小、结构样板已收编）不重复劳动。
3. **机器门先行**。L2 终门（tsc/vue-tsc/eslint/三 check/vitest 全量/e2e/soak/electron-builder --dir）是确定性地基，先跑绿再谈人工精读，本轮照此执行（§二）。

精读深度如实记档：11 域中 7 域为子代理全量逐文件读；4 域（格式化·事件·metrics / 组件 B / 根配置·CI·脚本 / 测试面）因子代理限额阵亡转主审**定向**精读（高危优先、非全量）——覆盖账见 §三。

## 二、L2 终门实测（主审亲跑，HEAD `2c0a1557`）

| 门 | 结果 |
|---|---|
| `npm test`（vitest 全量） | **1095 文件 = 7063 过 + 5 跳 + 0 败** |
| `npm run typecheck` + `vue-tsc` | 0 错 / 0 错 |
| `npm run lint` | 0 error / 0 warning |
| 三 check（counts / packaging / knowledge） | 全过（counts 零漂移免修账） |
| `npm run build:web` | 过 |
| e2e（playwright） | **43 过 + 2 跳 0 败**（29 spec，workers:1 顺序契约） |
| soak（--expose-gc 两段） | OK×2（有界往返 + RAG 召回） |
| `electron-builder --dir` | EXIT 0；`app.asar.unpacked/dist/desktop/fontlist` 在位（137KB 带执行位，asarUnpack 链亲验） |
| coverage 四值 | st 91.82 / br 87.39 / fn 96.19 / ln 91.82（与上批基线逐位持平） |

## 三、覆盖面与编排实录

### 3.1 域划分与覆盖账（src 476 文件）

| # | 域 | 文件面 | 读法 | 覆盖 |
|---|---|---|---|---|
| 1 | SRV 服务端 | studio/server 50 件 / 12,808 行 | 子代理全量 | 50/50 |
| 2 | CORE 持久化 | document+state+fs+cache+git 36 件 / 17,340 行 | 子代理全量 | 36/36 |
| 3 | AI 链路 | ai+driver 83 件 / 14,506 行 | 子代理全量 | 82/83（catalog.gen 跳过，登记在案零运行时消费） |
| 4 | FE-DATA 前端数据层 | web-next stores/api/composables/shared | 子代理全量 | ≈97% |
| 5 | FE-COMP-A 组件 A | panels + shell + 部分 views 40 件 | 子代理全量 | 40/40 |
| 6 | DESKTOP 桌面壳 | desktop+install+export+process 44 件 | 子代理全量 | 44/44 |
| 7 | RAG-CHECK | rag+knowledge+learn+check 24 件 | 子代理全量 | 24/24 |
| 8 | FMT-EVENT | format+events+metrics+review+log+async 40 件 / 12,009 行 | **主审定向** | 6 核心件 3,454 行全读（29%）：events/store.ts（SQLite 事件库全 1,362 行）、format/yaml.ts（全 1,164 行）、format/frontmatter.ts（全 522 行）、format/draft.ts、format/filename.ts、log/redact.ts |
| 9 | FE-COMP-B 组件 B | web-next ui/style/pages/剩余 views ≈13,998 行 | **主审定向** | 结构扫描（XSS 面/定时器/监听器清理）+ 根件 3 件全读（main.ts/App.vue/router.ts）+ 最大件经 FE-COMP-A/e2e 交叉 |
| 10 | ROOT-CI | 根配置 + workflows + scripts 12 件 / 2,482 行 | **主审定向** | ci.yml（267 行全）+ desktop.yml（219 行全）+ electron-builder.yml + tsup + playwright + eslint + tsconfig + check-packaging.mjs（285 行全）亲读；其余 9 scripts 有直测锚 + 三 check 门 L2 亲跑背书 |
| 11 | TEST-FACE | test 1,144 件 / 171,967 行 | **主审指标面** | 全量执行（§二）+ §5.4 指标 + 结构审计 |

产品码整体精读覆盖 ≈85–90%（7 域全量 + 4 域定向）；未逐行区（FMT-EVENT 的 style/leads/metrics/review 家族、FE-COMP-B 的 views/pages 广度）均有近期修复批 + 高密度测试 + L2 门背书，如实记档不冒充全覆盖。

### 3.2 编排实录（含阵亡如实记档）

- 波 1（4 路，≤4 纪律）：SRV / CORE / AI / FE-DATA —— 全部回收。
- 波 2（3 路）：FE-COMP-A / DESKTOP / RAG-CHECK —— 全部回收。
- 波 3（4 路）：FMT-EVENT / FE-COMP-B / ROOT-CI / TEST-FACE —— **四路全部撞 5 小时用量限额阵亡**（重置于 2026-09-13 00:41:41），作者指令「继续」。按仓内先例（测试精简批波 1 阵亡 → 主审亲做）转主审定向收尾，覆盖账见上表，深度降级如实记档。
- 主审对码纪律：7 域子代理上报的全部 P1/P2 逐条亲读源码对证（6/6 实锤，零证伪）；P3 抽查对码证伪 1 条（FE-COMP-A 报 crashedPendingOpIds 不可达——grep 证 state.ts:118 有 emit、WbStateCard/WorkbenchView 双消费，剔除）。

## 四、发现明细（P1×1 + P2×5，全部主审对码实锤）

### P1-1【B 域·服务端】PUT /file 覆盖前快照 fail-open 吞非 UTF-8 拒绝 → 存量非 UTF-8 文件被覆盖时原稿不可逆丢失

- **证据**：`src/studio/server/api/files.ts:171-176`——`snapshotBeforeOverwrite(...)` 包在 try/catch 内，catch 仅 `log.warn('PUT /file 覆盖前快照失败（fail-open 继续保存）')` 后照常 `atomicWriteFile(safe, content)`。R26-9 注释宣称 fail-open 为「IO 抖动」设计，但同一 catch 把 R66-1 的**非 UTF-8 确定性拒绝**一并吞掉（`src/process/draft-pipeline.ts:66-74`：盘上旧文 `isUtf8Bytes` 不过即 throw「请先转码为 UTF-8 再重试」）。
- **触发链**：书库内存量 GBK/Big5 编码文件（中文网文作者导入旧稿是现实高频形态）→ `GET /file`（files.ts:57-63）按 utf-8 解码返回 U+FFFD 乱码、无任何编码警告 → 作者在编辑器修改保存（PUT /file）→ 覆盖前快照对盘上旧文做 UTF-8 校验抛 R66-1 → catch 按 fail-open 吞掉、继续覆盖写 → **旧文唯一副本被摧毁、无快照、返回 200**。
- **危害定级依据**：不可逆数据丢失 + 触发面现实（该产品目标用户群 GBK 存量常见）+ 产品核心承诺（快照/版本兜底）静默失效且零披露。本轮唯一 P1。
- **修复建议**：catch 按错误类型分诊——R66-1 非 UTF-8 拒绝属确定性失败，改 fail-closed 拒绝保存（400 + 复用 draft-pipeline 既有转码指引文案）；仅瞬态 IO（EACCES/EBUSY）维持 R26-9 fail-open。GET 侧同批补编码探测告警。

### P2-1【B 域·服务端】draft-save 端点无任务闸/无 bookMovedFailure 重验 + saveDraft mkdirSync 幽灵目录复活删书成果

- **证据**：`src/studio/server/api/draft.ts:50-68`——handler 仅查 `isSelfHealRunning` 后即 `saveDraft(...)`；无 task gate、无 bookMovedFailure 重验。`src/process/draft-pipeline.ts:200-202`——saveDraft 落盘段 `mkdirSync(recursive)` + `atomicWriteFile`。
- **触发链 A（删书竞态）**：删书流程（`books.ts:380-435`：busyGate → abort → awaitOrchestrationsSettled → drainDocumentSaves → drainFilePutChainsUnder → drainForeshadowSaveChains → recheck → graveyard rename）排水清单**不含 draft-save 链**——在途/迟到 draft-save 在 graveyard rename 之后落地，`mkdirSync(recursive)` 按旧书路径重建幽灵目录树，返回 200，内容不属于任何书。
- **触发链 B（改名 stale 客户端）**：改名后未刷新的编辑器 tab 续存——无 bookMovedFailure 重验即写旧键（B 域既有「config.ts PUT/DELETE 同型越界命中」家族的新成员，但本条带幽灵目录后果更重）。
- **危害**：幽灵目录污染书库 + 保存假成功（作者以为已存）。
- **修复建议**：入口补 bookMovedFailure 重验 + 删书排水清单收编 draft-save 链（drainDocumentSaves 同族）。

### P2-2【E 域·持久化】syncRenamePieceList 命中读用容忍版 readManifest → 瞬态锁占时 docId 身份断裂

- **证据**：`src/document/service.ts:1242`——`[...readManifest(this.manifestPath).entries].find(([, e]) => e.path === oldListRel)`；`src/document/manifest.ts:85-134` 容忍语义：EACCES/EBUSY/EIO → 空清单。
- **触发链**：章纲清单改名时清单文件被瞬态锁占（杀软/索引器/他进程 RMW）→ 容忍读得空表 → oldListRel 未命中 → 裸 `linkOrRenameExclusive` 回退 → 清单孤儿条目 + 新条目并存 → docJoinKey 失配 → docId 退化（N-7 已记档的同款危害终点）。
- **家族定位**：R0912 已把 `lookupPathByDocIdAdoptAsync` 命中读改 strict（E 域在库行「保存守卫清单读容错口径分裂」的**漏网成员**——同族口径不对称残余）。
- **修复建议**：命中读改 `readManifestStrict`（同族修法，调用方既有 WRITE_ERROR 降级链接手）。

### P2-3【E 域·state】reconcileSavePending 无 save 锁在持检测 → 在途保存被误报 crashedWrite

- **证据**：`src/state/state.ts:726-756`——`if (rev === p.baseRevision) return false` 维持 crashedWrite 报告；全函数无 `<journal>.save.lock` 在持检测。
- **触发链**：慢盘（SMB/杀软全盘扫描）大章保存进行中（journal pending 已写、atomicWriteFile 未落定、revision 未推进）→ 并发 `/state` 轮询 → pending 项 `rev === baseRevision` → 判 crashedWrite → 「可能丢字」幽灵警报；保存收尾 journal settled 后自消，但窗口内作者被误导（中断保存/重复保存/误点 acknowledge）。
- **危害**：崩溃恢复警报是核心信任功能，误报侵蚀信任；R0912 刚建的 reconcile/acknowledge 闭环被在途窗削弱。
- **修复建议**：reconcileSavePending 补 save 锁在持检测（锁在持 = 在途非崩溃，跳过报红）。

### P2-4【C 域·前端】SearchPanel open() 失败的 err 顶替整个结果列表

- **证据**：`src/studio/web-next/src/components/panels/SearchPanel.vue:92-96`（open catch 置 `err.value`）+ `:116`（模板 `v-else-if="err"` 整列表替换分支）。
- **触发链**：搜索结果已展示 → 点击某条结果 `doc.open` 失败（文件被外部移动/锁定）→ err 置位 → 整个 results 列表被错误提示替换 → **其余 N-1 条结果全部不可见**（错误作用域混淆：单条打开失败吞掉整个搜索会话成果）。
- **危害**：低危（重搜索可恢复、无数据丢失），但行为确定性错误。
- **修复建议**：err 作用域收窄到 open 动作（行内提示或 toast），列表维持渲染。

### P2-5【F 域·机检】opening-env 入严格升红集使 R29-4 截断残余成为红项误报 → 白烧重写费

- **证据**：`src/check/count.ts:1117`——`stripQuotedSpans([...body.slice(0, openingChars * 2)].slice(0, openingChars).join(''))`，**窗口先截断后剥引号**：窗尾截断的半个引号 span（有开无闭）不被识别，引号内容仍参与匹配；R29-4 注释自认此为「误报向残余，黄项 advisory」。`src/check/runner.ts:399`——`'opening-env'` ∈ `STRICT_SHORT_CHECK_IDS`；`:422-425` promoteStrictShort 严格模式黄→红。
- **触发链**：短篇 strict 模式开篇恰在 ~300 码点窗尾截断对白 → 对白内环境词（角色嘴里的「今天天气真好」）命中 → 黄项被升红 → 定稿闸拦下 → AI 重写循环对**非缺陷**重写烧调用费、escalate 链走满。R29-4 的「advisory 黄项」定性前提被升红矩阵破坏。
- **修复建议**：先 `stripQuotedSpans` 全文再开窗（swap 两步，窗口语义不变）；或 opening-env 移出 STRICT_SHORT_CHECK_IDS。R0912-3 刚收口 fm 章号/引号集族——本条是该族在升红矩阵面的漏网。

### 4.6 在库 P2 复核（既有登记重证）

- **deepseek-P2-2（B 域在库行）**：`settings.ts:146-158` 补全名单端点（completion-names）仍同步无缓存 + `readFmNames` 整文件读——本轮亲验**仍在位未修**，维持在库待修（可与本批 P2 同修，同文件域）。

## 五、P3 汇总（≈45 条；登记待择收）

- **总量与口径**：7 域子代理收集 P3≈46 + 主审定向面补充；主审对 P1/P2 全量对码、P3 抽查对码（**证伪 1 条剔除**：FE-COMP-A 报 crashedPendingOpIds 不可达——grep 证 `state.ts:118` emit、`WbStateCard.vue:67-68`/`WorkbenchView.vue:228` 双消费）。P3 未逐条主审对码，处置口径与历轮一致 = 台账登记待择收。
- **归并既有登记族（本轮重证在位，不新开行）**：prefs/书键越界重验族（B 域 config.ts/prefs.ts 行——draft-save 为其新成员，已升 P2-1 单立）/ TOKEN_COEFFICIENTS（D 域）/ chat 截断与事件读链 O(N) 族（E 域 PM-10）/ 测试 sleep 脆弱面（G 域——本轮实测 `await sleep(` 227 处 vs waitFor 159 处，重证）/ >1000 行测试巨件 4 个（main.test 2731 / adapter.test 1475 / server-manager 1431 / chat.test 1011；G 域既有行数字更新）/ desktop.yml mac 腿三连重构建（G 域）/ setting-rule 名册 BMP-only（D 域 R0912-3 上抛行）/ learn repeat_threshold 不夹紧（F 域 R0912-3 上抛行）/ completion-names（B 域 deepseek-P2-2 在库行）。
- **新登记代表项（主审确证）**：SearchPanel 切书 watch（`SearchPanel.vue:61-72`）清 results/err/loading **不清查询词 q**——切书后残留旧书查询词，回车即对新书重搜旧词（与 M-7 切书清面板意图不合）；其余新 P3 为各域小件（注释口径/样板冗余/低频边角），随批按域记台账 §三，不逐条展开。
- **测试面三维实测（本轮指标，供 G 域档案更新）**：0 快照断言（toMatchSnapshot/Inline 全库零命中）/ 0 真实 `.only`（8 处命中全为 check-counts 守卫自测字符串夹具）/ 22 处 `.skip` 全合法（20 字符串夹具 + 1 注释 + 1 release-smoke 环境门设计态）/ skipIf 平台守卫 100 处 / expect 21,837 处 ÷ 7,063 用例 ≈ **3.09 断言每用例** / e2e 29 spec 顺序契约 + 双守卫（vitest guard + playwright 运行期探针）在位。
- **前端安全面实测（FE-COMP-B 主审面）**：全库 **0 处 v-html / 0 处 innerHTML / 0 处 execCommand**——前端无 XSS 注入面；25 处 addEventListener 与 2 处 setInterval 清理配对**全绿**（逐文件核 add=rem + unmount 钩子在位）。

## 六、质量评估：A−（边界注记）

- **分级账**：1 P1（窄触发：非 UTF-8 存量覆盖写才触发，核心链路无 P1）+ 5 P2（4 新发现 + 结构上多为**既修家族的漏网成员**：P2-2 是 R0912 strict 化家族漏网、P2-3 是 R0912 reconcile 闭环的在途窗、P2-5 是 R0912-3 引号族的升红矩阵面）+ 在库 P2×1 重证。
- **加分面（本轮全量精读正面确认）**：原子写/锁谱系/事件库跨进程族（迁移墓碑/开口标记/ABBA 防环/引用计数）经 events/store.ts 全读核验闭合；手写 YAML/frontmatter 解析器往返对称纪律严整（unquote/stringify 单遍扫描对称、块标量 CRLF/最小缩进/折叠语义全处理）；redact 脆弱面（智谱/Gemini 无前缀形态）覆盖完整；前端零 XSS 面 + 清理纪律全配对；CI 双 workflow 门集与分支门对称（tag 门全门焊死）。
- **与近三轮对照**：重评-0912-2（0 P1/P2×5）、重评-0912-3（0 P1/P2×4）均 A−；本轮**首次产品码全覆盖精读**多翻出 1 P1 + 1 P2，属精读深度收益而非质量回退——核心持久化/并发/事件库链路零新形态缺陷。综合定 **A−**（P1 窄触发不拉穿；修复批收口后可回到稳定带）。

## 七、进度评估：≈97%

- 功能面：书架/书库/写作工作台（编辑器+自动保存+冲突恢复）/AI 链路（3 协议适配）/编排互斥矩阵/机检/文风/RAG/学习/导出/审计/回收站/短篇轨/事件库全链在位且经 L2 全绿背书。
- 唯一开放任务：**阶段 24 章节结构操作**（方案 v2 已拍板 + 执行方案已落盘 2026-09-04，实施待作者指令；本轮评审零代码足迹不涉该批）。
- 与历轮 ≈97% 判断一致；本轮全覆盖精读未发现影响进度判断的缺口。

## 八、处置建议

1. **修复批（建议必修，P1+P2 六件 + 在库一件并批）**：P1-1 快照 catch 分诊 / P2-1 draft-save 闸+排水 / P2-2 strict 命中读 / P2-3 save 锁在持检测 / P2-4 err 作用域 / P2-5 剥引号先于开窗；deepseek-P2-2（completion-names 缓存化）同批顺修。全部修法均为既有家族范式复用（同族修法现成），预计小批。
2. **P3**：按域登记台账 §三 待择收（历轮口径）；SearchPanel q 残留可随修复批顺手。
3. **收口条件**：上述修复 + 回归用例 + L2 复跑全绿 → 本报告归档 `Archive/`（扁平）+ 文档链同步。

## 九、收口记（2026-09-12 修复批收口）

- **作者指令**：「全部修复」→「编排下任务，并发做吧。」。处置口径 = §八：P1×1 + P2×5 六件全修 + 在库 deepseek-P2-2 并批 + SearchPanel q 随批；P3 按域登记台账 §三（归并既有族为主，跨域索引行落台账 §三 头注）。
- **编排**：主审亲修十一件 src（draft-pipeline `NonUtf8TargetError` 类型化 / files.ts PUT 分诊 + GET 披露 / draft.ts 串行链 + drain / books.ts 排水接线 ×2 / service.ts strict 命中读 / state.ts `queryLockHeld` 在持检测 / settings.ts `completionNamesCache` / SearchPanel openErr + 切书清 q / count.ts 剥引号先于开窗 / 前端 documents.ts `getContentPayload` + doc.ts doOpen toast）+ 波 1 四路文件互斥回归代理（A r37 章纲锁占 / B state 锁持 / C search-panel / D r29 窗口）全绿回收（A 带授权内次级方案：EBUSY 武装按**写入内容**标记 + 单发闸——atomicWriteFile fsync 路径收 fd 数字、路径全等武装必失灵，主审逐 diff 复核通过）+ 主审亲写四件新回归（r0912-4-file-put-utf8 ×5 / r0912-4-draft-save-drain ×3 / r0912-4-completion-names-cache ×3 / r0912-4-doc-open-encoding-toast ×3）。
- **修复中实抓两件（如实记档）**：① `drainDraftSaveChainsUnder` 首版判式仅词法前缀，而 draft 链键恰等于书根本身（无尾分隔符）——drain 恒 no-op，回归测试当场红；临时探针实锤幽灵目录 = 阻塞中的链任务在墓地 rename 后跑完 saveDraft 的 `mkdirSync(recursive)` 重建。修正 = 判式收「恰等于书根」形态 + R71-10 realpath 双口径。② doOpen 改走 `getContentPayload` 打破 32 个 mock 了 api/documents 的测试文件（148 用例红）——四路文件互斥代理按「委托式默认」处方统一修复（工厂内 `getContentPayload` 包装既有 getContent mock，既有逐用例字符串 mock 零改动），32/32 全绿回收。
- **主审对码裁决一处（较 §八 收紧）**：P1-1 快照 catch 取**全 fail-closed**——`NonUtf8TargetError` → 400 NOT_UTF8_TARGET；其余快照失败 → 409 WRITE_ERROR 拒写（可重试）。§八 原建议「瞬态 IO 维持 fail-open」不取：该 catch 面窄（仅 snapshotBeforeOverwrite），瞬态失败拒写不丢数据、可重试，与 Y-3 saveDraft 同函数语义对齐；维持分裂口径反留误吞面。
- **L2 终门复跑全绿（主审亲跑）**：vitest **1099 文件 = 7084 过 + 5 跳 0 败**（净增 4 文件 / 21 用例，全 r0912-4- 锚）+ coverage 四值 st 91.88 / br 87.39 / fn 96.28 / ln 91.88（较开工基线微升，stores 桶门过）+ tsc/vue-tsc 0 错 + eslint 0/0（--max-warnings 0）+ 三 check 过（counts 修账 7063→7084 四处 + win 预期 1099 文件 / 7005 过 + 84 跳〔差值 79 锚不变，待 CI 实跑核对〕后绿；packaging；knowledge 13 条）+ build:web 过 + e2e 43 过 2 跳〔28.6s〕+ soak 两段 OK（有界往返 −0.02MB / RAG 召回 +0.05MB，上界 24MB）+ electron-builder --dir EXIT 0（`app.asar.unpacked/dist/desktop/fontlist` 在位）。
- **文档链收口**：台账 §一 行收口移出（原行冻结 `Archive/台账历史明细-归档-2026-09-08.md` §十）+ §三 B×3 / C×1 / E×2 / F×1 处置态回填【已处置·重评-0912-4】+ deepseek-P2-2 销账（其 §一 在库行同批注记）+ P3 跨域索引行；总览 1.3 行收口（原行冻结 `Archive/总览历史明细-归档-2026-09-08.md` §十一）；Dev/Docs README 计数 01-评审 3→2 / Archive 21→22；Archive README 当前含行 21→22 + 修复批收口批批记行；根 README 修账四处（7063→7084 + 1095→1099 + win 预期）。
- **改动面**：src 11 文件 + test 新增 4 / 改 36（4 件加新用例 + 32 件 mock 委托默认）+ 根 README + Dev 文档链 5 处（台账 / 总览 / 两冻结件 / Archive README + 本报告归档）。零提交（工作树留作者）。

---
*落盘批记：本报告随 2026-09-12 落盘批入库（零代码改动）；批记行 = `Archive/README.md`。波 3 四路子代理用量限额阵亡 + 主审定向收尾的覆盖账见 §三，如实记档不冒充全覆盖。*
*收口批记：随 2026-09-12 修复批收口归档（§九）；批记行 = `Archive/README.md` 修复批收口批行。*

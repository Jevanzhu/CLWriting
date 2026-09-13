# 源代码抽样重评——进度与质量（复审-0913-源码）

- 日期：2026-09-13。
- 执行模型：GLM-5.3（主审）；子代理 7 路（两波，文件互斥，全同模型）。
- 评审对象：mac HEAD `86e31d70` 工作树净。src 479 文件 / 112,139 行（ts+vue，排除 node_modules）；test 1,114 文件 / 175,704 行；e2e 31 specs。
- 评审性质：**独立重评**——按作者指令「忽略现有的评审文档……不要全量精读」执行：全程不读 `01-评审/`、`Archive/` 与各报告正文（防既有结论锚定；查重仅在发现定型后对台账 §三 单点做，结论见 §六）；评审方法 = **抽样精读**（按风险选材，非逐行全覆盖，抽样账见 §一）。
- 状态：**已收口**（2026-09-13 源码重评修复批——P1/P2 全修 + P3 择收随批 + 回归通过；收口记 = §八）。归档：2026-09-13 随批复位 `Archive/`（扁平）。

## 一、评审口径与抽样账

两波 7 路文件互斥子代理（波 1 四域齐发、波 2 三路补样，全程在途 ≤4，作者纪律条），每路口径统一：「域内地图（行数排序 + git churn 热点）→ 最大/最热文件完整精读 → 其余文件 grep 风险模式定向抽查 → 每个疑点回码逐行验证（确凿才报）」。主审职责 = 全部 P1/P2 逐条亲核对码 + 防线家族 grep 对账 + 门禁亲跑。域划分与抽样实况：

| 域 | 范围 | 规模 | 精读量（率） | 补偿手段 |
|---|---|---|---|---|
| 引擎域 | document/format/state/events/fs/git/cache/async | ~30.2k 行 | 波 1 十六件 ~15.0k + 波 2 补样 ~8.8k（format 剩余 23 件 + events 7 件 + document/fs/cache 剩余 + batch-pause + ai-track，接近全覆盖）≈ **79%** | grep：as any（0）/空 catch/定时器清理/锁调用面 |
| 生成/分析域 | ai/rag/process/check/knowledge/learn/review/driver/log/metrics/export/install | ~31.9k 行 | 波 1 十三件 ~10.5k + 波 2 精读 ~30 件（review 双件/metrics/check/ai provider+rules+tasks+prompts/process 大部/rag 三件/driver/log/knowledge/learn/install）≈ **70%** | grep：同步 IO/TTL/AbortController/prompt 注入边界全域扫 |
| 服务端域 | studio/server | 13.2k 行 | 完整精读 23 件 ~11.4k + 段落精读 6 件 ≈ **86%** | 其余 ~15 读端点 grep 写原语/路径拼接/信封漂移 |
| 前端+桌面 | web-next/src + desktop | 44.2k 行 | 波 1 十二大件 ~9.5k + 波 2 精读 17 件 + 段读 ~20 件 ≈ **35%** | 全域 grep：监听器 add/rem 配对（16 组件全平）/定时器/v-html（0）/外链（0）/props 突变（0） |

合计：完整精读 ≈ 69k 行 / 112k ≈ **62%**；其余文件全部经风险模式 grep 扫描覆盖。前端精读率最低系组件面以展示件为主、风险探针全域扫代偿，如实记档。

## 二、门禁与静态实测（主审亲跑，全绿）

| 门禁 | 实测 |
|---|---|
| vitest 全量（`test:coverage`） | **exit 0**；`check:counts` 对账实测：**1,114 测试文件 / 7,196 单测；31 e2e spec / 51 用例**，与 README 声称一致 |
| coverage（coverage-summary.json totals） | st **91.66** / br **87.24** / fn **96.19** / ln **91.66** |
| `tsc --noEmit` / `vue-tsc --noEmit` | 0 错 / 0 错 |
| `eslint . --max-warnings 0` | 通过（0/0） |
| 三 check | counts（对账一致）/ packaging / knowledge（13 条 manifest 对账一致）全过 |
| tsup 构建 + `build:web` | 过（7 entry + preload.cjs；build:web 随 e2e 链） |
| e2e（playwright 全量） | **49 过 + 2 跳（38.4s，31 specs）** |
| 未复跑项 | soak 两段 / electron-builder --dir 出包——抽样评审口径未纳入；两者在同 HEAD（86e31d70）阶段 24 批 C 收口时亲跑全绿，CI 腿另有兜底，如实记档 |

静态卫生：src 全域 TODO/FIXME/HACK 仅 **1 处**；引擎/生成两域 `as any` 抽扫 **0**；空 catch 全部带降级理由注释（引擎域 163 处逐一核查无裸吞）。test 侧本轮未做代码评审（作者口径评审源代码），以门禁实测 + check:counts 对账为质量信号。

## 三、进度评定

- **实施路线：24/24 阶段全部完成。** 总览 §三 当前无开放任务（阶段 24 章节结构操作 2026-09-13 全三批 A/B/C 各批独立 L2 收口）；§五 决策表「真开放待拍板：无」；02-执行 三篇均已完成/已拍板状态。本轮抽样对功能链完整性做了代码面抽查确认（结构操作 plan/apply/undo/崩溃恢复链、导出 D7 分流、RAG 清理钩、校对升红集、onboarding 全链在位且有回归锚）。
- **残余（质量收尾面，非功能缺口）**：① 在库未收口评审处置：复审-0913-结构（P1×1 + P2×5）、deepseek-v4.1-flash（残余 = P2-1 测试面〔作者已裁定暂缓〕+ 产品侧机械死码批；P2-2 已并批处置）、专项精简优化（收口条件已满足，归档时点待作者）；② 台账 §三 各域【待拍板/单立/维持】项（含 undo 回收站反查歧义、事件读链 O(N) 立项、H 档精简总账等）；③ 本轮新发现（§五）。
- **结论：功能完成度 100%（24/24 阶段、无开放任务、无缺失功能块）；综合进度（计入质量收尾批）≈ 98%。** 与上一轮全量重评（重评-0912-4，≈97%）相比净推进一格，增量来自阶段 24 全三批落地收口。

## 四、质量总评与评级

**评级：A−（维持上轮水位）。**

七路域评一致结论：这是一套「评审边际收益递减」段的高成熟度代码——竞态守卫（书名入口捕获 + 代数/身份守卫遍布前后端）、锁序全仓单向无环（save→布线→清单）、降级必留痕 + 损坏 fail-closed 的错误哲学、「模型可见 ⟺ 已记录」与「默认值显式 resolve」两条 AI 链路纪律执行度高（promptFiles/promptTools 指纹 + 血缘三事件 + resolvedEffort/timeoutMs 落账）、资源清理成对（监听器/定时器/句柄全域抽验零泄漏面）、历轮修复以 R 编号注释内联可溯——罕见的强可审计性。门禁九项实测全绿（§二）。

扣分项（A− 而非 A 的原因）：① 在库 P1×1（doMergeUndo）未收口——真实用户可见正确性缺陷；② 守卫族/单源收口存在残余漏点：本轮 3 个新 P2 全部属于「同族防线修了一半」或「降级零留痕」类（无数据丢失级，但说明家族化修复仍有漏网面）；③ P3 面广（本轮新记 ~26 项 + 在册存量），以格式化散布/口径分裂/死代码为主。

## 五、发现清单

> 分级口径：P1 = 用户可见数据丢失/正确性/安全；P2 = 真实缺陷（竞态/泄漏/降级无痕/纪律违背）；P3 = 打磨项。每条主审已亲核对码（P1/P2 逐环；P3 抽核 + 代码证据采信）。

### 5.1 P1：新发现 0；在库项独立重证 1

**P1-R（重证·与复审-0913-结构 P1×1 同项）：「撤销并入」缺前置 flushUnsaved——dirty 目标章撤销后被静默写回合并后内容，与已还原源章内容重复。**
- `src/studio/web-next/src/composables/useChapterTreeActions.ts:612-639`（doMergeUndo 全函数无 flushUnsaved；同文件 doMergeIntoPrev :546-551 两章均冲写、doSplitHere :651 有冲写，独缺此函数）。机制链主审逐环亲核：撤销后 `doc.refresh`（`stores/doc.ts:569-586`）走 dirty 分支——正文保留本地（不清 dirty）+ `baselineRevision` 对齐服务端回滚版 → 下次 autosave/⌘S 以对齐后基线**零冲突**把「合并后版本 + 新编辑」整体写回已回滚的目标章；源章已从回收站还原 → 两章内容重复、全程无提示，且与确认框文案「合并后的新改动会丢失」相反。
- 触发：并入完成后作者在目标章继续输入（dirty）→ 右键「撤销并入」→ 30s autosave 节拍内自动落盘。置信度：确凿（本轮前端域子代理未看在库报告、独立发现同项；主审亲核三环坐实）。

### 5.2 P2：新发现 3

**P2-1（引擎域）`src/document/structure.ts:174-185`（另 :439 消费同源）——消费清单路径裸 `join(bookRoot, path)`，防御纵深口径与全仓不一致。**
```ts
const path = await svc.resolvePathAsync(docId)   // path 来自 manifest（可篡改数据面）
...
const abs = join(bookRoot, path)                  // 裸 join，无 safeManifestPath/resolveWithinRoot
bytes = readFileSync(abs)
```
本仓自身威胁模型将 manifest 定为可篡改面并全线设防（service.resolveSafePath、state.ts safeManifestPath、trash.ts Y-18/R51-D-1、tree.ts/finalize.ts 同族）；structure.ts 是唯一用裸 join + readFileSync 消费清单路径的模块（grep 证实未 import 防线单源）。`:176` 的 `startsWith(BODY_PREFIX)` 只约束前缀，`正文/../../x` 形态仍可越书根——merge plan/apply 的拼接正文、sourcePreview、字数均可读到书外文件（读取/信息面；写入侧经 svc.save 有防线）。触发 = 清单条目被外部篡改后执行合并/拆分/撤销。修法 = 对齐 safeManifestPath 单源（读侧收口，~3 行）。置信度：确凿（口径不一致客观成立；本地单用户场景实际可利用性低，不升 P1）。

**P2-2（引擎域）`src/format/leads.ts:345-355`——`开启章` 缺整数/正数守卫，同族守卫修了一半。**
```ts
const 开启章Num = Number(map.get('开启章'))
...
开启章: Number.isFinite(开启章Num) ? 开启章Num : 0,
```
chapters.ts:131 对同语义字段（章号）有 `!Number.isSafeInteger(章号) || 章号 < 1` fail-loud 守卫（R31-15），leads 侧 R75-2 自称对齐口径却只做了 isFinite——`开启章: -3` / `12.5` 无拦截无留痕直落数据模型。后果：`readStaleLeads`（read.ts:40）`age = currentChapter - openedAt` 恒虚高，「悬太久」黄项对整条线持续误报；小数使章号区间比较错位。触发 = 作者手写负数/小数开启章。修法 = 同式补 `Number.isSafeInteger && >= 1`（缺字段/空串语义不变）。置信度：确凿（危害方向为持续误报，非丢数据）。

**P2-3（生成域）`src/metrics/style.ts:313-322`——readBaseline 坏 JSON 静默降级 null 零留痕，文风闸双静默失效。**
```ts
try {
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
  return coerceBaseline(raw)
} catch {
  return null   // 坏 JSON/读失败 与「文件不存在」同判，无 log
}
```
基线.json 在盘但损坏时与「从未冻结基线」不可区分 → `styleConsistencyRule.toPrompt/check`（style-rule.ts:89/95）判无基线——AI 写稿的文风约束注入与 7 维偏离去检**双双静默失效**（作者以为基线在工作）；health/style-harvest 趋势同失对照。同库同场景全部有 warn 先例（short-index.ts:278、runner.ts R37-9），独此处静默，违「降级必留痕」纪律。触发 = 基线.json 损坏或不可读。修法 = catch 补 log.warn 区分「不存在→null（正常）」与「损坏→warn + null」。置信度：确凿（代码路径与 5 个调用方核过）。

### 5.3 P2：在库登记项独立重证 2（不重复立项，供对账）

- **prefs 族**：`api/prefs.ts:90-127`（books.prefs.put）无任务闸、无串行链、无 bookMovedFailure 重验——台账 §三 B 域「config.ts PUT /config 与 prefs.ts PUT/DELETE 同型越界命中【单立·可开工】」行在库。本轮主审补充实证：`:94` 同步解析书根 → `:96` `await readJson`（body 在途最长 30s）→ `:119` `mkdirSync(recursive)` + `:121` `atomicWriteFile`——删书场景重建无 book.yaml 的幽灵目录树（repairBooks 不认领）；改名场景布局偏好静默写旧路径、200 假成功。防线族 grep 对账：bookMovedFailure 覆盖 config/documents/draft/knowledge/settings/state/style 七模块 + book-context 单源，排水链 5 条（documents/filePut/foreshadow/draftSave/structure）均不含 prefs——该族唯一裸奔写端点。
- **summary 双源**：`process/summary.ts:162-169` findChapterFile 与 `format/chapter-lookup.ts:61` chapterPathByNumber 同构双源——复审-0913-结构 P2 在库，本轮代码事实复核确认仍成立。

### 5.4 P3：新登记 ~26 项（按域合并列举，均带码证据核过）

**引擎域（12）**：① state.ts:589/:593/:800-803 `encodeOrLiteralNames` + journalFile 兜底分支死代码（healMovePending 恒传参，grep 证实）~90 行，且与 version.ts encodeDocDirName 同构（死码双源）；② structure.ts:695 `expectedRevision: computeRevision(t.abs)` 二次整读重算（多余 IO，restore origin 兜底在，正确性无虞）；③ service.ts:392 executeSave 保存锁 `5_000` 硬编码未随 META/STRUCT/WIRING 三档「常量 + 注入钩子」惯例（R30-18，测试不可缩短该档）；④ trash.ts:95-107 容错版 readTrashManifest 无指纹缓存（低频备忘）；⑤ service.ts:890-893 doCreate 消毒口径与 move（R33-9）/copy 漂移——create 对已存在目录段也过消毒（登记观察，行为自洽）；⑥ document/status.ts:63-65 `已发布` 判定第三套实现（`v===true||v==='true'` vs chapters.ts isPublishedValue 数组形态口径分裂——「导出标已发布、状态派生判 final」病态形态分裂）；⑦ events/branch-tree.ts:261-271 sortEvents 与 projection.ts:39-49 逐字双源（projection 版已 export、无环可 import）；⑧ format/style-migrate.ts:100 播种正则双实现且只认小写 `.md`（parseSampleFileName 单源漏收编；O_EXCL 重试自愈兜底）；⑨ format/style-inject.ts:113-117 截断判据码元 / 截断层码位口径混用（astral 字符提前触发截短）；⑩ format/iron-rules.ts:130 ironRulesCache 缺 forgetBookKeyedCaches 挂点（FIFO 64 兜底，无正确性影响）；⑪ events/chain-bridge.ts:277 recordForeshadowChanges 按标题 diff 无唯一性支撑（同名伏笔时快照-差分错位，审计副录面）；⑫ format/leads.ts:535 parseLeadFileName 两分支语义不一致（唯一调用方只传纯文件名，现状零影响）。

**服务端域（3）**：⑬ snapshots.ts:54 resolveDoc 未用 resolveBook 单源（内联 find + 404 样板，同文件 4 端点共用）；⑭ 错误码词表演进未收口（REVIEW_BUSY≈BUSY、BAD_KIND≈BAD_INPUT、TOO_MANY_ITEMS 与基础词表并立，信封形状统一）；⑮ analysis.ts:747 `recent.includes(ch)` 每章线性查找（微项，可 Set）。

**生成域（6）**：⑯ process/summary.ts:461-473 batch 版 afterFinalizeGenerateSummaryBatch 缺整段 try/catch（与单发版 :431-439「自留痕 promise」契约不对称；registerCtrl 现实现不抛，触发面近零）；⑰ **export/index.ts:384-386 displayNum 已发布章不居 sortKey 序前时回跳【拍板项】**——`[1,2,3,4,5(已发布),6]` 按 sortKey 序遍历得 `[6,7,8,9,5,10]`，分章前缀序号非单调（触发 = 网文回写场景发布中段章后回改前文，或 fm `序` 把已发布章排后）；需拍板 displayNum 语义（已发布固定 vs 显示序单调）；⑱ process/materials.ts:257-260 RAG 召回异常 catch 无 `e`（ragNote 有透出，失败原因不可归因）；⑲ review/contract.ts:210 冗余 as 断言（byproducts 类型已含 pieceListChecks）；⑳ ai/rules/index.ts:93 promptFiles 登记粒度为目录、宽于实际注入面（记录面>可见面，方向安全，溯源粒度粗）；㉑ prepare.ts:40-77 两层扫描与 walkMdEach 递归全树深度口径并存（一层卷约定下等价，注释已声明；short-index.ts:523 另依赖入参已排序未声明契约）。

**前端+桌面（5）**：㉒ OverviewView「继续写作」缺树滞留/加载失败守卫（:34-49 主分支不校验 ownerBook、load 失败不短路——对照 ChapterTreePanel R35-10 同型缺口注释）；㉓ stores/provider.ts:117/:136 刷新失败零留痕（对照 shelf 同款场景 toast/error 态口径，注释自认静默设计）；㉔ OverviewView 次级三路（伏笔/节奏/分析）静默失败卡片消失（与「无数据」不可区分）；㉕ 万字换算格式化 5 处散布无单源（OverviewView×3 / WordCurveChart / useShelf，格式微差）；㉖ 「写作/正文/」前缀 3 处绕过 isBodyKind 单源（ForeshadowPanel:30 / LearnView:22 / EditorDocHead:143）。另：拆分光标偏移换算双源（useChapterTreeActions:664-669 vs EditorView:62-70，注释互指维持）与 desktop/main.ts:1703 IPC `desktop:open-book` name 只验 typeof（防御不对称无实害），合计 2 项并记。

**已登记/记档项重证（不立项）**：CHAT_TOOL_NAMES 双份（D 域登记维持）；onboard-ai/onboard-save 闸键互不阻挡（R71-9 snapshotBeforeOverwrite 缓解在案）；foreshadow buildKeywordIndex 同步/异步孪生（PM-1 声明取舍）；deepseek 报告 OverviewView loadFs「实有 loadGen 代守卫」证伪结论本轮复核成立（主请求守卫在，次级三路静默为真缺口即㉔）。

### 5.5 待核 2（未及构造验证，如实标注）

- events/store.ts:1207-1258 migrateBookSession 在 `existsSync(oldDb)` 判真与 `new DatabaseSync(oldDb)` 之间库文件被外部删除 → SQLite 原地新建空库迁移空库（需迁移锁内恰有锁外进程删文件的外部干扰，正常操作链无此形态）。
- document/status.ts:47-50 文件不存在（currentRevision=null）+ 有定稿基线 → 落 'final' 显示干净态而非缺失告警（卡点：未核树枚举是否根本不列 manifest 在而文件不在的形态；倾向不成立）。

## 六、与既有登记的查重结论

独立重证 3 项（本轮子代理在**未读任何既有评审文档**的前提下独立发现，交叉验证其在库真实性）：doMergeUndo P1（=复审-0913-结构 P1×1）、prefs 族越界（=台账 §三 B 域单立行）、summary.ts 双源（=复审-0913-结构 P2）。新发现 P2×3（structure 裸 join / leads 开启章 / style 基线静默）与 P3 多数不在台账 = **全新发现，已随批登记台账 §三 E 域**。上一轮 deepseek 报告两项 P2 本轮状态：settings 补全名单缓存已修（completionNamesCache 在位）；测试装置端口抖动属 test/ 面（作者裁定暂缓，本轮未评审测试面，口径一致）。

## 七、处置编排建议

- **批 1（P1+P2 六件小修批，建议一次并发收口）**：doMergeUndo 补前置 flushUnsaved（在库复审-0913 P1，1 行 + 回归）+ structure.ts 清单路径对齐 safeManifestPath（~3 行）+ leads 开启章守卫（~2 行）+ style.ts readBaseline 补 warn（~3 行）+ prefs 族收口（在库单立项：入口 bookMovedFailure 重验，照 config.ts R0911-B-P3-4 范式）+ summary.ts 单源收敛（在库复审-0913 P2）。全为 <20 行小面改动，可 2-3 路文件互斥代理并发，L2 终门一次摊销。
- **批 2（P3 择收 + 精简随批）**：⑴-⑶/⑺/⑻/⑪/⑬/⑯/⑲/㉕/㉖ 等机械件可并一个「守卫/单源收口清偿批」；精简可收 ≈150-250 行（state.ts 死码 ~90 + sortEvents 收编 + 万字格式化单源 + as 断言 + parseLeadFileName 等；不含台账 H 档既有大账）。
- **拍板项**：export displayNum 单调性语义（§五 5.4-⑰）；两待核项（§5.5）随后续批次顺手核销。
- **收口条件**：P1 + P2 修复且回归通过（本报告 §五 5.1-5.3）；届时按惯例归档上一轮并修账文档链。

## 八、收口记（2026-09-13 源码重评修复批）

作者指令「开始修复吧，全部修复。」——本报告全部 P1/P2 与择收 P3 随批修复收口：

- **P1**（§5.1，与复审-0913-结构同项并批）：doMergeUndo 前置 flushUnsaved（`useChapterTreeActions.ts`，同节 doMergeIntoPrev/doSplitHere 自立纪律对齐；chapter-tree-actions-structure +2 用例：调用序 / 失败路不发 undo + error toast）。
- **P2 新 ×3**（§5.2）：① structure.ts readChapterState / applyChapterMerge / finishMerge / locateMergeByBody 四处清单路径 safeManifestPath 收口（越界 BAD_INPUT、回收站 originalPath 非法 NOT_MERGE_STATE——均 fail-closed；structure-merge +2 篡改回归，盘面逐字节不动断言）；② leads.ts 开启章 `Number.isSafeInteger && >= 1`（R31-15 同族口径补齐；+2 用例）；③ metrics/style.ts readBaseline catch 补 log.warn（bookRoot + 病因，文风对照失效可归因；+1 用例三断言）。
- **P2 在库重证 ×2**（§5.3 并批）：prefs.put 写前 bookMovedFailure 重验（config R0911-B-P3-4 同款；新件 r0913-srv-prefs-bookmoved 3 用例——窗口删书/改名 409 无幽灵目录、正常书不变）；summary.ts findChapterFile 收编 chapterPathByNumber 单源（= 复审-0913-结构 P2-1 同批收口，语义逐位等价，R66-6 契约测试全绿）。
- **P3 择收 20 件 / 维持 7 + 拍板 1 / 待核 2 销案**（§5.4/§5.5）：择收与维持明细 = 台账 §三 E 域「复审-0913-源码 P3 处置总账」行；displayNum 单调性维持【待拍板】；两待核经查证均不可达销案（tree 盘面枚举 / 删改名同闸互斥）。
- **编排**：波 1 四路文件互斥修复代理（A3 服务端+摘要簇完整回收；A1 结构链 / A2 格式化指标 / A4 前端桌面三路 5 小时限额阵亡——阵亡前改动已落盘，主审逐 diff 复核全部产出零回退，亲补三件套 helper 换装缺口）；主审亲修文档两件（README win 增量链补批 A = 复审-0913-结构 P2-4；执行方案头部 = 其 P2-5）；在库复审-0913-结构 P1+P2×5 并批全修（收口补记 = 该报告头部）。
- **L2 终门亲跑全绿**：vitest 全量 **1115 文件 = 7213 过 + 5 跳 0 败**（基线 1114/7196 → 净增 1 文件/17 用例，全 复审-0913 锚新件或既有文件追加）+ coverage **st 91.71 / br 87.27 / fn 96.23 / ln 91.71**（较评审基线 91.66/87.24/96.19/91.66 微升）+ tsc/vue-tsc 0 错 + eslint 0/0（--max-warnings 0）+ 三 check 过（counts 修账 1114/7196 → 1115/7213 五处后绿；win 预期 1115 文件/7134 过 + 84 跳〔差值锚 79 不动〕+ 增量链补 +1/+17）+ build:web 过 + e2e **49 过 2 跳 0 败〔41.0s，31 specs〕**（helper 收编三 spec 10 用例先行单跑零漂移）+ soak 两段 OK（−0.02MB / +0.05MB，上界 24MB）；electron-builder --dir 出包未复跑（check:packaging 过，同 HEAD 批 C 已出包实锤，如实记档）。

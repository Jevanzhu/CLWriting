# 章节结构操作三批（阶段 24 工作树改动）复审——优雅与简洁专项

- 日期：2026-09-13 落盘。
- 执行模型：GLM-5.3（主审；四路评审子代理全同模型，单波 ≤4、按文件互斥分路）。
- 评审对象：mac 工作树**未提交**的阶段 24 三批改动（基线 HEAD `304174b1`）——44 已跟踪文件（+1490/−136）+ 20 新增（src 3：`document/structure.ts` 900 行 / `format/chapter-lookup.ts` 125 行 / web-next `SplitChapterDialog.vue` 171 行；vitest 15；e2e 2）。作者未提交的 README.md/package.json（test:related 脚本）混在同一工作树，评审时识别并排除。
- 作者指令：「评审下这次修复，是否足够优雅简洁！编排下任务，并发做！」——纯评审落盘批，**零代码改动（L0 面）**，不跑测试。
- 状态：**已收口**（2026-09-13 源码重评修复批并批收口——P1×1 + P2×5 全修 + 回归通过；收口补记见下）。归档：2026-09-13 随批复位 `Archive/`（扁平）。
- **收口补记（2026-09-13 源码重评修复批；作者指令「开始修复吧，全部修复。」）**：P1×1（doMergeUndo 缺前置 flushUnsaved）+ P2×5 全修——P1 前置落盘（useChapterTreeActions.doMergeUndo，同节纪律对齐，调用序 + 失败路 2 回归）；P2-1 summary findChapterFile 收编 chapterPathByNumber 单源（保签名换体内一行）；P2-2 vitest 三件套 helper 收编 `test/helpers/structure.ts`（bindStructureHelpers 工厂参数化 BOOK/studio）；P2-3 e2e 三方 helper 收编 `test/e2e/tree-actions.ts` 扁平模块（clickSubmenuItem 收 `string | RegExp` 超集统一漂移，三 spec 10 用例零漂移）；P2-4 README:117 win 预期增量链补「阶段 24 批 A 起 +6 文件/+48 用例」（1095+4+6+8+1=1114 算术闭合）；P2-5 执行方案头部改「已实施完成」。P3×19 维持登记（明细 = 本报告 §四，两拍板项维持待拍板）。修复批整账 = `Archive/README.md` 2026-09-13 源码重评修复批收口批批记行 + 并批主报告《源代码抽样重评-进度与质量-评审-GLM-5.3-2026-09-13》§八收口记；L2 终门全绿 1115 文件 = 7213 过 + 5 跳。

## 一、结论总览

**判定：优雅合格，简洁有失守。**

- **优雅面（成立）**：架构决策全部贴合既有范式且无过度设计——`StructureRagPort` 端口注入反转守住 G5 依赖方向（零白名单回填）；per-book 串行链第 5 条照抄 filePutChains/draftSaveChains 既有范式；plan（只读干跑）→ apply（TOCTOU 指纹复核）→ finishMerge（幂等收尾）分层清晰；崩溃形态三分支与 undo 四路定位链（hints → 事件 → 回收站反查 → 正文盘面）优先级自洽。主审亲读 structure.ts 全 900 行 + chapter-lookup.ts 全 125 行：除一处死参数（P3-6）外零发现，判别惯用法（`'章号' in t`）、条件展开（exactOptionalPropertyTypes 兼容）、注释密度（约 26%）均与库内一致。
- **简洁面（失守）**：本批自己立的 `chapter-lookup.ts` 单源在 summary.ts 留了双源（P2-1）；测试 helper 三份逐字拷贝 ≈66 行（P2-2）；e2e helper 三方逐字拷贝且副本已漂移（P2-3）；同文件 busy 检查块两份逐字（P3-5）。另有**一个 P1 行为洞**（doMergeUndo 缺前置落盘，见 §二）与两处文档链状态/对账失实（P2-4/P2-5）。
- 计数：**P1×1 / P2×5 / P3×19**（明细 §四；与既有台账登记零重复——三项阶段 24 待拍板与 e2e 头注四处偏离按已知不报）。
- 精简总账：随批直接可收 **≈100–150 行**（P2 修复合计净省 ≈55–75 + P3 机械项 ≈45–75；e2e 三方全收编口径取上界）。其中 ≈20 行（弹窗按钮样式第三份）属跨域既有族、宜归并台账 CSS 族批次。

## 二、P1×1（行为洞，必修）

### P1-1 doMergeUndo 无前置落盘——dirty 目标章的撤销被本地编辑静默写回，撤销半失效 + 内容两章重复

- **位置**：`src/studio/web-next/src/composables/useChapterTreeActions.ts:612-639`。
- **证据链（主审逐环亲核）**：
  1. 同文件节注释 :518-520 自立纪律：「动作前照 doDelete 范式先落盘脏内容——结构操作以盘上内容为准，脏内容不落盘就动结构会『合并了半章』」；`doMergeIntoPrev`（:546-551，两章都 flush）与 `doSplitHere`（:651-654）都遵守，**唯 `doMergeUndo` 全函数无 `flushUnsaved`**，从 `ui.ask` 直达 `structureMergeUndo`。
  2. `doc.ts` refresh 的 dirty 分支（:569-586）：`mergeFm(content, stripFrontmatter(e.content), { stripLeading: false })`——fm 以服务端为准、**正文保留本地**，且 `e.baselineRevision` 更新为回滚后 revision。
- **后果链**：目标章 dirty（30s autosave 窗口内键入——撤销并入的常见姿势恰是刚看完合并结果就在编辑器里）→ 服务端回滚目标章 + 还原源章 → refresh 保留本地合并后正文且基线已对齐 → 下次 ⌘S/autosave 乐观锁**通过**，把合并后正文写回 → 源章已还原 ⇒ 同一段内容两章重复、`并入` 已摘、结构上无从再识别，全程无提示。
- **修法**：`doMergeUndo` 开头（ui.ask 前）补 `if (!(await flushUnsaved(node.docId))) { ui.toast('该章未保存的修改无法自动落盘（保存失败或版本冲突），请先处理后再撤销并入', 'error'); return }`——三行，与既有两动作对齐（源章软删时已 `doc.discard`，无缓存条目，单章即可）。
- **回归**：`chapter-tree-actions-structure.test.ts` 补 undo 路线用例（mock 断言 `waitInflightSave`/`save` 先于 `structureMergeUndo`；落盘失败分支中止零调用）。

## 三、P2×5

### P2-1 summary.ts `findChapterFile` 与本批新建单源 `chapterPathByNumber` 双源同构
`src/process/summary.ts:162-169` 与 `src/format/chapter-lookup.ts:61-71` 逐行同构（existsSync 守卫 + `chapterNamePrefixes` + 同一 `walkMdFind` 谓词 + `mergedIntoMap` 回退；唯一差异是 existsSync false 时早 return null，而后者经 mergedIntoMap 内部同守卫收敛到同一结果）。本批自己立「章号回退 helper 单源」又留双源，定位口径演化（前缀集调整等）必漏一处。修法：`findChapterFile` 保签名、体内一行 `return chapterPathByNumber(bookRoot, chapter)`（process→format 无环；test/fs/walk-md 直测本函数不破）。净省 ≈6 行 + 消双源。

### P2-2 vitest structure 三件套 helper 三份逐字拷贝
`structure-merge.test.ts:34-45,77-89` / `structure-split.test.ts:30-41,67-79` / `structure-crash.test.ts:56-60,66-78`——`chapterContent`/`createChapter`/`structureEvents`（split 名 splitEvents）三组 ≈66 行重复（主审 bash 对照逐字核实：merge vs split 的 24 行 helper 块仅差函数名与 BOOK 值）。收编 `test/helpers/`（`structureEvents` 三份完全逐字优先；库内无既有 events 读侧 helper，grep `iterateEvents` 仅这三件 + store 自测）。净省 ≈20–25 行，随后续 structure 测试递增放大。

### P2-3 e2e 三方 helper 逐字拷贝且副本已漂移
`structure-ops.spec.ts:23-59` / `structure-volume-move.spec.ts:49-119` / 既有 `tree-ops.spec.ts:16-40`——`gotoBook`（两新件逐字节同含注释）/`ctxOn`（三方同）/`createChapter`（10 行函数体逐字节同，seed 前缀契约双份维护）/`deleteChapter`（逐字同）/`hoverSubmenu`/`clickSubmenuItem`。**漂移已发生**：tree-ops 的 clickSubmenuItem 收 `name: string`，volume-move 收 `name: string | RegExp`。项目 e2e 有扁平共享模块先例（page-error-baseline.ts 29 spec 引用 / e2e-ports.ts 等，均基建类），UI 动线 helper 收编 = `test/e2e/tree-actions.ts` 扁平模块（不必建 helpers/ 子目录）；涉已提交的 tree-ops.spec.ts，可作后续小批。仅收编两新件净省 ≈27 行，三方全收编 ≈45 行；主要收益实为单源维护（createChapter 的 seed 前缀契约只留一处——正是台账裸标题盲点项的实现面）。

### P2-4 README win 预期增量链漏列批 A，括号内算术不闭合
`README.md:117`：自「上次 win 实跑 1095 文件 = 6984 过」起算，所列增量（重评-0912-4 +4/+21、批 B +8/+59、批 C +1/+5）合计只到 1108/7069，与头部声称的 1114/7117 差 **+6 文件/+48 用例——恰为批 A**（执行方案 §六批 A：基线 1099/7084 → 1105/7132）。头部数字本身自洽（1099+15=1114、7196−79=7117 全链可对账），仅增量列举漏项致读者无法从链条复核——恰是该项目 check 文化要防的口径断链。修法：列举中补「2026-09-13 阶段 24 批 A 起 +6 文件/+48 用例」（插在 0912-4 与批 B 之间）。

### P2-5 执行方案头部状态「待开工」与自身 §六 及总览矛盾
`Dev/Docs/02-执行/章节结构操作-执行方案-2026-09-04.md:3`：仍写「状态：**待开工——实施待作者指令**」；同文件 §六批 C 块写「阶段 24 全三批完成」、总览地图行写「已落盘 v2 并实施完成」。三批记档时改了总览与 §六、未回改本文件头部（体例行亦无「状态以总览为准」委派句；设计方案 :3 尾部残句同族 → P3-19）。修法：头部状态改「已实施完成（2026-09-13 三批收口，执行记录 = §六）」。

## 四、P3×19（分域清单；修复批择收 / 拍板项注明）

**产品侧（src）**
1. `src/format/chapters.ts:40,57,68`——剥成对引号逻辑同批手写三遍（`q === '"' || q === "'" && … slice(1,-1).trim()` 逐字同）→ 模块级局部 `stripPairedQuotes` 3 行单源。省 2–3 行。
2. `src/document/tree.ts:192`——`if (n.children.length > 0) sortTreeByOrder(n.children)` 恒真（:175 `length === 0` 已 continue）→ 去掉 if；连带 :185-189 map 保位重建（fi++ 副作用 + 非空断言）可改 `filter(isDirectory).concat(files)` 直白形。省 2 行。
3. `src/process/prepare.ts:69`——catch 分支 `mergedIntoMap(bookRoot).get(chapterNo) ?? null` 近乎恒无效：try 内唯一 throw 源 readdirSync(bodyRoot) 失败时 mergedIntoMap 读同一目录必空 Map/同样失败，白付一次全书 meta 扫 → 改 `return null`（正常路径末行回退不受影响）。
4. `src/ai/orchestrate/self-heal.ts:1004-1007`——第二道结构键保形（`preserveStructureFmForChapter`）与 saveDraft 锁内 `preserveStructureFmIn`（draft-pipeline.ts:198-201，先于留底与 journal pending）完全重叠：盘上/快照/journal 三路已带键，增量价值仅剩 runGenerate 返回文本口径。注释自认「两道共保」属有意纵深——**去留待拍板**（移除改返回 `assembled.content`，省 ≈5 行 + 每次成功产出一次读盘）。
5. `src/studio/server/api/documents.ts:767-781 与 856-870`——structure-apply 与 merge-undo 两份逐字相同的 busy 检查块（含文案）→ 局部 `structureBusyOf(name): string | null` + 两处早退。省 ≈13 行。
6. `src/document/structure.ts:500-507`——`finishMerge` 的 `_source` 参数死码：函数体零引用，注释所称「仅用于类型收窄语义」不成立（调用方传参无收窄效应）→ 删参 + 两调用点。省 ≈6 行。【主审亲读发现】
7. `useChapterTreeActions.ts:456-488 vs :525-535`——新抽 `flushUnsaved` 与 doDelete 的 R44-3/R59 内联落盘判式双源（逐分支等价）→ doDelete 改 `unsaved = entry ? !(await flushUnsaved(...)) : false`。省 ≈8 行，后续判式修订单点化。
8. `useChapterTreeActions.ts:555/561、673/679、698`——`plan = r.plan as MergePlanView` 之后 `if (plan.op !== 'merge') return` 类型层恒假的死守卫（split 侧同款 + `'newDocId' in r` 结构上不可达）→ 去 as、声明联合类型让 op 守卫真收窄（更优 = api/documents.ts 函数重载按 body.op 收窄，三处防御全消）。
9. `useChapterTreeActions.ts:556-560/605-608/635-638/709-712`——catch 样板（R34D-21 切书守卫 + friendlyError）新增 4 处，与既有 8 处累计 12 处 → 每函数入口局部 `report` 闭包收敛。省 ≈8 行。
10. `web-next api/documents.ts:328-337`——`structureMergeUndo` 的 hints 死参数面：唯一调用方（useChapterTreeActions:628）恒省略、5 可选字段全库零传参；另一端 doMergeIntoPrev :590-594 完全丢弃 apply 返回值（`MergeApplyOk.trashEntryId/rollbackSnapshotId/planHash` 恰为 hints 形状却无人接）——「两端预留、中间无链」。与台账 undo 回收站反查歧义项联动拍板：定「恒 {}」可砍 hints；定「回传定位」需补持久化链（现弹窗关闭/切书即丢）。
11. `useChapterTreeActions.ts:615-624`——撤销并入确认弹窗缺 `danger: true`（message 明言「合并后的新改动会丢失」；全库 9 处 danger 先例含同类不可逆丢失——HistoryPanel 版本回滚/TrashPanel/doDelete）→ 补一行。
12. `SplitChapterDialog.vue:148-171`——`.btn/.btn.primary:disabled` 弹窗按钮样式第三份复制（ChapterMetaDialog 第四份且已漂移——Meta/Split 版无 hover）→ 共享按钮样式类。省 ≈20 行（跨域既有族，宜归并 CSS 族批次）。
13. `web-next api/documents.ts:226-344`——新增 MergePlanView/SplitPlanView 等全用 `/** */` JSDoc（含字段级），同文件既有接口一律 `//` 单行前置 → 顺手统一。

**测试侧（test/）**
14. `structure-crash.test.ts:36,48-49`——userDataPath 手写 `Date.now()+Math.random()` 随机名（同批兄弟文件均 `mkdtempSync`）+ `studio.close()` 未 await（merge:122/split:94 均 await，游离 promise 与后续清理并发）+ 两处动态 `await import('node:fs')`（顶部已静态 import）→ 三处对齐兄弟文件范式。省 ≈4 行。
15. `structure-fm-preserve-draft.test.ts:19-25`——`postDraft` 手写 fetch 包装，`bootStudio` 的 `studio.req` 已覆盖（唯一差异 origin 头，draft.ts 不检查，r0912-4 免 origin 跑通即证）→ 直接 `studio.req('POST', …)`。省 ≈7 行。
16. `tree-order.test.ts:79-89`——「非正文目录不受影响」用例三断言全 presence 检查，任何排序下都绿（用例名说按 localeCompare 现状却未锁顺序事实）→ 断言升级 `toEqual([...])` 钉死。

**文档侧**
17. `test/e2e/spec-order.guard.test.ts:3,23`——头注「29 specs」「第 30 个 spec」过时（现 31/32）→ 更新或标注 R27 时点历史口径。
18. `Dev/Docs/00-总览…:阶段 24 行`——「残留挂账两项」与台账 §三 阶段 24 三项计数不齐（裸标题建章系批 B 登记的既有行为观察，非实施残留）→ 改「两项实施残留 + 批 B 另登记一项既有行为观察」或统一口径三项。
19. `设计方案-2026-08-30.md:3`——头部尾部残句「实施待作者指令」（该文体例行有总览委派兜底，较轻）→ 随 P2-5 一并顺清。

## 五、干净面与排除项（正面认定）

- **主审亲读**：`structure.ts` 900 行（分层/命名/判别惯用法/planHash TOCTOU 复核/undo 四路定位链优先级/条件展开）除 P3-6 死参数外零发现；`chapter-lookup.ts` 125 行干净（registerMergedInto 登记单源 + 成本口径注释如实）。
- **R1 排除项（有实据）**：check/run.ts 手写并入 max 循环（chapters 数据在手，改 mergedIntoMap 反多付全书扫）合理；foreshadow 同步/异步孪生 = 项目镜像纪律；structStatus WRITE_ERROR 500→409 无前端兼容面（web-next 全无该码特判）；state 报文语序与 API 语义自洽；第 5 条串行链 = 既定范式非冗余；注释面全部属常态解释性注释。
- **R2 干净面**：SplitChapterDialog 弹窗范式与 ChapterMetaDialog 逐条对齐（teleport/mask/aria/R71-31 重开复位/R35-36 焦点圈/R61-3 IME Enter/R49-29 让渡）；doSplitHere 正文坐标→全文偏移与 EditorView body computed 精确互逆；chapter-tree.ts 两新函数单一职责；friendlyError 新错误码走既有路径；无死码/未用导出/没人用的 props。
- **R3 总检**：15 件新测试 2543 行 bootStudio/scaffoldBook 复用到位、零快照断言、期望值普遍钉死（多件整文件逐字节 toBe）、无 mock 掉被测本体；修改 7 件 diff 全部最小必要（orchestrator-mutex-gates +109 五新角与既有角同构收敛，三正向 409 角各断不同闸文案，非换参空洞重复）；用例过量零发现（唯一弱断言 = P3-16）。
- **R4 一致性核对通过项**：spec-order.snapshot +2 行字典序位置正确（`diff <(ls *.spec.ts | LC_ALL=C sort) 快照` 字节一致）；guard「测试体内现读快照」修法最小；执行方案 §六 三批 L2 数字与 README 逐位一致（1105/7132 → 1113/7191 → 1114/7196 全链对账闭合）；设计方案 v3 修订可辨识（修订记 + 行内标注 + 删除线，非无说明改写）；台账 §三 三项格式一致；Archive/README 批记行齐、计数与目录实态吻合（22 篇 .md）。

## 六、编排与对码实录

- **单波四路文件互斥**（作者上限 ≤4）：R1 server 侧 20 文件 diff / R2 前端 10 文件（含 SplitChapterDialog 全文）/ R3 vitest 15 新 + 7 改 / R4 e2e 面 + 文档链 11 文件。全程在途 = 4。
- **主审亲读**：structure.ts + chapter-lookup.ts 全文（算法核心）；四份新测试/e2e spec 已在上下文（structure-ops / structure-volume-move / chapter-tree-actions-structure / tree-menu-structure）。
- **主审对码裁决**：P1-1 逐环亲核实锤（节注释纪律 / 两兄弟动作对照 / doc.ts refresh dirty 分支语义链）；P2-1/P2-4/P2-5 亲读实锤；P2-2/P2-3 bash 对照逐字核实；P3 抽核 2 件（tree.ts 恒真分支 / busy 块两份）实锤，其余带实码证据采信。子代理自查排除项照录 §五（防复查重derivation）。
- 本批零代码改动、零测试运行（L0 纯评审面）。

## 七、收口条件与处置建议

- **收口条件**：P1-1 + P2×5 修复且回归通过（L1 相关面 + 收口批 L2 终门）后本报告收口归档；P3×19 按域登记/择收（拍板项 = P3-4 与 P3-10，联动既有台账两项）。
- **处置建议编排**（供作者「全部修复」时参考）：主审亲修 P1-1（行为洞三行 + 回归用例）与 P2-4/P2-5（文档链）；P2-1/P3-1~6 产品侧机械批一路；P2-2/P3-14~16 测试侧一路；P2-3（涉已提交 tree-ops，可并批或单列）；前端 P3-7~13 一路——单波 ≤4 文件互斥可两波收口。
- 出处短名：**复审-0913-结构**。后续批记/台账回填引用本报告用此短名。

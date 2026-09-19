# 源码独立重评七轮（非全量精度）

- 执行模型：GLM-5.3（主审与会话同模型；4 只读评审子代理同模型，无跨模型差异）。
- 日期：2026-09-19。
- 作者指令：「忽略掉现有文档，重新评审下当前项目源代码，不需要全量精度代码，评审结果形成一个文档。」——第七次独立重跑，口径沿六轮（降精度：分域核心通读 + 次要抽样）；本轮指令**不含修复**，处置随作者另令。
- 基线：`b55d27ca`（win 线 HEAD = 六轮修复 + 复核处置 + 快进同步批 + 2 条纯文档记行；自六轮修复批 `3282ee24` 起源码零改动，本轮评审对象与六轮修复后源码树一致）。
- 纪律：全程不读 Dev/Docs 既有评审/报告文档，结论仅凭源码独立产生；只读评审零文件改动（L0 纯文档面，测试不涉）。
- **处置记（2026-09-19 同日修复批，作者指令「全部修复！」）**：P3×5 全量真修——七轮-1/2 trash 两端点补 bookMovedFailure 书注册重验（words-diary.post 同款）+ bookMovedFailure 增盘面 existsSync 校验（书根不在盘即 BOOK_MOVED，陈旧注册窗由盘面闸收口）/ 七轮-3 chat 队列溢出预览改 clipByCodePoints 单源 / 七轮-4 章号拦截收敛 chapterNoFromName 单源（**报告原文「0012.md 亦被拦」推演按 R1010c-EN-P2-1 在案口径勘误——裸数字+.md 不命中，本修不扩识别集、维持登记待拍板**）/ 七轮-5 前端四处改 clipByCodePoints 单源。回归净 +10 用例/+1 文件；门 = L2 win 亲跑九门一次全绿（vitest 1269 文件 = 7711 过 + 76 跳 0 败一次净跑 365.67s + tsc/vue-tsc/eslint 0 + 三 check 过 + e2e 51 过 3 跳）。随批收口归档 `Archive/`（明细见 §四），批记 = `Archive/README.md`。

## 一、结论

**六轮修复面零复发；增量 P1×0 + P2×0 + P3×5；B 域（AI 链路）零发现。**

六轮四处修复实证在位：gen.ts 每 chunk 新 timer+新 deferred（流中挂起检测）、chat-bridge.ts gap 标记合并计数（A101，`src/events/chat-bridge.ts:219-243`）、structure-split/merge 预览码点截断（clipByCodePoints 单源）、verify-responses-relay 注释勘误。五轮及更早修复面经四域扫查同样零复发。发现面向外围边角收敛（回收站/改名竞态窗、两处码元截断边角、一处定稿防线正则口径分裂），主链路（生成/流式/记账/持久化/前端状态）零缺陷。

## 二、发现明细（全部 P3，主审逐条对码复核成立）

### 七轮-1 | P3 | 回收站 restore/purge 端点缺 bookMovedFailure 书注册重验

- 位置：`src/studio/server/api/documents-crud.ts:272-291`（trash.restore / trash.delete 两 handler）。
- 机理：两端点 `resolveBookOrReply` 后直接 `restoreTrash/purgeTrash`，无书注册重验——落地面 `src/document/trash.ts:344` `mkdirSync(dirname(origAbs), { recursive: true })` 在多个 await（finishRestoreBookkeeping 等）之后对原位置重建目录。同文件 words-diary.post（:58-59）与 documents/style/knowledge/config/check 六族写端点均有 bookMovedFailure 重验，唯 trash 两端点漏配；trash 亦不持任务闸、不进串行链，drain 与闸两道全局防线均不兜底。
- 触发：A 标签页删书/改名（books.jsonl 登记已改写、磁盘已搬走）与 B 标签页回收站「恢复/彻底删除」精确并发。
- 影响：对旧 bookRoot mkdir 重建无 book.yaml 的孤儿目录碎片（repairBooks 不认领），该次操作静默丢失但响应 200。单请求窗口窄，故 P3。
- 修复方向：restoreTrash/purgeTrash 调用前加 bookMovedFailure 重验，与 :58-59 同款。
- 置信度：高（子代理发现，主审对码核实）。

### 七轮-2 | P3 | 改名/删书「磁盘搬移先于登记改写」的陈旧注册窗

- 位置：`src/studio/server/api/books-rename.ts:198-247`；`src/studio/server/api/books-lifecycle.ts:347-376` 同型（窗更短）。
- 机理：改名序列 = `renameWithRetry`（:198 磁盘已搬走）→ `await clearChatHistory`（:217）→ `await migrateBookSession`（:223，可数秒）→ `await tryBooksLockAsync`（:247）后才改写 books.jsonl 登记。窗口内 `resolveBook(oldName)` 仍命中旧 path 条目、bookMovedFailure 比对通过——写端点的重验防线被陈旧注册骗过，可对旧路径 mkdir 落孤儿（已核实落地面：words-diary POST `mkdirSync(join(bookRoot,'项目'))`；documents 新建按「清单不存在 = 合法空清单」直写）。
- 触发：改名进行中（秒级窗）或删书中（短窗）并发发起写字数日记/新建文档/启动生成。
- 影响：旧路径出现幽灵目录碎片，书架不可见、repairBooks 不认领；该次写入静默丢失（响应 200/201）。概率低故 P3。
- 修复方向（任一）：renameWithRetry 成功后、任何 await 前先同步更新内存登记（或 books 锁内先改登记后搬盘）；或 bookMovedFailure 增加盘面存在性校验（bookRoot 不在盘即判 BOOK_MOVED）。
- 置信度：中高（窗口序列与落地面均经主审源码核实）。

### 七轮-3 | P3 | chat 队列满丢最旧消息的预览码元截断（六轮 C101 同族漏网）

- 位置：`src/ai/orchestrate/chat.ts:138`。
- 机理：`fullPreview.slice(0, 40)` 按 UTF-16 码元截断，消息第 40/41 码元恰为代理对（emoji/扩展平面字符）时劈出孤立代理项，notice 文案尾字符渲染为替换符。六轮 C101 已把拆分/合并预览收敛 clipByCodePoints（`src/shared/text.ts` 单源），本处同族漏网（主审亲审发现；B 域子代理未及报告，主审对码成立）。
- 触发：运行中对话队列满 10 条再发消息，被丢弃的最旧消息含 emoji 且恰跨第 40 码元边界。
- 影响：一条 notice 文案尾字符乱码，纯视觉降级，无数据面。
- 修复方向：`clipByCodePoints(fullPreview, 40)`（单源已在位，替换一行）。
- 置信度：高。

### 七轮-4 | P3 | 定稿章号拦截窄正则未收敛 chapterNoFromName 单源

- 位置：`src/document/draft-path.ts:127`。
- 机理：`base.match(/^(\d+)-/)` 仅认 ASCII 连字符；单源 `format/filename.ts:144` `chapterNoFromName = /^(\d+)(?:[-—]|\s|$)/` 另认 em-dash、空格、裸数字结尾。定稿章被外部改名成 `5—标题.md` / `5 标题.md` / `0012.md` 后，清单 finalizedRevision 挂旧 path，精确 path 分支与章号分支（窄正则）双双不命中 → ensureChapterNotFinalized 放行覆盖写。同族既有修复（B005/P3-11/R1010-P3）均已收敛宽口径，本处是最后一处内联分裂实例（RB-KN-P1-2 修了补零口径但未换单源正则）。
- 触发：定稿章经外部工具改名 + 随后 AI 续写/重写同章号（前置条件多，故 P3）。
- 影响：已定稿正文被覆盖（数据丢失类；`工作区/.版本` 定稿版本链仍在，可手工找回）。
- 修复方向：`chapterNoFromName(base)` 替换内联正则（与 summary.ts/finalize.ts 同法收敛）。
- 置信度：高（代码差异确凿；resolveDraftPath 为唯一调用点已核）。

### 七轮-5 | P3 | 前端四处面向用户文本码元截断劈代理对

- 位置：`src/studio/web-next/src/components/audit/AuditEventList.vue:63`（chat message 摘要 `.slice(0, 60)`）、`:70`（goal 摘要同）、`:117`（JSON 详情预览 `.slice(0, JSON_DETAIL_LIMIT)`）、`src/studio/web-next/src/components/style/StyleEntryPanel.vue:83`（删除确认弹窗 `text.slice(0, 24)`——`text.length > 24` 判「…」加否亦随劈半差一）。
- 机理：与七轮-3 同族（String.slice 码元切）。仓内已有两套守卫先例：`stores/workbench.ts:198` 孤儿低位守卫、`stores/chat.ts:70` `Array.from` 码位迭代。grep 核实 web-next 其余 `.slice(0,` 命中均为数组/路径/日期等 ASCII 安全面。
- 触发：消息/目标/文风条目含 emoji 或扩展平面字符且恰跨截断边界。
- 影响：展示文本边界一字符渲染为替换符；纯视觉降级，不落盘。
- 修复方向：四处对齐仓内守卫惯例（clipByCodePoints 式码位截断或孤儿低位守卫）。
- 置信度：高。

## 三、覆盖面与方法

- **方法**：主审 + 单波 4 只读子代理分域（沿六轮口径：A 数据与服务层 / B AI 链路 / C 文本管线+桌面+进程 / D web-next+基建；单波 ≤4 遵治理正本纪律条）。执行注记：首波派发撞 5 小时子代理额度上限全数失败，作者重置额度后重派成功；间隙期主审亲读 9 件（见下），该 9 件在子代理任务书中明示跳过不重读。
- **主审亲读（9 件全文件）**：src/ai/gen.ts、runner.ts、retry-policy.ts、provider/openai-adapter.ts、provider/responses-adapter.ts；src/studio/server/api/files.ts、api/io.ts、http.ts、serial-chain.ts。另核实 readBookConfig 容错（错误分支回默认深拷贝恒不抛，撤销 runner 预算闸裸调疑点）与全域码元截断/路径安全/非原子写模式扫查。
- **A 域子代理**：server 核心 6 件（index/router/static/ttl-cache/book-context/dev-port）+ api/ 其余 51 件全读；fs 11 + state 4 + cache 5 + events 11 通读；git/metrics/log 抽样 6。撤销候选 8 则（drain 键口径、fsBackoffSleep、tmp 清扫竞态等，均核实有守卫）。
- **B 域子代理**：provider/ 其余 18 件 + orchestrate 13 件 + prompts 10 件 + ai 根层 11 件 + tasks/contract/rules/tools 25 件 + rag 8 件 + knowledge 2 件 = 87 件全读（含边界验证 format/chapters、fs/walk-md、process/materials、api/rag）。**零发现**；撤销候选 15 则（anthropic 双计、budgetTailCut 边界、rag 乱序/续传/毒行族、mock-tool 原型链键等，均核实有守卫）。「模型可见⟺已记录」「默认值显式 resolve」两守则无违例。
- **C 域子代理**：shared 4 + format 29 + document 24 + process 18 + desktop 24 = 99 件全读（+async/worker-async）；check 5/17（派单重点三件全读）、driver 5、export 3、learn 2、review 2、install 3 抽样。撤销候选 3 则（清单读失败 fail-open 系头注明示设计、代理对截断全链已收敛单源、chapterNoFromName 调用形系在案登记项）。桌面/进程子域零发现（凭据链、IPC 暴露面、进程生命周期、跨平台面逐项核实）。
- **D 域子代理**：stores 17 + composables 21 + api 28 + views 8 + pages 4 + editor 2 全读；shared 抽 5、components 抽 13/99（草稿/补全/长列表优先）；scripts 13 件 + ci.yml/desktop.yml/win-vitest-retry action + 根配置 8 件全读。撤销候选 6 则（workbench/chat 两处截断守卫在位、Book.vue `:key="bookName"` 统一重建消切书竞态面、doc 双窗复检在位等）。CI 矩阵/锚日期（2026-10-31 未过期）/asar 产物时序/soak 门均核实。
- 覆盖面弱于五轮 8 域两波逐文件通读、与六轮同口径（D 域 components 抽样 13/99、C 域 check/install 抽样）——「不需要全量精度」指令口径内如实记档。

## 四、处置

作者同日另令「全部修复！」——五项 P3 全数真修落批，报告随批收口：

- **七轮-1 + 七轮-2**（trash 端点缺重验 + 陈旧注册窗）：`src/studio/server/api/documents-crud.ts` trash.restore / trash.delete 两 handler 在 resolveBookOrReply 后补 `bookMovedFailure` 重验（:58-59 words-diary.post 同款）；`src/studio/server/book-context.ts` bookMovedFailure 增盘面校验——登记比对通过后 `existsSync(capturedRoot)` 不在盘即判 BOOK_MOVED，「磁盘搬移先于登记改写」窗口内旧注册骗过比对的面由盘面闸兜住。端点入口重验为确定性拦截；端点内多 await 的 intra-call 窗（七轮-1 机理段）未另立时序改造，由入口盘面闸一次收口，如实记档。回归：新件 `test/studio/trash-book-registration-guard.test.ts` 4 例（restore 改名窗 409 / restore 盘面已删 409 / purge 改名窗 409 / 正控 intact 无清单 404 NOT_FOUND）。
- **七轮-3**：`src/ai/orchestrate/chat.ts` 队列溢出预览改 `clipByCodePoints(fullPreview, 40)`（单源收编，六轮 C101 同法）。回归：`test/ai/chat-steer.test.ts` 扩 1 例（'𠮷' 恰跨第 40 码元边界；断言 notice 含全字符且无孤立代理项）。
- **七轮-4**：`src/document/draft-path.ts` ensureChapterNotFinalized 章号分支由内联 `/^(\d+)-/` 收敛 `chapterNoFromName` 单源（format/filename.ts；em-dash/空格/裸数字尾口径随单源）。**勘误一条**：本报告 §二机理段称 `0012.md` 亦被拦——按 R1010c-EN-P2-1 在案口径 chapterNoFromName 对裸数字+扩展名不命中，该形态仍放行；本修不扩识别集（扩集波及该单源全部消费方，维持登记待拍板），拦截面以 em-dash/空格改名形态为限。回归：`test/format/draft.test.ts` W-P2-2 组扩 1 例（em-dash 与空格双形态定稿后磁盘再改名 → 章号分支仍拦截；非定稿章正控不误伤）。
- **七轮-5**：四处全改 `clipByCodePoints` 单源——`AuditEventList.vue` message 摘要（60）/ goal 摘要（60）/ JSON 详情（JSON_DETAIL_LIMIT）/ `StyleEntryPanel.vue` 删除确认（24，「…」判据随改 `clipped === text`）。回归：`test/studio/webnext/r0911b-audit-event-list.test.ts` 扩 3 例 + `test/studio/webnext/r36-22-style-await-guard.test.ts` 扩 1 例（均钉「含完整代理对字符 + 无孤立代理项」）。

门与记档：L2 win 亲跑九门一次全绿——vitest 全量 1269 文件 = 7711 过 + 76 跳 0 败一次净跑 365.67s / tsc 0 / vue-tsc 0 / eslint 0/0 / 三 check 过（counts 1269/7711/33/54 README 修账后对账绿 / packaging / knowledge）/ e2e 51 过 + 3 跳 1.1m（跳 = 发布门 spec 预期口径）；coverage 按 CI 单腿 ubuntu·24 阈值门兜底未本地重跑。净 +10 用例/+1 文件，全无平台门，差值锚 68 维持（mac 口径 7779 = win 7711 + 68；根 README 五处修账随批）。改动面：src 6（documents-crud / book-context / chat / draft-path / AuditEventList / StyleEntryPanel）+ test 5（新 1 / 扩 4）+ 根 README = 12 路径。报告随批收口归档 `Archive/`（01-评审 1→0、Archive 14→15），批记 = `Archive/README.md`。

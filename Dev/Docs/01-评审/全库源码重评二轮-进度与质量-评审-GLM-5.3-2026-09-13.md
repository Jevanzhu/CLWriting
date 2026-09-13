# 全库源码重评二轮：进度与质量（2026-09-13）

- 日期：2026-09-13。性质：纯评审落盘（零产品码改动，L0 文档面）；**处置待作者指令**（「报告完成≠收口」，CLAUDE.md 口径）。
- 基线：`2f59db89`（win 分支，工作树净）。
- 执行模型：GLM-5.3（主审）；子代理五路只读（Explore，同模型，两波 3+2，单波 ≤4）。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目源代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」
- 与同日早前评审的关系：win 适配专项重评（同日，其落盘批 + 修复批已入库 = 本报告基线 `2f59db89`）之后的**第二轮全库重评**。本轮无专项侧重、对全源码重新独立核查；方法与发现均独立得出（P2 级逐条主审亲验对码），不以历轮评审结论为前提。

## 一、评审口径与方法

**忽略既有评审文档**：本报告不以 `Dev/Docs/`（含 Archive）历轮评审结论为前提，全部发现来自本轮对源码的直接核查（file:line 以基线工作树为准）。总览/台账/根 README 仅用作**进度事实**的记账来源（阶段状态、测试计数、coverage 历史值），引用处均已标注——记账非评审结论，不违作者指令口径。

覆盖面（src 计 961 个 .ts/.vue 文件、约 35.3 万行；test 计 1126 个测试文件）：

| 域 | 覆盖方式 |
|---|---|
| src/studio/server 全部 50 + src/install 全部 8（58 文件，无抽样） | R1 只读子代理逐行彻查 |
| src/desktop 16 + src/git 2 + src/process 18 + scripts 12 + .github/workflows 2 + 构建/CI 配置 6（56 文件，无抽样） | R2 只读子代理逐行彻查 |
| src/ai 78（30 核心逐行 + 51 声明/薄壳/纯数据表抽样）+ src/rag 6 + src/check 14 + src/knowledge 2 | R3 只读子代理彻查 |
| web-next 逻辑层 92 文件（stores 17 / api 28 / composables 17 / editor 2 / shared 18 / types 2 / pages 4 + 入口，无抽样） | R4 只读子代理逐行彻查 |
| web-next 视图层：views 8 + components 96 + styles 4 + 伴生全局 css 2（无抽样） | R5 只读子代理逐行彻查 |
| 核心数据域：fs 四大件（atomic.ts / cross-process-lock.ts / safe-path.ts / md-text-cache.ts）+ document 五大件（service.ts 2223 / structure.ts 920 / manifest.ts 522 / journal.ts 401 / trash.ts 551）+ state.ts 1169 + export/index.ts 698 + metrics/style.ts 453 | **主审逐文件亲读**（约 6900 行） |
| 质量门 | 主审 win 本机实测（§二） |
| P2 级发现 | 主审逐条亲验对码（§三标注；P2-2 附本机字节级实证） |

编排：两波文件互斥只读子代理（3+2，≤4 上限内），主审同时亲读核心数据域并对 P2 逐条亲验——请求洪峰受控、域间零重叠零遗漏。

## 二、实测质量门（win 本机，2026-09-13）

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **0 错误** |
| `npm run typecheck:web`（vue-tsc） | **0 错误** |
| `npm run lint`（eslint --max-warnings 0） | **0 错误 0 警告** |
| `npm run check:counts` | **过**（README 计数与实际一致） |
| `npm run check:packaging` | **过** |
| `npm run check:knowledge` | **过** |
| `npm test`（vitest 全量） | **1126 文件 = 7176 过 + 84 跳 + 0 败（400.23s）**——win 口径**一次全绿**，与根 README win 预期链（1126 文件 / 7176 过 + 84 跳）逐位吻合，零假红零重跑 |
| `npm run test:e2e`（Playwright） | **49 过 + 2 跳（1.0m）**——2 跳 = 发布 smoke 需 `CLWRITING_E2E_RELEASE` 环境变量，与根 README 口径一致 |
| soak（两段） | **两段 OK**——有界往返循环 100000 迭代 heap 8.32MB→8.29MB（增长 −0.02MB）；RAG 召回循环 20000 迭代 8.82MB→8.88MB（+0.06MB）；上界均 24MB |

本轮未跑 coverage（L2 重门）；最近一次记录值 = 91.71 / 87.27 / 96.23 / 91.71（2026-09-13 源码重评修复批 L2 终门，出处台账 §一），如实标注引用非本轮实测。

## 三、发现清单（P1×0 / P2×2 / P3×4）

分级沿用项目口径：P1 = 丢数据/功能破坏；P2 = 边界场景出错/需用户干预；P3 = 健壮性缺口/打磨。

### P2（2 件，均出自 R0913-win 修复批最新代码，均主审亲验对码属实）

**P2-1｜跨提权双开防线只接了一半：退出照发，但「跳过全部生命周期注册」未随之生效（R2 发现，主审亲验）**
- 证据：`src/desktop/main.ts:228-236`——顶部双闸 `if (!gotSingleInstanceLock || !appInstanceGuard.acquired) { app.quit() }`；`src/desktop/main.ts:2003-2005`——底部守卫 `if (gotSingleInstanceLock) {`（Z-P2-8 注释：第二实例跳过全部生命周期注册）。**文件锁标志 `appInstanceGuard.acquired` 在底部守卫未被消费**。
- 影响：跨提权双开（管理员/普通用户各开一份——Electron 锁按会话/提权上下文隔离、双开双方各自持 Electron 锁；正是 R0913-win 新增 app-instance-guard 文件锁防线要堵的场景）时，第二实例 `gotSingleInstanceLock=true` 而 `appInstanceGuard.acquired=false`：quit 照发，但底部守卫只看 Electron 锁，whenReady/bootstrapRunner/registerIpc/buildMenu/before-quit 等全部生命周期照常注册——第二实例瞬态起 server child（与首实例争端口、争事件库跨进程锁）、开窗、读写 workdir.json/window-state.json，重开文件锁防线本要关闭的语义层竞态；且顶部 quit 会命中 before-quit 拦截链（preventDefault → flush → shutdown 3.5s 总超时），拉长双实例并存窗口。守住点：`second-instance` 在 else 分支不注册（行为正确）；同用户普通双开仍由 Electron 锁完整覆盖。
- 修法：一行——底部守卫改 `if (gotSingleInstanceLock && appInstanceGuard.acquired) {`（guard 异常时 fail-open 返回 acquired:true，不破坏既有放行语义）。

**P2-2｜win 字体 reg.exe 回落通道按 UTF-8 解码 GBK 输出——zh-CN 机器中文字体名整面乱码（R2 发现，主审亲验 + 本机字节级实证）**
- 证据：`src/desktop/font-cache.ts:249`——`spawnCollectKillFonts` 的 close(0) 结算 `resolve(p.parse(Buffer.concat(outParts).toString('utf8')))`（全通道共用）；`src/desktop/win-fonts.ts:186-202`——R0913-win P2-3 新增的 PS 失败回落 `spawnCollectKillFonts(reg.exe, ['query', key], { ..., parse: parseRegFontsQueryOutput })` 经同一 UTF-8 解码。
- 实证（本机只读探测脚本，非推测）：本机 OEM 码页 936（`cmd /c chcp` → 936）；`reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"` 输出 383 行含非 ASCII 字节，字体名「方正粗黑宋简体」实际字节 `B7 BD D5 FD B4 D6 BA DA CB CE BC F2 CC E5`——逐字节核对恰为 GBK 编码（方=B7BD 正=D5FD 粗=B4D6 黑=BADA 宋=CBCE 简=BCF2 体=CCE5），严格 UTF-8 解码失败、产出含 U+FFFD。PS 主通道不受影响（脚本自设 chcp 65001 + `[Console]::OutputEncoding=UTF8`）。
- 影响：zh-CN Windows（本产品目标用户的基本盘）上，一旦走 reg.exe 回落通道（其设计目标环境恰是 PS Constrained Language Mode / AppLocker / 杀软拦 PS 的受限中文机器），全部中文字体名经 `toString('utf8')` 解为 U+FFFD 串——字体下拉成串乱码替代符，不同中文名还可能因乱码形态相同被 Set 去重合并；ASCII 名（Arial 等）幸存，故不是空表而是**静默半残**。回落通道对其目标受众恰恰交付不可用结果。
- 修法：`SpawnCollectKillFonts` 增加可注入解码函数（缺省维持 UTF-8）；reg 通道改用「`new TextDecoder('utf-8',{fatal:true})` 严格试解，失败回落 `new TextDecoder('gbk')`（Node 24 自带 full-icu）」或按控制台 OEM 码页选码。PS/fontlist 通道维持 UTF-8 不动。

### P3（4 件）

**P3-1｜snapshots.ts restore 漏挂 bookMovedFailure 写前重验——家族唯一缺口（R1 发现）**
- 证据：`src/studio/server/api/snapshots.ts:504-517`——restore 处理器在 `await readJson(req)` 之后直接落盘，无书注册重验；全域 16 处同类非闸写端点均已挂单源重验（config.ts:99、prefs.ts:103、draft.ts:122、files.ts:175、documents.ts×4、style.ts×4、settings.ts:313、state.ts:188、knowledge.ts:152/161），restore 是唯一漏网者。
- 影响（沿下游核实到 executeSave 与 cross-process-lock.ts:193）：readJson 窗口跨删书/改名完成时，旧 bookRoot 上的保存锁获取经 `mkdirSync(dirname(lockPath), {recursive:true})` 在旧路径重建 `工作区/.journal` 空目录骨架（无 book.yaml，repairBooks 不认领的孤儿目录）；正文写入本身被基线校验拦下（expectedRevision 非空 + 盘上文件缺失 → REVISION_CONFLICT 409），无内容落盘。净影响 = 空目录残骸 + 一个误导性 409。
- 修法：在 :509 与 :511 之间补一行 `const moved = bookMovedFailure(ctx.workDir, params['name'], r.bookRoot); if (moved) return replyError(res, 409, moved.code, moved.reason)`（与 config.ts:99 逐字同款），并补入 r0911-srv-write-bookmoved 测试家族。

**P3-2｜chat.clear / audit.delete 五道闸检→清库之间存在 await 窗口（残余 TOCTOU，R1 发现）**
- 证据：`src/studio/server/api/stream.ts:1058-1091`（books.chat.clear）、`src/studio/server/api/audit.ts:255-304`（books.audit.delete）——五道闸（isChatRunning / allHeldTaskGatesFor / isSelfHealRunning / isSpawnRunning / isReviewRunningForBook / hasBackgroundTasks）全部同步检查后，经 `await clearChatHistory(...)`（内部再有 `await openSessionStoreAsync`）或 `await openSessionStoreAsync` 后才 `store.clearBooks` 落库，闸检与清库提交之间无二次复验。
- 影响：窗口内（毫秒级，首开库锁等待时更长）新起跑的任务（此刻自检闸全部空闲、合法起跑）会在 clear 提交后继续向已清 session 追加事件——正是这五道闸要防的「清不彻底 + 事件复活」残余形态。触发需任务起跑与作者确认清库几乎同瞬，影响有界（事件史部分复活，无损坏无丢稿）。
- 修法：对齐 books.ts L-S5 零 TOCTOU 纪律——store 打开后、clearBooks 前同步重跑同一组闸检（中间零 await），命中即关库回 409；两处共用 allHeldTaskGatesFor helper 可一并收口。

**P3-3｜apiJson 成功路径对 HTTP 200 + 字面 `null` JSON 体未设防（R4 发现）**
- 证据：`src/studio/web-next/src/api/client.ts` L233-238、L282——判别侧 `parsed !== null` 说明作者已意识到 null 陷阱（防 `typeof null === 'object'` 误判信封），但成功路径 `return body` 会把字面 null 直接以 T 冒充透出（如 `getContent` 得假成功面）。
- 影响：经 grep 服务端无 `json(null)` 形态且错误统一信封，**当前不可达**——本条为防御一致性加固，非现实缺陷。
- 修法：成功路径 `if (body === null) throw new ApiError('响应格式异常', r.status, 'MALFORMED_RESPONSE')`，或并入现有 204/304 空对象口径。

**P3-4｜MetaFormPanel 标签块三元「短篇标签」支不可达——死分支（R5 发现）**
- 证据：`src/studio/web-next/src/components/panels/MetaFormPanel.vue:293-294`——`TAG_FIELDS_BY_KIND` 只定义 `chapter` 一个键（:187-195），`kind='piece-body'` 时 `tagFields` 恒 `[]`（:196），外层 `v-if="tagFields.length"` 使整个块不渲染，行 294 三元的 `'短篇标签'` 分支永不显示。
- 影响：纯死码，无功能危害；短篇标签字段已并入 FIELD_DEFS 逐 kind 定义（迁移残留），空挂分支误导维护者以为 piece-body 存在标签块入口。
- 修法：删三元条件、固定为「章节标签」；若产品确需 piece-body 标签块，应补 `TAG_FIELDS_BY_KIND['piece-body']` 定义而非保留空挂分支。

### 各域零发现的核实口径（宁缺毋滥）

R3（AI/RAG/机检/知识域）**零确认发现**：三协议适配器流式聚合/usage 计费/终态契约/400 降级链、runTask 编排超时重试记账、RAG 生命周期（WeakMap ephemeron 环/唯一索引窄判定/embed 归位）、机检正则回溯与码点计量、知识层路径双闸均逐行核对无新缺陷；候选疑点（leak-derive 变量遮蔽、run.ts 死值等）经核验为风格 nit 或既有登记，按纪律不上报。R4 另复核排除六项疑点（doc.save 递归深度、overwriteRemote 竞态、崩溃镜像跨书碰撞、doSplitHere 光标换算同源性等，均经上下游验证非缺陷）；R5 复核排除五项（SettingsWriting 0 值合法、IME 让渡、焦点圈覆盖等）。主审亲读核心数据域（原子写/跨进程锁/清单 strict 读/journal 自愈/回收站路径安全/状态机健康检查/导出净化管线/文风码点口径）**零新发现**。

## 四、已知债务对照（台账 §三 在案项复核，非新发现）

本轮阅读中重新遭遇且与台账登记一致的开放项，复核在位、维持既定处置：

1. structure.ts `locateMergeByDisk` 反查首匹配歧义——台账【待拍板·阶段 24 批 C】在案，维持待拍板。
2. rag rebuild 闸（B 域）/ trash.delete 竞窗（E 域）备查行——在案，维持。
3. events trueCasePath 失联网络卷同步冻——前轮 P3 维持项（同步 IO 无超时手段，memo 512 + 主进程 probeDirReachable 为现实防线，注记收口在案），本轮 state.ts 亲读复核同口径。
4. CI win 腿重跑兜底与 win 腿不跑 e2e——既有登记（D5 拍板 + 上游 vitest/tinypool 评估在案），维持。本轮 vitest win 口径一次全绿未触发兜底。
5. 单实例提权差异双开——前轮 P3-13 登记 → R0913-win 已落 `app-instance-guard.ts` 文件锁防线；**本轮 P2-1 即该防线的消费缺口**（新代码引入面的窄缺陷，非系统性弱点）。
6. 总览挂账三项：deepseek-v4.1-flash（P2-1 测试面作者裁定暂缓 + 产品侧机械死码批待择收）、专项精简优化（收口条件已满足、归档时点待作者）、win 适配评审报告归档（台账 §一 首行待归档）——均维持。

## 五、完成进度结论

- **阶段账**：总览实施路线全部阶段已完成——阶段 24（章节结构操作三批：合并/拆分/撤销 + 崩溃幂等续跑）2026-09-13 收口；开放任务板为空。
- **版本**：`1.0.0-rc.1`。功能面全量收口，当前处于 RC 打磨期。
- **规模与测试**：src 961 文件 / 约 35.3 万行；test 1126 文件 / 7255 用例（win 口径 7176 过 + 84 跳，差值锚 79）；e2e 31 specs / 51 用例（49 过 + 2 跳）。
- **余量**：台账在案 3 项挂账（§四.6）+ 本轮 P2×2 / P3×4 待作者处置指令。无功能性缺口；距 1.0.0 正式的剩余工作 = 登记边角处置 + 待拍板项收口。
- **结论：项目完成进度 = 功能全量收口，RC 打磨期（1.0.0-rc.1），按「计划内工作」口径已 100% 收口，剩余为打磨级债务。**

## 六、完成质量结论

- **量化门面**：九件套质量门 win 本机一次全绿（vitest 1126 文件 0 败 / tsc 0 / vue-tsc 0 / eslint 0/0 / 三 check 过 / e2e 49+2 / soak 两段 OK）；本轮全库独立重评 **P1×0**，P2×2 均出自最新 R0913-win 修复批代码、各一行至数行可闭合，P3×4 均为边角/防御加固/死码清理级。
- **结构性观察**（五域子代理 + 主审亲读交叉一致）：
  1. 防御纵深成体系且全库口径一致：入口三层防线（Host 白名单 fail-closed + Origin/令牌 + 日志脱敏单源）、书生命周期排水链（busyGate → 五路 drain → 全同步复查-改名零 TOCTOU → 墓地 → 20+ 项缓存遗忘）、任务闸矩阵（进程内 Set + O_EXCL + pid 活性 + 续期）、前端七类代数守卫 + 在途请求去重 + 三层关窗冲排。
  2. 「历史修复密度」为同类项目罕见：源码内嵌 100+ 轮 R 编号评审注记锚定几乎每个边角（空 usage、mid-chain 400、UTF-16 截断、win 大小写折叠、BOM/CRLF、TOCTOU、回滚之回滚），且防御哲学一致——fail-closed 于门禁、fail-open 于缓存、fail-noisy 于降级。
  3. 数据完整性主干（manifest strict 读防丢闸 / journal pending-settled 崩溃恢复 / 原子写 tmp+fsync+rename / 跨进程锁陈锁接管 / 回收站投影带回 / 回路镜像不可静默销毁）在主审逐文件亲读中零新发现——这是本产品的红线面，当前状态可信。
  4. 中文文本正确性（码点计量贯穿机检/文风/导出截断）与 win 适配成熟度均处高位；本轮 P2×2 属新代码窄缺陷而非系统性弱点。
- **结论：项目完成质量 = 高**（RC 期成熟度；正确性优先的工程纪律已收敛到「维护面债务为主、正确性面零 P1」的状态）。

## 七、处置建议（已处置）

- P2×2 建议修复：P2-1 一行消费缺口闭合；P2-2 可注入解码 + reg 通道 GBK 回落（附测试：win-fonts 假件按码页分流）。
- P3×4 择收：P3-1（一行 + 测试家族补齐）与 P3-2（闸检二次复验）建议收；P3-3（防御加固一行）与 P3-4（死码清理）随手可收。
- 修复批与回归测试、L2 终门重跑随处置指令另行实施；本报告落盘即评审完成，**未收口**。

## 八、处置记（2026-09-13，作者指令「完成之后，全部修复。」→ 全量处置批）

**P2×2 + P3×4 六件全修（无维持/驳回项）**，主审亲修零代理：

- **P2-1（main.ts 守卫消费文件锁标志）**：底部生命周期门 `if (gotSingleInstanceLock)` → `if (gotSingleInstanceLock && appInstanceGuard.acquired)`——跨提权双开时第二实例 Electron 锁为真而文件锁为假，原守卫放行使生命周期全注册（瞬态起 server child/开窗/写 workdir.json），语义层竞态重开。guard fail-open（acquired:true）语义不变。测试面：新增 `test/desktop/r0913-r2-main-guard-static.test.ts` 静态源码断言 ×2（守卫条件 + 门内 whenReady 语义不空转）——不走 Electron 假件（R0913-win P3-13 批 will-quit/OOM 前科，静态断言与 app-instance-guard 行为测分层互补）。
- **P2-2（reg 通道 GBK 码页解码）**：`font-cache.ts` SpawnCollectKillParams 增可选 `decodeStdout?: (buf: Buffer) => string`（缺省 UTF-8 行为零变化，PS/fontlist 通道不注入）；`win-fonts.ts` 新增导出 `decodeRegOutput`（严格 UTF-8 试解 → GBK 回落 → 宽松 UTF-8 兜底）接 reg.exe 回落通道——zh-CN 机器 reg 输出按 OEM 码页（936）落字节，原固定 toString('utf8') 把中文字体名整面解成 U+FFFD（本机字节级实证）。测试面：win-fonts.test.ts 新 describe ×3（GBK 字节硬编码纯解码 ×2 + reg 回落 GBK 整链 → 列表得「微软雅黑」不落 U+FFFD）。
- **P3-1（snapshots restore 书注册重验）**：`snapshots.ts` restore 在 readJson 窗口后、save 前补 `bookMovedFailure` 重验（config.ts:99 家族 / R0911-B-P3-4 同型）——16 处同类非闸写端点中唯一漏挂者闭合，窗口跨删书/改名时 409 拒写保旧。测试面：新增 `test/studio/r0913-r2-snapshots-bookmoved.test.ts` ×2（对照组不搬书 200 语义不变 + 真服务悬持 body〔content-length 预设 + flushHeaders 先发头〕窗口内改名 → 409 BOOK_MOVED、旧路径无幽灵目录、新路径内容保旧）。
- **P3-2（chat.clear / audit.delete 六闸 await 后复查）**：单源收编 + 复查两举——`audit.ts` 新增导出 `chatClearGateReason(bookName, action)`（六闸序 = dd-P3 对话 → hh-P1+R29-9 任务闸〔含跨进程〕→ self-heal → 三审 → 后台收尾 → spawn，null 放行），audit DELETE 与 stream chat.clear 两端入口内联块收编该单源（消息模板「……后再${action}」，个别文案微调如「稍等片刻再/后再」，测试只锚状态码不锚文案，无破坏）；复查面 = audit DELETE 在 openSessionStoreAsync 后、clearBooks 前复查（store.close 走 finally 照常收口），chat.clear 经 `clearChatHistory` 新增 `opts.gate` 回调在开库让出后、清库前复查（返回拒清理由由 stream 转 409；内存清空先行是良性前置——在途任务持数组引用续写、重开面板从事件库〔未清〕重放，两侧自愈对齐；books.ts 删书/改名两个既有调用方 await 后弃值不受影响）。stream.ts 顺带摘除收编后死导入 hasBackgroundTasks。测试面：新增 `test/ai/r0913-r2-clear-gate.test.ts` ×3（gate 触发→理由返回+双键原样 / 放行→清库返 null / 无 opts 回归不变）+ chat-clear-gates.test.ts 扩 ×2（audit DELETE 入口 task-gate 真占位 409 + 全空闲 200——入口收编后两端口径锁；复查闸机制面由 r0913-r2-clear-gate 单测钉）。**如实记档：audit DELETE 复查位（3 行薄胶水）未单设竞态复现测试——开库 await 窗口无注入点可控，tsc + 入径集成测 + 同源 helper 单测覆盖。**
- **P3-3（apiJson 2xx 字面量 null 体防御）**：`client.ts` 在 return body 前补 `body === null` 上抛 `MALFORMED_RESPONSE`（R51-H-1 坏体同族；r.json() 对「null」体解析成功不进 catch，null 穿透使调用方按 T 消费得 undefined 字段）。204/304 无体合法形态维持空对象口径。测试面：api-client.test.ts 新 describe ×2（200+「null」→ ApiError MALFORMED_RESPONSE / 204 null body → {}）。
- **P3-4（MetaFormPanel 死三元清理）**：模板 `{{ kind === 'piece-body' ? '短篇标签' : '章节标签' }}` → 定值「章节标签」——TAG_FIELDS_BY_KIND 只含 chapter 键，短篇 tagFields 恒空、该块对短篇本就不渲染（目标情绪/核心反转已移 FIELD_DEFS 可编辑区）；:292 注释同步改口。无新测试（模板面，vue-tsc + 既有 suite 覆盖）。

**测试账**：新增 3 文件 7 用例（r0913-r2-main-guard-static 2 / r0913-r2-snapshots-bookmoved 2 / r0913-r2-clear-gate 3）+ 既有 3 文件扩 7 用例（win-fonts +3 / chat-clear-gates +2 / api-client +2）= 净增 +3 文件 / +14 用例（全平台无门，win 差值锚 79 不变）；1126→1129 文件、7255→7269（win 7176→7190 过 + 84 跳）。

**门（L2 终门九件套，处置后全量重跑，win 本机一次全绿）**：vitest 全量 **1129 文件 = 7190 过 + 84 跳 0 败**（win 口径，398.78s，本轮无假红）+ tsc 0 + vue-tsc 0 + eslint 0/0 + check:counts 过（README 修账 1126→1129 / 7255→7269 后复跑一致）+ check:packaging 过 + check:knowledge 过 + e2e **49 过 2 跳**（1.1m，51 用例）+ soak 两段 OK（8.32→8.29MB / 8.82→8.88MB，上界 24MB）。

**收口链**：本报告 §八处置记（本节）+ 台账 §一行改「处置完毕待归档」+ 总览 §1.3 行同步 + 根 README 修账（徽章/npm test/门槛行/技术栈行/win 预期链/增量链）+ Dev/Docs/README.md 状态更新。待作者「提交改动」指令。

# 全项目源码复审-评审-GLM-5.3-Flash-2026-09-30

- 执行模型：GLM-5.3-Flash（ZCode 主控横切核查 + 7 域并行子评审深读）
- 评审对象：`src/` 全部（约 13.0 万行 TS/Vue/CSS，排除 node_modules）+ `test/` 与工具链抽样（约 21.5 万行）
- 评审方式：独立重读源码，未参考 Dev/Docs 既有评审与设计文档结论（作者指令「忽略现有文档」）；只产报告，不修复
- 结论速览：**全 7 域 0 项 P1**；完成进度加权约 **95%**（rc.3 形态相符，剩余项全部显式挂账、无隐蔽欠账）；简洁优雅**良好偏优**，最大系统性问题是一轮批次标记剥除在全库留下的**注释残伤**，其次为少量已立案的结构债与同构拷贝

---

## 一、评审覆盖与方法

| 域 | 规模 | 方式 |
|---|---|---|
| src/ai（LLM 链路） | 16.0k 行 | 核心逐行（runner/gen/provider 全量）+ 全域浏览 |
| src/studio 服务端（不含前端子包） | 15.6k 行 | server 根文件通读 + api/ 57 文件浏览、11 文件深读 |
| src/studio/web-next（Vue 前端） | 45.5k 行 | 入口/17 store/最大 15 文件深读 + 全目录覆盖 |
| src/document + src/process | 14.5k 行 | service 族/structure 族/管线核心深读 + 其余浏览 |
| src/desktop + events/state/install/fs/git/update/log | 17.0k 行 | 壳层核心深读 + 事件库迁移段逐行 |
| src/check + format + metrics + rag/review/learn/knowledge/cache/driver/export/shared | 21.0k 行 | 解析器/机检/RAG 核心深读 + 其余浏览 |
| test/ + scripts/ + CI + 根配置 | 21.5 万行 | 全树统计扫描 + 14 档抽读 + 6 门核读 |

主控另做横切核查：类型逃逸全量定位、console.log 全量定位、TODO/FIXME 全量扫描、超大文件排序、文档治理面核对。

## 二、三问三答（总评）

**1. 完成质量如何？** 高，显著高于平均水平。全 7 域未发现一项 P1 级缺陷（正确性致命且未被注释认账）。并发/竞态纪律（锁序单源、乐观锁、gate 矩阵、事件循环让出）、崩溃一致性（journal/move-pending/迁移墓碑三类崩溃窗逐个闭合）、安全面（IPC 纵深防御、回环+Host+Origin+token 四闸、凭据 fail-closed）都是成体系的设计而非散点补丁。最近的缺陷风险集中在两处窄窗（§五 P2-1、P2-4），均为低概率高危度组合。

**2. 完成进度如何？** 约 95%，与 1.0.0-rc.3 的自我定位相符。硬证据：`src/` 全库 TODO/FIXME/stub 零命中（唯一命中 `src/knowledge/update.ts:138` 是面向作者的误报模板占位文案，属设计内）；前端无未接线按钮、无 mock 数据残留；服务端所有注册端点完整实现；7 域完成度估计 93–97%（§四分域表）。剩余 5% 全部是**显式挂账**（代码注释自记推迟项）而非隐蔽缺口，详见 §六。

**3. 代码是否简洁优雅？** 良好偏优，有三类扣分：
- **注释体系残伤（最系统性）**：一轮批次标记剥除（check:comments 门的副作用形态）在至少 6 个域留下断句、截断、悬空引用与**方向性失实**注释，其中 `src/document/service.ts:337` 宣称「结构性操作不持 save 锁，残余窗口存在」与现行实现相反（现均持锁，窗口已闭合）——失实备案比没有备案危险；
- **少量结构债**：`src/events/store.ts` firstOpenStore 巨型残核（1289 行文件，拆分立案件在三个文件头注自记「本批零触碰」至今未执行）、`src/ai/orchestrate/chat/turns-phases.ts` 约 350 行单函数（与本域自己确立的拆分纪律相悖）；
- **同构拷贝尾巴**：收敛文化很强（17+ 缓存收编 ttl-cache、五处取锁编排收编 withSaveLocks、三份乐观锁守卫收编 revision-guard），但每轮收敛后都有漏网点（§五 P2-8/9/10、§六 P3 逐条）。

## 三、全域横切硬指标

| 指标 | 结果 | 评价 |
|---|---|---|
| `: any` / `@ts-ignore` / `@ts-expect-error` | 0 / 0 / 0 | 严格类型纪律成立 |
| `as unknown as` | 14 处 | 全部位于事件反序列化/旧格式迁移/SQL 行边界，逐处合理 |
| `console.log`（生产） | 7 处 | 全部为冒烟标记（CLW_SMOKE）与日志兜底，合理 |
| TODO/FIXME/XXX/HACK | 1 处 | `src/knowledge/update.ts:138` 模板占位文案，设计内 |
| 超过 800 行的文件 | 后端 8 个 / 前端 1 个（792 行） | 前端组件拆分充分；后端超大文件均有立案或论证 |
| 跨域依赖方向 | 单向无环 | 有 governance 测试机械守护（`test/governance/dependency-direction.test.ts`） |

## 四、分域完成度

| 域 | 完成度 | 一句话判定 |
|---|---|---|
| src/ai | 95% | 中断归因/计费五出口/流尾收口等深水区语义正确；余债为 1 个超长函数 + 3 份用量累计拷贝 |
| src/studio 服务端 | 97% | 错误优先级、删书五连 drain、SSE 背压双判死均成体系；余债为收尾一致性 |
| web-next 前端 | 95% | 保存安全网（乐观锁+幂等+崩溃镜像+三段切书决断）是全库最强面；余债为样板收敛 |
| src/document | 97% | 「磁盘真实文件为准」的崩溃可恢复协议贯穿三条写链；余债为注释失实与容错读 |
| src/process | 95% | 依赖单向、装配预算裁剪完整；余债为缺省值残余通道 |
| 壳层（desktop/events/state/install 等） | 93% | server 状态机与迁移崩溃一致性出众；余债为 store.ts 残核 + 退出链窄窗 |
| 文本域（check/format/metrics/rag 等） | 95% | 指纹缓存/失败打捞/prepared 单源破解 sqlite 暂存环；余债为纪律回退两处 |
| 测试面 | 95% | 1290 档全进 CI，断言几乎零实现锚，门禁自带反向守护 |
| 工具链/CI | 90% | 三 OS 矩阵 + 打包态三重冒烟 + 发布草稿链闭环；余债为收敛机制（§五 P2-14/15） |

## 五、问题清单（P2，应优化；共 15 条，按风险×收益排序）

1. **`src/process/draft-pipeline.ts:199,206,234` — saveDraft 守卫族用容错读，与全仓 strict 读纪律脱节（最高风险项）**。回收站双认领守卫与锁内复核用容错版 `readTrashManifest`/`readManifest`：瞬态读失败（win EBUSY/EACCES）静默返空表时守卫按「无登记」放行，可致清单出现 doc_ 与 legacy 双条目认领同路径（该路径后续恒 fail-closed）。同型问题在 executeSave、applyChapterMerge、trash/purge 均已修 strict，唯 AI 写章通道漏网。方向：三处换 strict 读。
2. **`src/events/store.ts`（1289 行）— firstOpenStore 巨型残核**。三处拆分文件头注均自认「重设计立案件，本批零触碰」，是全库最大已知架构债。方向：按既定立案件拆首开壳与迁移段。
3. **`src/ai/orchestrate/chat/turns-phases.ts:150-501` — initiateAgentTurn 约 350 行单函数**，阶段状态散布闭包变量，与本域 `responses-stream.ts` 曾因 232 行被拆的纪律自相矛盾。方向：仿 `turns-tools.ts` 已有拆法按 prepare/stream/tool-loop/finalize 拆段。
4. **`src/ai/provider/store.ts:705-719` — 保存路径先提交内存 revision 后 atomicWriteFile**，写盘失败时内存领先盘上，下次 save 携领先 revision 做冲突判断（窄窗假 409/漏冲突）。方向：写成功后再提交或失败回滚。
5. **全域 — 批量注释残伤（系统性，本表合并计一条）**：断句/截断/悬空引用/方向性失实至少 6 域 20+ 处。重灾例：`src/document/service.ts:1072`（乱码句）、`:337`（方向性失实，见 §二）、`src/document/service-meta.ts:266`（悬空行号）、`src/format/yaml-patch.ts:22-27`（两段文字交错）、`src/format/yaml.ts:11`（行数登记过期近 3 倍）、`src/check/run-single-doc.ts:8` 等 3 处「（全项目源码质量与优雅度评审）：」引用目标为空、`src/desktop/main.ts:355` 等 3 处「10 分钟宽限」与实值 32 分钟漂移、`src/studio/web-next/src/stores/prefs.ts:753`（截断）与 `stores/ui.ts:128`（复制串行）、`src/ai/runner.ts:621`（乱码句）、`src/studio/server/api/stream.ts:123,739`（拼接烂句）。方向：一次性注释清账批 + 更正 service.ts:337 的方向性错误。
6. **`src/format/read.ts:15-16,33-34,74-76`（+ `src/check/tree-issues-cache.ts:229,285,395`）— prepared() 单源纪律回退，热路径裸 prepare**。聚合链路逐账本逐条重新编译 SQL，在 200 万字/数百账本规模下有无谓开销，且是纪律漂移开口。方向：改走 `src/shared/sqlite-prepared.ts`。
7. **`src/metrics/short-index.ts:186` 与 `src/check/runner.ts:289-323` — 「细纲文件定位」同一语义两套实现且已分叉**（basename 单级 vs 三级匹配），机检红点与短篇指标对同一书形可一方命中一方 miss。方向：抽单源。
8. **前端 — 竞态守卫样板未收口**：`bookName !== book` 形态守卫全库 75 处（如 `WorkbenchView.vue:190` 起 15 处），`useChapterTreeActions.ts:87-97` 已示范 `stillIn/failScoped` 收口但 views 层未接入；另有 8 处同构 `xxxPending = ref(false)` 布尔锁。方向：提 `useScopedAction`/`usePendingAction` composable，行为不变仅收敛写法。
9. **`src/studio/server/api/chat-history.ts:157-168` 与 `chat-branches.ts:55-66` — openSessionStoreAsync 样板 12 行两份逐字拷贝**（含相同勘误注释）。方向：抽 `withBookStore` 收敛。
10. **`src/studio/server/api/search.ts:64-74` 与 `foreshadows.ts:83-93` — dirSignature 同构函数两份拷贝**（ttl-cache 大收敛后的漏网对）。方向：单参化共用。
11. **前端 — `.btn` 族基础样式在 15 个组件 scoped 内近重复**（CreateBookModal/ExportDialog/LearnView 等，主体仅 padding/radius 微漂移）。方向：`ui-shared.css` 放基类 + 组件留差异声明（settings-shared.css 已是该模式先例）。
12. **`src/desktop/lifecycle.ts:419-421,343-355` — before-quit 的 session-end 级联 quit 直通分支不置 `appTearingDown`**，5s 观察窗自愈定时器在该窄窗内可能复位 `sessionEnding` 并 fork 新 child 造孤儿（现靠 `:349` 主窗已空守卫兜底）。方向：直通分支补置旗标。
13. **`test/` — e2e 顺序耦合**：`playwright.config.ts:29-38` 单一 workDir + workers:1 + retries:0，33 个 spec 首尾相接，任一 flake 连坐整段。方向：只读型 spec 逐步迁独立 workDir，缩小连坐半径。
14. **eslint suppressions 只冻结不收敛**：531 条/178 文件（`eslint.config.js:26-27` 自认松弛点），CI 无 prune/漂移核对步。方向：CI 增 prune 后 diff 为空断言，或周期批跑记收敛数字。
15. **`test/studio` 平铺 226 档 + 212 档逐文件 `@vitest-environment happy-dom` 头注**：前者与「并入优先」纪律在该域最难执行，后者漏写即假红。方向：按子域分目录；vitest 5 projects 按目录统一 environment。

## 六、问题清单（P3，风格瑕疵；按域归并）

- **ai**：mock 路径 `stopReason:'mock'` 超出封闭联合（`runner.ts:686,710`，事件层以 string 接住故无运行时错）；CHAT_TOOL_NAMES 双份需人工同步（`turns-phases.ts:79` / `finish.ts:29`）；死导出 2 处（`prompts/resource.ts:213-222`、`calls.ts:281`）；`provider/store.ts` 多轮历史批注层积。
- **document/process**：`service-meta.ts:598` updateDocMetaLocked 整书结构性失效连坐（同文件 `:265-273` 刚论证删掉同参调用，两路径口径分裂）；`process/style-harvest.ts:97-141` 同步版生产零调用未标 `@visibleForTesting`；`process/settings-injection.ts:35-42` 第三份码点计数实现（引 `shared/text.ts` 的拒绝理由不成立，其为零依赖叶子）；`process/prepare.ts:165` `sampleScene` 缺省硬编码『战斗』（生产链恒显式传，仅残余通道）；`service.ts:183-205` maybeSnapshot 双重 `existsSync`；`service.ts:1010`「零生产调用方」注失实（`install/migrate-layout-v3.ts:211` 在消费）。
- **studio 服务端**：`ai-status.ts:38-41` 外层 e2e 死分支（`probeAi` 首行同判定）；`documents-save.ts:58` 非法 origin 静默归一 'manual'，与同函数其他字段 fail-loud 口径不一致；`stream.ts:591` `isRunning` 可选链与 `:608` 必需化口径分裂；`workdir-controller.ts:540` isLibraryDir 死导出。
- **desktop/events**：`main.ts:639-641` 注释整行重复两次；`store-migrate.ts:138-144` 锁对获取未下沉自守新旧 hash 相同（生产调用方已挡）；`ipc.ts:171-216` open-library/switch-library 无在途互斥（UI 模态使触发面窄）；`lifecycle.ts:435-463` quit 链只 flush 主窗，书架/书库子窗 500ms 防抖窗内 prefs 可丢（低敏）；`windows.ts:62-78` 两份同构提示页 HTML 可收模板函数。
- **check/format/metrics**：`run-tree-issues.ts:527,543` 变量 `st` 同函数双义；`metrics/style.ts:27-29` 重复 import；`metrics/style.ts:186-213` scanChapters 同步/异步循环体逐字双份未走生成器核（与 check 域模式不一致）；`learn/index.ts:30` 经 metrics 转手引 readIronRules，绕开单源 format/iron-rules。
- **前端**：`OverviewView.vue:114-117,126-129` catch 先 console.warn 后查 stale，顺序与 `:99` 不一致（切书后误导日志）；`EditorDocHead.vue:191` 非空断言与 doc store「书名 fail-closed、不用 `!`」自家纪律相悖；`ContextMenu.vue:47` 浏览器回退菜单子菜单键盘不可达（已挂账，缺追踪锚）；`useRelationGraph.ts:136,309,318` 以冻结参数复检替代全库 staleGuard 惯例，正确性依赖 `:key=bookName` 整树重建兜底，前提未注记；`prefs.ts:81-530` 加一个偏好键需同步四面（建议头注明示清单）。
- **测试/工具链**：win 腿「同命令重跑一次」可洗掉间歇真失败首报（已自评接受，建议挂 tracking 项）；`check-counts.mjs:112-116` 自登记不识别正则字面量；`CLAUDE.md:36`「1286 档/385 秒」与当前 1290 档已漂移（check:counts 不覆盖 CLAUDE.md）；Electron 打包冒烟三处实现并存（desktop.yml bash/pwsh 内联 + electron-smoke.mjs），可下沉单源；残余固定实睡约百处（已单源 sleep，可沿 armed 握手先例继续收敛，非急务）。

## 七、未完成信号清单（全部显式挂账，非隐蔽欠账）

1. `src/ai/provider/model-quirks.ts` — 能力缺口 13 verbosity「留位不发」、缺口 10 stop_sequences 静默忽略（能力表登记在案）。
2. `src/desktop/os-kek.ts:84` — Keychain/DPAPI 通道整面搁置（`OS_KEK_SHELVED = true`，发行包未签名所致，恢复开关已留）。
3. `src/studio/server/api/prefs.ts:25` — 书级 prefs 乐观锁服务端就绪、前端 expectedRevision 待接线。
4. `src/rag/index.ts:318-338` — recall() 已定性 test-only，34 处测试调用点待迁移 recallDetailed。
5. `src/format/piece-list-core.ts:16-17` — 文本级保形补丁路径生产零接线（章纲写侧无保形通道，头注自记）。
6. 前端已知缺口：ContextMenu 键盘导航未接线、三审进度 SSE 无排期、目录拖拽移动仅 toast（`useChapterTreeActions.ts:432`）、AI 对话面标 Beta。
7. CI/发行：linux 出包腿暂缓；代码签名未做（mac ad-hoc、win unsigned，属发行决策）；字体枚举打包态复验、win 实机闪窗复验等真机台账在案。
8. 三个「待拍板/待解除」挂账：裸数字章号扩集（`process/summary.ts:541`）、STRUCT 注入钩子解除条件（`document/service-guards.ts:67-69`）、角色卡范文回落待知识层补数据（`process/materials.ts:181`）。

## 八、亮点（全域抽样，值得保持的做法）

1. **收敛文化**：同构拷贝一旦第三处出现即收单源且理由记档——`src/async.ts`（五处让出原语收编）、`src/worker-async.ts`（三份 Worker 壳收编，域差异全参数化）、`server/ttl-cache.ts`（17+ 缓存收编）、`DocContext.withSaveLocks`（五处取锁编排收编）、`revision-guard.ts`（三份乐观锁守卫收编）。
2. **错误优先级当契约守护**：`defineRoute` 钉死「404/409 先于 body 400」；`api/prefs.ts:99-100` 主动**放弃**一次会翻转判序的重构并记档——把判序当资产而非偶然。
3. **崩溃一致性全覆盖**：journal 双 stat 复核、move-pending healthCheck 确定性收口、结构操作按崩溃不变量分流幂等续跑、事件库迁移墓碑 fail-closed（`src/events/store.ts:1243-1282`）。
4. **降级哲学如实显影**：留底/定稿闸 fail-open 但 `snapshotDegraded`/`gateDegraded` 旗随结果上抛——「降级可接受但降级必须可见」执行一致。
5. **测试面纪律长在代码里**：断言几乎零实现锚、fixture 单源复用率极高（temp-dir 479 档引用）、门禁带反向守护（coverage 桶双向锁、`.only` AST 封死、related 防静默空跑）、发布链专杀假绿（.app 拷出工作区冒烟、asar 清单断言、SHA256 随产物）。

## 九、优化建议优先级（本轮不实施，供排期参考）

1. **立即批（低风险高收益）**：注释清账批（P2-5，含 `service.ts:337` 方向性更正与 main.ts 宽限漂移）——纯注释零行为风险，且失实备案正在误导维护。
2. **下一功能批顺带**：P2-1 saveDraft 换 strict 读（与既有同型修复同批）；P2-4 revision 提交时序；P2-6 prepared() 回退三处；P2-7 细纲定位单源。
3. **独立立项**：P2-2 store.ts 残核拆分（按既有立案件）；P2-3 initiateAgentTurn 拆段；P2-13 e2e 顺序解耦。
4. **机制性**：P2-14 suppressions CI 收敛步；P2-15 vitest projects 收 environment；P2-8/9/10/11 样板与拷贝收敛（可随触达文件顺手做）。
5. **挂账管理**：§七各显式挂账维持现状即可；建议给「裸数字章号扩集」等无截止条件项补截止判据。

## 十、与上一轮（09-27 重审）的关系说明

本轮为作者明示的独立复审：评审过程未读取 09-27 报告正文，结论独立形成；两轮如有重合发现，属同一问题在当前代码上的仍存状态，修复责任以本轮清单为准。按治理纪律，本报告完成≠收口——P1/P2 修复 + 回归通过后才收口归档。

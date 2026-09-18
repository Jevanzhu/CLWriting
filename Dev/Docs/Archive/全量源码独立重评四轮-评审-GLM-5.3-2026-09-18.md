# 全量源码独立重评四轮

- 性质：全库源码独立评审报告（不承继既有文档结论；正本入 `01-评审/`，**报告完成 ≠ 收口**）。
- 执行模型：GLM-5.3（主审）；分域深读由 7 个只读子代理两波并行执行（单波 ≤4，子代理与主审同模型系）。
- 基线：`7fd37bd2`（win 线，含 2026-09-18 当日三轮独立重评修复批 `4a3d5333`/`1759b97a`/`a9bc13d6` + 三拍板批 `dabf0dff` + win 实跑收口批全部改动；工作树净）。行号证据均按该基线实测。
- 评审方式：作者指令「忽略掉现有文档，重新评审下当前项目源代码，结果形成一个文档。」——评审全程不读 Dev/Docs 既有文档与前三轮报告，结论只基于源码/测试/配置本身独立产生；回收后主审对关键结论逐条对源码复核（五处抽核全部坐实），并与当日三批修复面（git 实态）对账裁定增量——**已修项零复发，本轮发现全部为新增量或在案取舍登记**。
- 规模实测：src 548 文件 / 约 12.2 万行（根域 21 目录约 6.3 万行 + studio〔server 61 件 + web-next 207 件〕约 5.8 万行，不含前端子包 node_modules）；test 1314 文件 / 约 19.3 万行（vitest 1251 件 = 7635 用例 win 实测 + e2e 33 spec = 54 用例）。

## 一、结论速览

- **P1：0 条**。七域深读未发现正确性缺陷/数据丢失路径/安全破口/未防护竞态。
- **增量 P2：17 条**（运行时 8 + 测试面 4 + 构建/CI 5），全部附 file:line 证据。
- **增量 P3：30 条**（含 9 条「在案取舍登记」——代码注释或既有拍板已声明、本轮复核确认现状、不催改）。
- **前三轮修复质量**：一轮 P1×1/P2×11、二轮 P2×3、三拍板批三件、三轮 P2×2 的全部修复面在本轮不知情重读中零复发（chat_replay_begin 回放锚 / isWriterRunning 口径 / 拆分跨进程锁 / 备料链异步化 / providers revision 复验 / KEK v2 OS 通道 / 章号双轨闸 / books-repair 同名判重等锚点均实证在位）。
- **发现面画像**：三轮连续收敛后，本轮发现进一步向边缘与外围迁移——主干四域（AI 编排/服务端/文档模型/桌面）合计仅 5 条可行动 P2 且集中在性能热区与一个覆写边界；外围（测试维护面、CI 工程面）占 9 条 P2；安全横切面（密钥/注入/路径/网络/IPC）**零新发现**。该画像与「主干防御密度未退化、残留风险向外围收敛」的演化趋势一致。
- 处置建议见 §六；修复未开工。

## 二、系统概览（源码实态）

产品形态：Electron 桌面应用（中文 AI 长篇写作系统），三进程结构——Electron 主进程（`src/desktop`，窗口/IPC/字体/生命周期）+ utilityProcess 子进程跑 studio server（`src/studio/server`，原生 `node:http`、105 路由动作 + SSE 流）+ Chromium 渲染层（`src/studio/web-next`，Vue 3.5 + Pinia 3 + vue-router + CodeMirror 6，vite 8/rolldown 构建）。另有独立 node 入口 `server-main.ts` 供发布 e2e 冒烟。

核心数据链：渲染层经 `/api/*`（token + 一次性 SSE 票据）驱动服务端 → `src/ai` 编排（chat 闭环 / self-heal 批量写章 / 评审）经 `runSpec → runTask` 调 provider 适配器（Anthropic / OpenAI Chat / OpenAI Responses 三协议，SDK 直连无 CLI 子进程）→ 事件经 `src/driver/cc.ts` 双桶 execRing 广播（chat 腿/写手腿分环，迟到消费者回放）。持久化四面：每书 SQLite 事件库（`src/events`，追加写 + 影子化压缩 + 分支树投影）、文件本体（`src/document` 结构/保存/定稿/版本/回收站协议）、ai-calls.json 记账（预算闸）、providers.json 凭据信封加密（AES-256-GCM + OS 通道 KEK v2）。支撑域：`src/format`（文件格式基础层）、`src/check`（零 token 机检）、`src/rag`（每书向量召回）、`src/process`（备料/摘要/文风收割）、`src/metrics`/`src/learn`/`src/knowledge`（文风与知识资产）、`知识层/`（入库内容资产 + sha256 对账门）。

工程面：tsup 全 bundle（node_modules 整树排除出包）+ electron-builder（asar、mac ad-hoc/win unsigned + SHA256SUMS）；CI 五矩阵腿（ci.yml）+ tag 发布门（desktop.yml 复刻全部门禁）+ dependabot 双包；测试:源码 ≈ 2.1:1，coverage 主桶 + 20 域级子桶阈值棘轮，另有 governance（架构守护）/corpus（golden-master 语料）/soak（五段内存有界门）三元测试层。

## 三、分域评审摘要

### 3.1 AI 编排域（src/ai + src/driver + src/review）

**职责链**：编排层（orchestrate/chat 20 轮上限闭环 + self-heal 批量写章 + review 契约）→ tasks/spec（prompt 资源化 + overlay）→ runner（逐 attempt 记账 + 重试环）→ provider 三协议适配（终态契约/截断转可重试/400 降级链）→ cc.ts 双桶 execRing 广播。**亮点**：两桶分环 + 三通道重连恢复体系（本轮逐点核实归腿/全停/拼接序全部正确）；逐 attempt 记账预算闭环（跨进程锁原子写 0600）；凭据信封加密（HKDF→KEK→DEK→GCM、AAD 绑定 providerId、v2 OS 通道）；「模型可见 ⟺ 已记录」血统纪律经核实基本兑现（promptFiles/promptTools/血统事件/CLW_VERIFY_VISIBLE 抽验链完整）。

**问题**：P2×1（A401 记账同步 IO）；P3×3（A402-A404，其中 A402/A403 系一轮 E002 与 R72-11 拍板口径的残余面，登记）。

### 3.2 服务端与事件域（src/studio/server + src/events + src/state + src/cache）

**职责链**：Host/Origin/token 三凭证请求管线 → 105 路由（书架/文件/文档 CRUD/定稿快照/写稿 SSE/对话/分析审校/文风/RAG/导出/配置）→ 每书 SQLite 事件库（单事务追加 + 影子化 + 投影/分支树）+ 状态机体检引擎 + TTL 缓存层。**亮点**：错误信封单出口 + 全 handler 兜底脱敏；书库改名迁移协议数据不丢闭环（锁对防 ABBA + tombstone + 失败可重试）；SSE 全生命周期治理（票据/背压双死刑门/watchdog/关停序）；serial-chain/ttl-cache/task-gate 三件并发治理基建单源收编。**安全结论**：环回独占绑定 + 路径规范化 + canonical 双重边界 + 静态回退校验，未发现可成立的攻击面。

**问题**：P2×4（B401-B404，全部为性能热区/罕见边界，无正确性缺陷）；P3×3（B405-B407）。

### 3.3 桌面与进程域（src/desktop + src/process + src/install + src/git + src/fs）

**职责链**：Electron 主进程启动链（单实例双保险 → CSP → IPC 16 通道 → bootstrap → server utilityProcess 握手/崩溃重启/kill 升级 → 安全窗口）+ 保存协议（per-doc 跨进程锁 + journal 三态 + 覆盖前快照）+ 书库注册表/迁移族 + 原子写/跨进程锁/safe-path 原语。**亮点**：Electron 安全配置示范级（安全旗后置防覆盖、will-navigate/setWindowOpenHandler 双 deny、IPC isTrustedSender 单点、shell 面 NUL/越界全检、spawn 全数组参数）；子进程 kill 升级链 SIGKILL 前重读 pid；关停三形态闭合且预算层级对齐（≈3s < 3.5s < +2s）；server-main 信号兜底重构（runServerMain/installSignalFallback/VITEST 探针）本轮核实语义正确。

**问题**：P2×1（C401 workdir 覆写边界——与 books.jsonl 的 DA-3「读失败拒绝重写」纪律不对称，修复成本低）；P3×6（C402-C407）。

### 3.4 文档模型与支撑域（src/document + src/format + src/export + src/rag + knowledge/learn/metrics/log/check/shared）

**职责链**：format 基础层（fm 解析/字数码点单源/yaml 段树/引号体系）← document 编排（service 保存队列 + structure 合并/拆分 planHash 防护 + manifest/trash/version/finalize/journal/foreshadow）← export/check/metrics/learn 消费。**亮点**：结构操作崩溃一致性工业级（planHash 双侧指纹 + 崩溃幂等续跑三态 + undo 半程态三重验证）；Unicode/增补平面纪律全库一致；非 UTF-8 字节安全闭环（拒写 + 版本字节保真对称）；锁体系有全局秩序（save→布线→清单，NFC+casefold 键折叠）。

**问题**：P1/P2 均 0；P3×5（D401-D405，全部展示/口径级）。

### 3.5 前端域（src/studio/web-next）

**职责链**：Book 页宿主（useSse + 心跳 + 切书三段守卫 + autosave/flush 防丢）→ 15 Pinia store（workbench 流式聚合/chat 状态机/doc LRU+乐观锁/tree 派生）→ 24 composable → 视图族（编辑器/工作台/文风/审计等）。**亮点**：XSS 面为零（全库无 v-html/innerHTML）；保存防丢四层兜底（autosave/⌘S 排队/关窗 flush/localStorage 脏镜像）；SSE 客户端防御纵深（换票重连/连接代守卫/半开看门狗/resync）；IME 组合态全链路尊重。

**问题**：P2×2（E401 流式渲染未防抖、E402 程序化替换回发置脏——后者涉无指令静默改写文件，建议优先）；P3×2（E403-E404）。

### 3.6 测试域（test/ + vitest/playwright 配置）

**画像**：studio 497 件（真 HTTP 集成 + 前端单测）/ ai 157 件（含真本地 HTTP 假 LLM）/ document 125 / format 71 / check 57（含语料 golden-master 门）/ e2e 33 spec 串行顺序契约 / soak 五段内存门 + governance/corpus/scripts 三元「元测试层」。**亮点**：断言行为级且防「空转假绿」成体系（语义锚/checkId 死亡守卫/token 注入 403 硬失败）；测试基建单源化持续治理（bootStudio 收编 119 份样板）；e2e 串行 + 顺序快照双守卫 + pageerror 红线自洽。

**问题**：P2×4（F401-F404）；P3×5（F405-F409，多为登记类）。

### 3.7 构建与工程域（package.json 族 + tsup/electron-builder/vite/eslint 配置 + scripts + CI + 仓库卫生）

**画像**：tsup 全 bundle + node_modules 整树排除（−27M）；check-counts AST 化 `.only/.skip` 门禁 + 双包共享运行时漂移门；tag 发布门复刻全部门禁 + asar 实包断言 + SHA256SUMS；git 零构建产物入库、最大跟踪文件 package-lock 276KB。**亮点**：自检脚本设计「门禁的门禁」级；esbuild 钉版附 advisory 与放开前置条件；知识层内容资产 sha256 双向对账。

**问题**：P2×5（G401-G405）；P3×6（G406-G411）。

## 四、P2 问题详单（17 条）

### 运行时代码（8 条）

**A401〔ai〕记账路径同步跨进程锁 + 双 fsync 阻塞事件循环** — `src/ai/calls.ts:240-245`（atomicWriteFile + 两次 fsync + 0600）、`calls.ts:336-406`（serializedLockedWrite 同步锁段，:395 注释自认慢盘/网络盘代价）。每次 AI 调用（含每次重试 attempt）收账都在 server 主线程同步执行「取跨进程锁 + 读账本 + 双 fsync」，网络盘上直接冻结 SSE 推送与编排协程。注释已声明为已知取舍——本轮复核确认其为该域唯一全局阻塞点，登记为工程债（候选方向：记账写下沉 Worker 或改异步锁段）。

**B401〔events〕firstBranchMetaSeq 无索引 LIKE 全表扫描挂在 chat/history 热区** — `src/events/store.ts:742-752`（`data LIKE '%"branchId"%'` 对全书 events 的 JSON 正文逐行匹配，`node:sqlite` 同步执行），调用点 `src/studio/server/api/chat-history.ts:82`。每次对话历史加载同步扫整书 JSON 字节（含全部对话正文 blob），重书下阻塞事件循环（含他书 SSE 心跳）。0917 批为该查询建了 prepared 缓存（C002 收编）但扫描本身未动。建议：events 表加生成列或独立 branch-meta 索引表。

**B402〔server〕审计视图每次翻页全量物化双事件流** — `src/studio/server/api/audit.ts:109,149`（`listEvents` 全量物化 + 同步 JSON.parse，页切片只缩响应体不缩解析量）。PM-10 注释声明 eventsTotal/shadowedCount/首屏对照的全量语义必需——但流式 `iterateEvents` 原语（store.ts:755 起，专为重书读侧设计）可在同语义下把峰值降到聚合桶规模，未用于此路径。重书下每次审计翻页可秒级阻塞。

**B403〔server〕chat-history 尾窗「已触底」判定在坏行降级下误报** — `src/studio/server/api/chat-history.ts:86`（`covered = tail >= totalEvents || events.length < tail`）配合 `listEventsTail` 丢弃不可解析行：`countEvents` 计坏行而尾读丢之，表内存在 ≥tail 行但部分损坏时被误读为已达表头，提前触底返回 `truncated:false`——旧历史无声隐藏（少报不多报；触发条件 = DB 行损坏，罕见但真实）。

**B404〔document/events〕merge-undo 定位事件全量同步迭代** — `src/document/structure-merge.ts:362`（`locateLatestMergeEvent` 以无 type 下推的 `iterateEvents` 走完整书事件找最新 structure.merge），调用点 ：497/:608（重试路径两次）。重书下一次结构撤销 = 全事件表同步读 + 解析。与 B401/B402 同族：`iterateEvents`/`listEventsTail` 已建而重读侧未收编。

**C401〔desktop〕workdir.json 读失败 fail-open 后被空历史覆写** — `src/desktop/workdir-controller.ts:63-88`（非 ENOENT 读失败 warn 后**缓存 emptyStore 且不再重读**）+ `workdir-store.ts` writeStore 原子覆写。Windows 杀软/同步盘瞬时 EBUSY/EACCES 落在启动读取窗时，此后任意一次 setCurrent/saveCurrent 即以「current=新值、recent=[]」覆盖磁盘上原本完好的 workdir.json——库指针与最近列表全失（书本体无损）。R61-B-2 注释声明「启动可用性优先」取舍，但**读失败→写丢失的放大面**未被该取舍覆盖，且与 `src/install/books.ts` 对 books.jsonl 的 DA-3「读失败拒绝重写」纪律不对称。修复成本低：写前对「读失败来源的空 store」拒写或重读一次。

**E401〔前端〕流式正文 `<pre>` 全量插值未与字数统计同样防抖** — `src/studio/web-next/src/components/workbench/WbDraftCard.vue:34`（`<pre>{{ wb.textOut }}</pre>`）+ `stores/workbench.ts:190-199`（每 text 事件整体拼接）。每 SSE text 事件触发全文重排，一章流式长到 N 字累计 O(N²/chunk) 布局成本；R46-4 注释已承认该形态成本，却只给字数统计加了 150ms 防抖（useDebouncedWordCount），正文插值本体未做同款节流/rAF 合并。长章 + token 级小 chunk 高频事件下与同屏事件流争帧。

**E402〔前端〕程序化全量替换回发置脏，非规范 fm 文件「无输入即置脏」并触发改写** — 证据链：`src/editor/CmHost.vue:188-199`（updateListener 对**任何** docChanged 事务在 `pendingDocSwitch === null` 时回发）+ `:338-341`（applyDocSwitch 先清挂位再 dispatch 全区间替换→该事务同步触发回发；applyExternalReplace :299-330 同理）+ `src/views/EditorView.vue:85-89`（onBodyChange 以 `mergeFm` 规范形往返重组，`merged !== content` 即置脏）+ 解析侧刻意容忍非规范形（frontmatter-core.ts:48/54/62 BOM/fence 尾空格/CRLF）。后果：对 fm 非规范的存量文件（外部编辑器产出），**仅切换文档或一次外部同步**即标记「未保存」，autosave 30s 内在作者零输入下重写并规范化该文件（去 BOM/归一换行）。内容不丢，但属无指令静默改写 + 状态条误报。建议：程序化替换事务后抑制一次回发，或 onBodyChange 对回环值短路。

### 测试面（4 条）

**F401〔test〕e2e 顺序契约恢复路径防御不对称：conflict.spec afterAll 无守卫** — `test/e2e/conflict.spec.ts:32-35` 恢复是裸 `writeFileSync` 两连写无 try/catch，对照 `edit-save.spec.ts:35-51` 三步恢复各自 try/catch + `[e2e-restore]` 标记。共享单一 workDir 的串行契约下，第二步抛错留污染且下游 spec 无因红。

**F402〔test〕全局 fetch 包装豁免表是手工抄本、无同步机器门** — `test/helpers/studio-token-setup.ts:65` 的 `GET_TOKEN_EXEMPT` 抄自 `src/studio/server/index.ts:158`，注释约定「保持同步」但无 governance 反向守卫（对比 coverage EXCLUDE 抄本有守卫）。服务端新增 GET 豁免端点而抄本漏更时，包装器注入 token 造成语义漂移且难排查。

**F403〔test〕巨型测试文件六件 700-900 行** — rag/index 893 / webnext/chat-store 877 / settings-book-analysis 856 / format/yaml 818 / export/export 763 / ai/runner 750。desktop 已示范拆分先例（2800→6 件），其余未跟进。

**F404〔test〕墙钟界值类测试为受管理的固有 flaky 面** — check/rag scale（×12 预放大 + 平台/CI 乘子，曾两轮 CI 假红）、`ai/chat-abort.test.ts:93`（3500ms 上界仅 500ms 判别窗）、`driver/cc-cancel-stream.test.ts:44,66`（sleep(150) 超时启发式）。有 retry 与语义锚兜底，但换基线机器需人工复校，属长期维护税（登记 + 建议随机器换代集中复校一次）。

### 构建与 CI（5 条）

**G401〔build〕CI 无依赖漏洞扫描门** — ci.yml/desktop.yml 全文无 `npm audit`/osv-scanner/lockfile 审计步骤；依赖安全目前只有 dependabot weekly PR（间接、有窗口期）+ 作者手扫（esbuild 钉版即手扫产物）。建议加一条 osv-scanner 或 `npm audit --audit-level=high`（非阻塞起步）。

**G402〔build〕win 腿整跑重试可洗白间歇真失败，且逻辑双份复制** — ci.yml:126-136 与 desktop.yml:79-89 逐行复制品（上游 tinypool 竞态兜底，注释自认「间歇 flake 可能被洗白一跑」）。属文档化取舍；上游修复时两处易漏撤一处，建议收编 composite action 或注释互指。

**G403〔build〕出货平台 Windows 的 e2e/release-smoke 零 CI 覆盖** — desktop.yml:119/126/129 三步均 `if: runner.os == 'macOS'`，ci.yml e2e job 仅 ubuntu。win 是 NSIS 首发平台而前端动线回归从未在其发布链自动化验证（D5 拍板留档的已知缺口，缺口方向与发布权重倒挂）。win e2e 首跑成本（playwright chromium + 串行 33 spec）约 +3-4min，建议纳入 desktop.yml win 腿。

**G404〔build〕tag 发布门缺 soak 内存门** —「200 万字不崩」的有界内存门只在 ci.yml e2e job（:287-292），desktop.yml 无同款。tag 可指向未过分支 CI 的提交（M-3 注释自认该场景真实存在），内存回归可随 DMG/exe 出包。coverage 缺席有书面理由，soak 缺席无声明——至少补声明或补步。

**G405〔build〕双包安装顺序无编排，跨包依赖靠步骤纪律** — 干净环境只跑根 `npm ci` 后 `build:all`（vite build）与子包 typecheck（tsconfig paths 钉根 node_modules）直接挂；正确顺序只写在 CI 步骤与注释里（desktop.yml:49-51 自述）。无 workspaces、无根安装脚本兜底，新克隆首跑体验脆弱。

## 五、P3 问题清单（30 条）

| 编号 | 域 | 问题（证据锚） | 定性 |
|---|---|---|---|
| A402 | ai | chat 内嵌写章期间 `isWriterRunning` 恒 false，sync 快照 running 失真（self-heal.ts:100-106 / turns-tools.ts:234-244 / cc.ts:374-381 / stream.ts:365；中断不受影响——chat ctrl 桥接 + /interrupt 全停覆盖） | 登记系一轮 E002 拍板口径（对话期假忙根治）的残余面；如需收口可给内嵌写章独立 owner 登记 |
| A403 | ai | 消费者队列溢出 notice 只派发 chat store，写手腿（真正丢事件侧）无本地提示（cc.ts:196-204 / useSse.ts:336-340） | 登记系 R72-11 拍板；建议 workbench 面板补一条溢出提示 |
| A404 | ai | providers store 单槽 mtime 缓存，多书库交错调用反复 miss 重读+解密（store.ts:79/222；registry 层已 LRU 8 未对齐） | 可行动，小改 |
| B405 | server/前端 | SSE `?token=` 查询串过渡回退通道仍在（stream.ts / useSse.ts:267-272，一次性 warn 留痕）；本机回环实际暴露面小 | 登记，R30-25 移除条件在案；本轮两域再次独立发现，作持续存在信号注记 |
| B406 | events | SessionRecorder pending>256 溢出静默丢最旧事件、无 gap 标记（chat-bridge.ts:139,216-232）；validateEventStream 无法检测断链 | 可行动：补一条 gap 标记事件 |
| B407 | events | bookHash 的 win32 trueCasePath 启动期同步递归规整，网络卷掉线冻结启动（store-migrate.ts，注释自认） | 登记 |
| C402 | fs | fsBackoffSleep 同步 Atomics.wait 冻结事件循环（atomic.ts:39-41，EPERM/EBUSY 退避 3×50ms 逐文件叠加） | 可行动（批处理场景改异步孪生） |
| C403 | desktop | 独立 server 入口 exitNow 恒 exit(0)，close 携错也按成功码退出（server-main.ts:75-79）；发布 e2e 冒烟可能把关停异常掩成绿 | 可行动，一行 |
| C404 | desktop | os-kek.json 形状损坏静默回落 v1 且不自愈、部分路径无 warn（os-kek.ts:37-42） | 可行动（补 warn + 自愈重建） |
| C405 | desktop | ipc.ts relaunch 裸 setTimeout 不留句柄违 timer 纪律（ipc.ts:127/161，对照 context-menu.ts:47-62 明文规定）；有 arming 兜底实际风险低 | 可行动，纪律对齐 |
| C406 | fs/document/events | 同步跨进程锁残余调用点四处（cross-process-lock.ts:321-322；lead-finalize.ts:136 / analysis.ts:130 / events/store.ts:316 / install/books.ts:264），锁争用时冻结事件循环至 5s 档 | 可行动（逐一评估换异步孪生，HTTP 可达路径优先） |
| C407 | desktop | mode 0600 在 Windows 无 POSIX ACL 语义（server-manager.ts:215 / os-kek.ts:47；注释已声明威胁模型不含同用户本机进程，DPAPI+ACL 补位） | 登记 |
| D401 | document | 伏笔命中片段按 UTF-16 码元切片可劈开代理对（foreshadow.ts:349-352，SNIPPET_RADIUS ±15 边界落代理对中间），展示层乱码且参与 trail 过滤匹配；与全库码点口径不一致 | 可行动（边界按码点回退，同 journal.ts adjustBack 手法） |
| D402 | metrics | 对话标签基线占比 ≥~0.77 时漂移阈值 ≥1.0 数学上不可达，该项被静默禁用（style.ts:240-242 无上界 clamp） | 可行动（`Math.min(..., 0.99)`） |
| D403 | format | book.yaml 全角空格（U+3000）缩进按 1 位计破坏 2 空格栈匹配，子键静默错挂外层（yaml.ts:86-93；tab 有 warn 此形态无） | 可行动（补 warn 或归一拒绝） |
| D404 | document | 定稿标题回退剥扩展名仅认小写 `.md`（finalize.ts:428-431 缺 `i` 标志），`.MD` 尾巴进版本元信息；全库其余判定点均大小写不敏感 | 可行动，一行 |
| D405 | metrics | 短篇分布并列排序 localeCompare 随宿主 ICU 漂移（short-index.ts:475；version.ts R0912-5 已因同类理由改字节序） | 可行动，小改 |
| E403 | 前端 | 事件流终局标签表缺 `failed` 分支，落英文原文（WbAdvanced.vue:53-54 对照 sse-guards.ts:42 白名单） | 可行动，一行 |
| E404 | 前端 | boot 失败最坏 ~16.5s 白屏后才挂载（client.ts:25-27 三次退避 + main.ts:25 top-level await 阻塞 mount）；离线态机制已具备只差不 await | 可行动（先挂载离线 UI） |
| F405 | test | 双临时目录卫生体系并存（mkdtempTracked 472 件 vs 裸 mkdtempSync 146 件，文档化取舍），复制旧样板误用面持续 | 登记 |
| F406 | test | e2e 选择器以 CSS 类为主，`data-testid` 全前端仅 6 处，样式/类名重构脆 | 可行动（随触达渐进） |
| F407 | test | coverage 不含 scripts/*.ts（有意取舍，tsc/eslint+直测兜底）；e2e 单 chromium 腿（Electron 同核） | 登记 |
| F408 | test | 金测夹具更新靠纪律链（prompt-golden.test.ts:6-7「改资源→同步夹具→versions.json 追加」），无半自动 diff 工具 | 登记 |
| F409 | test | 注释/台账密度极高（R 轮次引用体系），可追溯性极好但新维护者信噪比偏低，部分文件注释:代码接近 1:1 | 登记 |
| G406 | build | GitHub Actions 未按 commit SHA 钉版（checkout@v4 等 + dependabot 持续浮动 major），与最小权限严谨度不匹配 | 可行动 |
| G407 | build | playwright 缓存键手写 `1.61.1` 与 package.json `^1.61.1` 双真相源（ci.yml:209 / desktop.yml:115），dependabot 升 lock 后缓存永久 miss 重下 130MB | 可行动（键改读 lock 或加注释互指已有） |
| G408 | build | soak CI 断言硬编码 `-eq 5` 段数（ci.yml:292），补段须人肉同步工作流 | 登记（fail-closed 方向） |
| G409 | build | check-counts 对 README 措辞 8 处正则强耦合（check-counts.mjs:613-636），排版改写即触发对账红 | 登记（fail-closed 不假绿，维护摩擦单向放大） |
| G410 | build | tsup.config.ts 配置加载期副作用 rmSync dist/desktop（tsup.config.ts:18-21，有 watch 守卫与绝对化，风险受控） | 登记 |
| G411 | build | 根/子包 typescript 版本范围声明不一致（^5.5.0 vs ^5.6.0，lock 均解析 5.9.3 无实际漂移；共享运行时漂移门只管 vue/pinia/plugin-vue 三件） | 登记 |

## 六、处置建议（优先序，供作者拍板）

1. **建议优先真修**（影响数据/用户可感，改动小）：C401（workdir 覆写边界，对齐 DA-3）、E402（静默改写存量文件）、B403（坏行触底隐藏旧史）、C403/C404（exit 码 + os-kek 可观测性）。
2. **性能热区批**（重书可感，方向明确）：B401（branch-meta 索引化）→ B402/B404（iterateEvents 收编）→ E401（textOut 渲染防抖）；A401 记账 IO 下沉可并入或另批。
3. **工程加固批**（CI 供应链与发布对齐）：G401（漏洞扫描）+ G403（win e2e）+ G404（tag soak）+ G406/G407（钉版/缓存键）。
4. **测试维护批**（随触达渐进）：F401/F402 小改即可；F403/F406 渐进；F404 登记复校。
5. **登记类不催改**：A402/A403/B405/B407/C407/F405/F407/F408/F409/G408/G409/G410/G411（多为已有拍板或 fail-closed 方向的已知取舍）。
6. 其余可行动 P3（A404、B406、C402、C405、C406、D401-D405、E403/E404）可并随相邻功能批顺带处置。

## 七、评审口径备注

- 行号与机理均基于基线 `7fd37bd2` 实测；主审对 C401/B401/D401/D402/E402 五处关键证据亲读源码复核坐实，其余采信分域深读代理的行级证据（各域代理均声明逐文件实读、宁缺毋滥口径）。
- 「在案取舍登记」类条目 = 代码注释或既有拍板已声明该形态（本轮经 git 实态对账确认非已修项复发），列出供全景与升级信号参考，不构成催改。
- 本轮不读前三轮报告正文；增量对账以三批修复批的代码实态（修复锚点在位性）为准，未做与前三轮 P3 清单的逐条互斥证明（前三轮 P3×36×2 全量已修，理论重叠面极小）。

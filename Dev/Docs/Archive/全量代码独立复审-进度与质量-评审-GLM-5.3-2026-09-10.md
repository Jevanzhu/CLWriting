# 全量代码独立复审——进度与质量

> **归档记**（2026-09-11 归档批，作者指令「已经完成的文档，归档。」）：本报告已收口，自 `01-评审/` 移入 `Archive/`（扁平）；台账 §一 原行随批冻结 `Archive/台账历史明细-归档-2026-09-08.md`；历史正文不改写，开放残留项以台账 §三 现行为准。

- 日期：2026-09-10
- **执行模型（主审）：GLM-5.3**；子代理：8 路领域评审代理（general-purpose，同模型 GLM-5.3，两波各 ≤4 并发，遵守派发上限）。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务。」
- 评审基线：dev 分支 HEAD `267e6864` + 未提交在途修复批工作树（71 文件改动 +1340/−262 + 13 个未跟踪测试，即 R1010b 修复批产物，未提交）。L2 实测即在该工作树执行。
- **独立性声明**：8 路子代理全程禁读 `Dev/` 既有评审与台账、禁读 git log 正文；主审仅在评审结论定档后读取台账/总览做索引同步与「新发现 vs 登记维持」对账（总览第三节开放任务在启动时读取，用作进度对照基线——系路线图非评审文档）。全部结论来自代码与测试亲读。
- 评审对象：`src/**` 466 个 TS/Vue 文件 ≈107,650 行（排除 node_modules 口径）+ `test/**` 1064 文件 ≈161,210 行 + 配置/CI/scripts/根 README。
- 方法：八域两波子代理（波 1：AI 链路 / 服务端与数据服务 / 桌面壳与基础层 / 写作引擎域；波 2：前端核心 / 前端组件与视图 / 测试体系专项 / 工具链构建 CI）+ 主审对 **P2×12 全部 file:line 亲验**（含 1 条亲验过程中先证伪后纠错复核成立的记录，见 §4.3）+ L2 客观门九件套实跑。

---

## 一、结论速览

| 维度 | 结论 |
|---|---|
| **项目完成进度** | **≈95%（区间 93–96%）**。功能面基本完备：建书→备料→生成→机检→定稿→导出的创作主闭环全链路实装，版本/回收站/伏笔/三审/改写/审稿/学习/文风/关系/总览全部有实现有测试，全域零 TODO/零桩。剩余 ≈5% = 阶段 24 章节结构操作（唯一已拍板设计未开工的大项，独立确认代码零实现痕迹）+ AI 链路 2 项动作面缺口 + 发布收尾 3 项（签名/自动更新/mac x64，已披露决策）+ 长尾 e2e 4 旅程。 |
| **项目完成质量** | **A-（优-）**。八域均 **0 P1**；P2×12（7 条本轮新发现 + 5 条既有登记项复核成立，无正确性阻断级——多为功能面缺口/依赖与发布卫生/测试治理面）；P3≈44。L2 客观门九件套实跑全绿且 README 账实一致。工程纪律（回归锚测试、注释决策台账、并发与崩溃一致性防御、账实对账机器门）在同类项目中属最高梯队；主要扣分 = 注释/编号考古成本（六域独立提出）、同族修复不同步残留数处、平台矩阵末端覆盖不对称。 |

分域定档：

| # | 域 | 规模 | 完成度 | 质量 | P1/P2/P3 |
|---|---|---|---|---|---|
| 1 | AI 链路（src/ai） | 76 文件 | 85–92% | 良上（近优） | 0/2/6 |
| 2 | 服务端与数据服务（server+rag+knowledge+export+git） | 62 文件 | 92–97% | 优 | 0/0/4 |
| 3 | 桌面壳与基础层（desktop+fs+events+install+state+driver+log） | 52 文件 | 92–95% | 优（带保留） | 0/2/7 |
| 4 | 写作引擎域（process+check+format+document+cache+metrics+review+learn） | 83 文件 | 93–96% | 优（近优+） | 0/1/3 |
| 5 | 前端核心（api/stores/composables/shared/editor） | 83 文件 | 95–98% | 优 | 0/0/8 |
| 6 | 前端组件与视图（components+views+pages） | 102 文件 | 93–96% | 优 | 0/0/7 |
| 7 | 测试体系（test/** 专项） | 1064 文件 | ≈83%（资产口径） | A（体系优秀） | 0/5/4 |
| 8 | 工具链/构建/CI/治理面 | 配置+scripts | 92–96% | A- | 0/2/5 |

> 八域无一方低于「良上」；两域（服务端、前端核心）零 P2。P2 集中在「登记在案的功能面缺口」与「本轮新发现的依赖/测试治理卫生」两类，均非阻断。

## 二、客观门实测（L2 九件套，主审亲跑，2026-09-10 工作树）

| 门 | 结果 |
|---|---|
| tsc --noEmit | 0 错 |
| vue-tsc --noEmit（web-next） | 0 错 |
| eslint . | 0/0 |
| check:counts | 过——实测 1021 测试文件 / 6594 单测；29 e2e spec / 45 用例；README 声称值与实测一致 |
| check:packaging | 过（resources 入清单、prompt 版本表对账） |
| check:knowledge | 过（13 条 manifest 双向对账） |
| vitest 全量 | **1021 文件 = 6594 过 + 4 跳，0 败**（136.18s） |
| e2e（build:web + playwright） | **43 过 + 2 跳**（26.6s） |

与 R1010b 修复批收口记的口径（1021/6594、43+2）完全一致，账实无漂移。

## 三、分域评审摘要

### 3.1 AI 链路（76 文件，良上，85–92%）
runTask 统一执行器（mock 快路/内外双 ctrl 中断归因/指数退避重试/四路 usage 入账/ChainRecorder 落库）+ 三适配器（anthropic/openai-chat/openai-responses，400 两级降级链）+ 编排双栈（self-heal 写章闭环五终态 / chat 状态机 per-book 队列 + waitConfirm 确认闸 + checkpoint 压缩）。**0 TODO/桩**；「模型可见⟺已记录」两链路真闭环（digest16→snapshot 事件→生产抽查；promptFiles 全并入 promptMeta）；凭据信封加密 AES-256-GCM+AAD。测试断言行为级（退避实参 spy、双计回归、金测字节等价）。P2 两条均为源码自认登记缺口：switch-provider 决策动作全链无消费者（配额/凭据失效无自动换供应商兜底）；shrink-prompt 仅 chat 主模型发送处接线（self-heal/spawn/rewrite 超窗 400 直终态失败，200 万字后期设定膨胀时撞窗概率上升）。

### 3.2 服务端与数据服务（62 文件，优，92–97%）
零依赖原生 http 手写栈：defineRoute 单点声明 109 路由全实装零桩；多层安全闸（Host 精确匹配防 DNS rebinding/Origin 白名单/写端点 token 常量时间比较/1MB body 上限/SSE 一次性 ticket）；并发治理（进程内 Set + O_EXCL 跨进程文件锁 + pid 存活探测 + 六族编排互斥矩阵，同步占位→await 后二次复检闭合 TOCTOU）；原子写全链 tmp+fsync+rename；删书墓地/导出归档不删/Float32 毒行三层守卫——数据永不静默丢失。RAG 200 万字规模基准实测在库（700 章/3.5 万块/1536 维）。**0 P1/P2**。P3 四条（测试命名导出进生产路径 / RAG watchdog 双跑窗 / chat-history 尾窗全量投影〔PM-10 登记〕/ 导出排队持闸 10min）。

### 3.3 桌面壳与基础层（52 文件，优带保留，92–95%）
Electron 安全五件套（标志后置防覆盖/contextIsolation+sandbox/IPC 三重 sender 校验/CSP/导航全拒）；启停三链互斥优雅停机；崩溃自愈（渲染 3 次 reload/服务 3 档退避/journal pending 确定性结算含同 inode 硬链中间态）；fs 原语层（锁指纹+释放逐字节校验+stale 接管 jitter）。P2-1：事件投影读链 O(N) 数组物化——listEvents 虽为 SQLite 游标流式（非 JSONL 全文读，子代理初稿表述经主审修正），但返回 ChatEvent[] 全量物化，五处调用面（chat-history/audit×2/chat-branches/restore×2）无 limit 全量拉取，内存峰值与延迟随事件总数线性增长，与 200 万字目标构成架构性错配（PM-10 尾读通道登记待拍板）。P2-2：PM-12 生产 kill 不接线——fontListWithTimeout 生产不传 deps.command，mac/linux 超时走 load 路径「放弃等待」，挂起子进程成孤儿（R48-17 备案 + 台账 PM-12 待拍板；熔断器已生效挡反复重试）。

### 3.4 写作引擎域（83 文件，优近优+，93–96%）
存储契约（文件树+清单 jsonl+journal 事务日志+快照档案）与写路径协议（跨进程 save 锁→锁内复核→journal pending 全文快照→覆写留底→原子写→settled）崩溃一致性四段任意点可恢复；码点口径贯穿全链；11 项机检+两端闭合账本核验；单读派生纪律（一次 Buffer 读派生四产物）；降级三态哲学（读失败≠空，防瞬态故障变作者红项）。**P2-1（本轮唯一正确性级新发现，含登记增量）**：裸数字章 `1.md` 口径分裂——正则 `/^(\d+)(?:[-—]|\s|$)/` 对 `1.md` 返回 null，tree.ts:84 先 stripMd 再判故**树排序认得**，而 summary/leads/foreshadow 三处带全名调用**不认**（卷链残链报缺/伏笔足迹缺章/线索核验黄噪）；R1010b 修复注释宣称覆盖 `1.md` 与实现/测试三方不一致（详见 §4.2 EN-P2-1）。**留洞制章节结构操作（阶段 24）零实现痕迹**：DocumentService 无合并/拆分/序/并入映射任何方法，且 `updateChapterMeta` 允许自由改写章号无 append-only 防护——设计未落地（待作者指令），非桩。

### 3.5 前端核心（83 文件，优，95–98%）
api/client.ts 单一 HTTP 出口（token 生命周期/401 防抖重放/超时分档/信封解包）；16 个 Pinia store 无一例外贯彻「代数守卫+在途台账+await 后五连复查」并发纪律；doc.ts 保存链多层防丢（autosave→dirty 镜像分级节流+复活时效门→关窗冲刷→冲突决断）；SSE 换票两段式+切书纪元复位退避；CmHost IME 组合守卫贯穿+外部替换两步真重置撤销栈。**0 P1/P2 高置信**（保存竞态/镜像复活/撤销回灌/切书污染候选逐条亲读证伪）。P3 八条（SSE token 自愈依赖心跳间接耦合无测试钉住 / 404 无 catch-all / sanitizeName 未拒 Win 非法字符 `:"<>|?*` / 撤销栈测试为镜像复制非真实 mount / flushDirty 理论无界 / discard 竞态窄窗自愈 / rewrite.ts 头注陈旧 / 全库无请求取消接线）。

### 3.6 前端组件与视图（102 文件，优，93–96%）
五层结构（pages→views→shell→panels→ui）+ 16 store 单一事实源面板间零直接通信；巨石组件已系统性拆分；渲染上限（RENDER_CAP=100+滑窗+省略计数）与 FontPicker content-visibility 三层优化成体系；IME 让渡单源化；a11y 成体系（树 roving tabindex WAI-ARIA 模式/焦点陷阱嵌套让渡/危险弹窗默认聚焦安全项）；失败可见化纪律全域贯彻。**0 P1/P2**。P3 七条（TrashPanel 按钮焦点不可见——HistoryPanel 同型已修此处漏修 / 四面板缺 RENDER_CAP / SearchPanel 命中截 3 条无余量提示 / 全屏书架无上限 / CommandPalette 无 listbox 语义 / ContextMenu 回退子菜单键盘不可达〔登记〕/ cap-hint 行右键无菜单）。

### 3.7 测试体系（1064 文件，A，资产完成度 ≈83%）
1050 vitest + 29 e2e spec；静态用例 ≈6464 与实测 6594 对账误差 <2%；断言质量 A 级 ≈70–75%（行为断言+回归锚）、冒烟 <5%；反模式近零（.only 残留 0 / 快照滥用 0 / 真实 sleep 仅 8 处必要 TTL）；**5 个 governance 元测试守护测试体系自身**（coverage 空桶防御/依赖方向/mock 零计费/「模型可见⟺已记录」验证器/README 数字对账门）；规模基准直指产品承诺（check 500 章/150 万字、rag 2000 章耗时上界）。P2 五条见 §4.2（Electron GUI 零交互 e2e / win32 74 处跳过用例三腿皆不跑 / corpus 语料 4 checkId 覆盖面窄 / e2e 顺序契约结构性耦合 / studio-server branches 69% 阈值最低门）。

### 3.8 工具链/构建/CI/治理（A-，92–96%）
tsup 双 config 显式全落定；双 lockfile 入库+eol=lf+CI 干净安装；coverage 八桶阈值门防聚合稀释；**tag 发布门焊死全门禁 + 打包态 Electron 真实启动三重判定冒烟（双平台）**；README 账实对账门九处声称机器核对（本轮独立复算全命中）；治理脚本安全素养（路径穿越+win 保留名双校验/凭据 argv→env）。P2 两条：根 package.json 缺 `"private": true`（prepack 会真构建、npm 误发即真实发布）；vue 双 lockfile 已漂移（3.5.38 vs 3.5.40）且无对账门（163 个组件测试跑的 vue ≠ 发布构建的 vue，漂移无门会红）。P3 五条（asar 内 SDK 双份 / engines 软约束 / mac 仅 arm64 / 无 dependabot / tag 门无 coverage 步）。

## 四、问题清单

### 4.1 P1：**0 条**（八域均无正确性阻断/数据损失/安全失守级发现）。

### 4.2 P2（12 条，主审全部 file:line 亲验）

**本轮新发现（7 条）**：

| 编号 | 域 | 问题 | 证据 | 置信度 |
|---|---|---|---|---|
| TL-P2-1 | 工具链 | 根 package.json 缺 `"private": true`——误跑 `npm publish` 即真实发布（prepack 先构建齐备 files 清单，包名/版本号被消耗；CI npm pack 门反增误发成功率）；子包有而根包无 | `package.json:1-73` 无 private 字段（对照 `src/studio/web-next/package.json:3`） | 高 |
| TL-P2-2 | 工具链 | vue 双 lockfile 版本漂移：根 3.5.38 / 子包 3.5.40，@vitejs/plugin-vue 6.0.7/6.0.8 同漂；vitest alias 钉根副本、vite 构建按子包解析——**单测运行时 ≠ 发布构建运行时**，漂移无任何门会红；另双 vite major 并存（根 7.3.5 传递/子包 8.1.5） | 两 lockfile `node_modules/vue` version 实测；`vitest.config.ts:33-44` alias | 高（漂移事实）/中低（当前 patch 级影响） |
| TS-P2-1 | 测试 | Electron GUI 零交互端到端：release-smoke 明示「无 GUI 环境可跑（不启动 Electron）」；desktop main 全假件灰盒；tag 流有打包态启动冒烟（存活+ready 标记+无崩溃）缓解，但「双击开窗→点得动」的交互面最后 100% 靠人工 | `test/e2e/release-smoke.spec.ts` 头注；`test/desktop/main.test.ts` | 高 |
| TS-P2-2 | 测试 | `skipIf(platform==='win32')` 74 处（47 文件）用例在**所有 CI 腿都不跑 win 实机**——路径语义/权限/进程行为差异仅 mac/linux 验证非 win 行为，win 特有回归（NTFS/Defender 平台税已有先例）无对应用例兜 | grep 实测 74 处/47 文件；win 腿跑 typecheck+build+单测（跳过态） | 高 |
| TS-P2-3 | 测试 | corpus golden-master 语料门「架子好料薄」：仅 4 个 checkId（banned-word/body-parts/repeat/sentence-length）vs check 引擎 14+ 检查器——真实文本误报回归守护面窄，多数防线仍是构造样例 | `test/corpus/checks/` 目录实测 4 文件 | 高 |
| TS-P2-4 | 测试 | studio/server branches 覆盖阈值 69%——全项目八桶最低门（其余 83–93），API 层分支复杂度与错误路径密度的信号；阈值只防回退不追高 | `vitest.config.ts:115` | 高（配置自证） |
| EN-P2-1 | 引擎 | **裸数字章 `1.md` 口径分裂（登记项复核成立 + 本轮新增失实点）**：`chapterNoFromName('1.md')`=null（正则数字后须 -/—/空白/行尾，`.` 不匹配，node -e 实测）；tree.ts:84 先 stripMd 再判故树排序认得；summary.ts:527/442、leads.ts:103、foreshadow.ts:574 带全名调用均不认——卷链残链报缺/摘要自愈跳过/伏笔足迹缺章（静默）/线索核验黄噪。**新增失实点**：R1010b 修复注释宣称「`1—开局.md`/`1 开局.md`/`1.md` 等宽容命名的定稿章既不进 chain 也不进 missing（意即已收编）」——实现与测试（`filename.test.ts:133-136` 钉死 `5.md`→null）均与之相悖。台账 R1010b CORE 行已登记扩集待拍板 | `src/format/filename.ts:139`；`src/process/summary.ts:522-527`；`test/format/filename.test.ts:133-136`；`src/document/tree.ts:84,105` | 高（正则实测+四调用点亲读） |

**既有登记项复核成立（5 条，维持登记/待拍板）**：

| 编号 | 域 | 问题 | 出处 |
|---|---|---|---|
| AI-P2-1 | AI | switch-provider 失败决策动作全链无消费者——配额耗尽/凭据失效无自动换供应商兜底，用户直面终态失败 | `src/ai/provider/failure.ts:8`、`turns.ts:593`；台账 R0910 行 |
| AI-P2-2 | AI | shrink-prompt 仅 chat 主模型发送处接线；self-heal/spawn/rewrite 生成链超窗 400 直终态失败不收缩重试——200 万字后期设定膨胀撞窗概率上升 | `src/ai/orchestrate/chat/turns.ts:588-598`；台账 R0910 行（A7 最小版范围声明） |
| DSK-P2-1 | 桌面/服务端 | 事件投影读链 O(N) 数组物化：listEvents SQLite 游标流式但物化全量 ChatEvent[]，五处调用面无 limit 全量拉取——会话恢复/历史/分支切换内存峰值随事件总数线性增长（正确性无损，可扩展性错配；**子代理「JSONL 全文读」表述经主审修正为游标+数组物化**） | `src/events/store.ts:133`；`chat-history.ts:64-88`、`audit.ts:108,148`、`chat-branches.ts:30`、`restore.ts:67,77`；台账 PM-10 行 |
| DSK-P2-2 | 桌面 | PM-12 生产 kill 不接线：fontListWithTimeout 生产不传 deps.command，mac/linux 字体枚举超时走 load 路径只放弃等待不杀子进程——osascript 挂起形态下每次重试常驻泄漏一进程（熔断器已挡无限重试；win 侧 R39-5 自带 kill 不涉） | `src/desktop/font-cache.ts:289-294`（R48-17 备案）+ `:296-308`；台账 PM-12 行待拍板 |
| TS-P2-5 | 测试 | e2e 顺序契约结构性耦合：workers:1 + retries:0 + 29 spec 共享单一 workDir，前序落盘是后序输入——已两轮补丁缓解（spec 顺序快照守卫/首因 reporter/启动横幅 dismiss），机制未变，长期 flake 源 | `playwright.config.ts:24-32`（R71-38 注释） |

### 4.3 亲验过程记档（评审诚实性）

桌面壳子代理初报 P2-2（font-cache）后，主审首轮 grep 命中 `runFontListCommandWithKill` 的超时 kill 代码（font-cache.ts:181-186 区域）一度**证伪**该条；二轮复核发现该路径仅 `deps.command` 注入面可达（仅测试），生产走 `fontListLoadWithTimeout` 无 kill 句柄——R48-17 注释（:289-294）自认「生产不可达/孤儿进程残留未收口」。**结论回转为成立**，此处如实记档：单点 grep 不足以下证伪结论，须核到生产调用面。另服务端子代理自撤一条「静态服务穿越专测缺位」候选（复核发现 static.test.ts:166-181 有 symlink 外指专测）。

### 4.4 P3（≈44 条，按域摘要）

- **AI 链路×6**：stopReason 三线命名分歧（登记）/ chat LRU 在途逐出窗（登记）/ 记账同步 IO（登记）/ 加密推理多条仅保末条 / rulesPromptFiles 伪路径标签 / MAX_AGENT_TURNS=5 保守。
- **服务端×4**：测试命名导出进生产路径（stream.ts:771）/ RAG watchdog 双跑窗（登记）/ chat-history 尾窗全量投影（登记，= DSK-P2-1 同源）/ 导出排队持闸 10min（登记取舍）。
- **桌面壳×7**：菜单首窗回退子窗失联面 / WAL 退避 Atomics.wait ≤1.8s（登记架构项）/ 网盘同步 IO 残留 / 跨进程锁 µs 级残余竞态（登记）/ migrateBookDefaults 启动全量读盘 / batch-pause 锁超时裸写 / mock-cc 双总线分叉（登记）。
- **写作引擎×3**：章号 append-only 无代码强制（阶段 24 结构性前置）/ TOKEN_COEFFICIENTS 空表待校准（登记）/ chapterNoFromName 调用形态差异无对表测试（EN-P2-1 的测试面缺口）。
- **前端核心×8**：SSE token 自愈耦合心跳无测试钉住 / 无 404 catch-all / sanitizeName 未拒 Win 非法字符 / 撤销栈测试镜像复制保真度 / flushDirty 理论无界 / discard 竞态窄窗（自愈）/ rewrite.ts 头注陈旧 / 全库无请求取消接线。
- **前端组件×7**：TrashPanel 焦点不可见（HistoryPanel 同型已修）/ 四面板缺 RENDER_CAP / SearchPanel 无余量提示 / 全屏书架无上限（有意为之）/ CommandPalette 无 listbox 语义 / ContextMenu 回退子菜单键盘不可达（登记）/ cap-hint 行右键死区。
- **测试体系×4**：批次号命名新人可读性税（38% 文件名含 rXX、711 文件头注含编号）/ 临时目录清理双轨未收口 / 零直测源文件 15 个（实质项 useDebouncedWordCount 等 3 个）/ e2e 旅程空白（导入旧书/备份恢复/导出成品 UI/升级向导）。
- **工具链×5**：asar 内 SDK 双份 / engines 软约束 / mac 无 x64 产物（登记决策）/ 无依赖更新自动化 / tag 门无 coverage 步。

> 交叉主题（多域独立汇聚，值得专项关注）：① **注释/编号考古成本**——6/8 域独立提出「轮次代号渗透注释正文、离开台账上下文可读性下降」，bus factor 集中；② **同族修复不同步**——TrashPanel（HistoryPanel 已修）、四面板 RENDER_CAP（域惯例在）、sanitizeName Win 字符（chapter-tree 已做保留名）、chapterNoFromName 调用面（单源化仍漏形态）——新增面纪律低于既有水位，需巡检机制持续施压。

## 五、与产品承诺对照

| 承诺 | 落实判定 |
|---|---|
| 开箱即用 | **基本达成**：安装引导→welcome→书库→建书→进门体检链完整，错误全程人话中文，失败形态有指引；缺口 = 发布面（unsigned/无自动更新/mac x64 缺）带来首次运行摩擦（已披露+README 指引） |
| 全程中文 | **达成**：全 UI 文案/菜单/占位/错误/toast/确认中文（仅 API Key 等技术词保留英文，合理）；无 i18n 框架系承诺落实方式而非缺口 |
| 200 万字不崩 | **工程化到位、长程证据待补**：RAG 200 万字基准在库、渲染上限族、内存 cap/LRU/背压成体系、单读派生；缺口 = 事件读链 O(N)（DSK-P2-1）、生成链超窗不收缩（AI-P2-2）、十万级事件量与 200 万字全程长跑无等比例实测 |
| AI 长篇创作系统 | **达成度高**：七条链路声明化接线、15 工具 schema 全实现、三适配器+降级链、账本闭环（AI 草拟+作者确认）；缺口 = switch-provider/shrink-prompt 两动作面（登记） |
| 版本 1.0.0-rc.1 → 正式版 | **rc 定位相称**：核心链路生产级；正式版前建议收口 = 签名/公证/自动更新、private 字段、GUI 冒烟、阶段 24 |

## 六、进度评定依据（≈95%，93–96%）

- **已实现（代码+测试双证）**：创作主闭环全链路；章节树六态/回收站/版本 Time Machine/快照回滚；伏笔（迁移+FTS 足迹）；11 项机检+红项打回自愈；三审+作者裁决；改写（整章/选段+diff）；审稿单打包；学习/文风/关系/总览仪表盘；SSE 五族流端点；RAG 建查重置；导出（全本/分章/投稿视图+批注剥除+定稿过滤）；Electron 壳全防御；跨进程并发治理；AI 编排双栈。
- **未实现/未开工**：① **阶段 24 章节结构操作**（留洞制 fm 序/并入、合并干跑/软删回收站/拆分/崩溃修复——设计已拍板+执行方案已落盘，**实施待作者指令**；本轮独立确认零代码痕迹且 updateChapterMeta 自由改章号为结构性前置风险）——约占总缺口一半权重；② AI 动作面 2 项（登记）；③ 发布收尾 3 项（披露决策）；④ 长尾 e2e 4 旅程；⑤ 测试资产三缺口（win 实机/GUI 交互/语料广度）。
- 测试资产单独口径 ≈83%（78–88%）：文件级引用覆盖近 100%（462 源文件仅 15 个零引用且多为小件），八桶阈值基线 88–95%，缺在平台矩阵末端与真实语料广度而非基建能力。
- 域权重合成：功能域（1–6、8）区间 85–98% 取中 ≈94.5%；以阶段 24 为剩余大项折算总体 **≈95%**。

## 七、质量评定依据（A-，优-）

**加分面**：0 P1（八域并发排查+主审亲验）；L2 九件套全绿且账实一致；零 TODO/桩/假按钮（grep 实证）；「模型可见⟺已记录」从守则落成运行时断言+governance 机器门；崩溃一致性是默认设计（journal/原子写/锁校验/迁移墓碑）；并发防御成体系（占位+二次复检/代数守卫/五连复查）；数据永不静默丢失文化；测试断言质量 A 级 ≈70–75% 且治理自反。
**扣分面**：P2×12（虽无阻断级，新发现 7 条中 private/vue 漂移属本应零容忍的发布卫生）；P3≈44 且同族不同步复发 4 处（纪律衰减信号）；注释/编号债逼近临界（6/8 域独立提出，新维护者上手成本高）；平台矩阵末端（win 实机 74 用例空转、GUI 交互零 e2e、corpus 语料 4/14+）；长程性能面三处线性/收缩缺口与 200 万字全程实测缺位。
**档位结论**：优于 A（良上）——因工程纪律与防御密度罕见；劣于 A（优）——因发布卫生两条 P2、同族不同步复发与治理面三缺口。综合 **A-（优-）**。

## 八、处置建议（供作者拍板，本报告不擅动代码）

- **批 1 · 低风险速收（建议随下批修复）**：TL-P2-1 `private: true` 一行；TL-P2-2 双 lockfile 重叠依赖版本 CI 对账步；EN-P2-1 注释失实修账（summary.ts:522-527 宣称行改为如实口径——裸数字扩集与否按台账待拍板项走）；前端组件 P3-1/P3-2（TrashPanel focus-visible + 四面板 RENDER_CAP）；前端核心 P3-3（sanitizeName 补 Win 非法字符）。
- **批 2 · 拍板项（台账已有，本轮复核维持）**：chapterNoFromName 裸数字扩集（牵动全部消费点）；PM-10 尾读通道；PM-12 生产 kill 接线（mac asar 打包态验证面）；AI-P2-1/P2-2（switch-provider 消费者 / shrink-prompt 生成链扩展）。
- **批 3 · 测试治理**：corpus 语料扩充至全检查器覆盖；win 腿补口方案（专赢用例或标签化）；GUI 启动冒烟日常化（tag 流已有，可前移）。
- **批 4 · 实施待指令**：阶段 24 章节结构操作（正本 `02-执行/章节结构操作-执行方案-2026-09-04.md`；实施时建议同步补 EN-P3-1 章号 append-only 强制）。

## 九、收口口径

- 本报告为**评审完成 ≠ 收口**：P2 修复 + 回归通过后才收口（收口记将补 §十）；未收口不归档。
- 台账 §一 已登记本报告未收口行；总览 §1.3 已增行；`Dev/Main/README.md` 计数已同步（01-评审 暂存 5→6 篇）；`Archive/README.md` 批记行已记（本目录 ±0）。
- 工作树在途修复批（R1010b 产物 71 改 + 13 新测试）未提交状态维持原样待作者指令；本轮 L2 全绿（1021/6594 + 43+2）可作为该批提交前的门证据。

---

## 十、收口记（R1010c 修复批同日办结，2026-09-10）

作者指令：「全部修复，编排下任务做。」；中程指令：「有一个子agent失败了，让它继续。」（FE1 路撞使用限额未开工，FE2/COV 中途取消，盘点半成品后重启/收尾代理接续，四路全部办结）。

**执行方式**：主审亲修工具链组（A 组）+ 四路文件互斥并发代理（SRV / FE1 / FE2 / COV，单波 ≤4，各路文件所有权清单互斥）+ FE2 收尾核验代理 + COV 收尾测量代理。

**P2 新发现 ×7 全部处置**：
- TL-P2-1 根 package.json 补 `"private": true`（主审）。
- TL-P2-2 双侧 lockfile 对齐（vue 3.5.38→3.5.42、@vitejs/plugin-vue 6.0.7→6.0.8，两侧一致）+ check-counts 新增双包共享运行时对账门 `sharedRuntimeVersionDrift`（vue/pinia/plugin-vue/vue-router，只比对两侧齐备项——vue-router 刻意单侧存于子包）+ 4 直测（主审）。
- EN-P2-1 summary.ts:519-536 注释失实修账（如实口径：`1—开局.md`/`1 开局.md` 已收口、`1.md` 不在集、tree 剥名/三消费方全名的分裂现状、扩集系既有台账待拍板）+ 新增 test/process/chapter-no-callshape.test.ts 调用形态对表测试钉定分裂；**正则本体未动**（扩集维持拍板）（SRV 路）。
- TS-P2-1 评审误判修正：release-smoke 实际已在主 CI e2e job 日常跑（报告 §八批 3「可前移」失实，随批更正）；残余缺口收窄为「Electron GUI 交互 e2e 缺位」，Playwright _electron 投入转登记待拍板。
- TS-P2-3 corpus 语料 4→7 checkIds（+imagery-overuse/style-dialogue-tag/simile-density，各 1 fire + 1 silent 对照，入库前经门 fixture 复刻过真实 runAllChecks 验证）；余 7 个 checkId 受门 fixture 硬约束（需门书铁律阈值段/短篇 kind/布线书），扩面登记待拍板（SRV 路）。
- TS-P2-4 studio/server 覆盖：新增 cov-server-* 三文件 46 用例（收尾代理修复前任 7 红——config PUT 残缺 payload 500 / io-gate release 转移语义误读 + 短超时泄漏连锁），全量 coverage 实测 branches 69→**78.53**，阈值按 −2pp 惯例 69→**76**（statements 86→87、lines 86→87、functions 92 持平不动；其余桶未动）（COV 路）。
- TS-P2-2 本批无代码处置（win 实机投入），台账新登记。

**P3 随批收 ×14**：SRV-P3-1 生产命名导出 `forceReleaseSelfHealRunning` 收编（stream.ts watchdog 二段改用，`__setSelfHealRunningForTest` 降为测试别名零行为变更 + 等价幂等直测）；FE1-P3-1 TrashPanel 焦点显形（对齐 HistoryPanel R1010-P3 先例）；FE1-P3-2 四面板 RENDER_CAP=100 + 省略计数（分组头/统计行保持全量不虚减）；FE1-P3-3 SearchPanel「还有 N 条/20+ 条」两态提示（api/search.ts 补 hasMore 类型声明）；FE1-P3-4 CommandPalette role=listbox/option+aria-selected；FE1-P3-5 树 cap-hint 行右键死区消除（守卫排除 `.tree-cap-hint`）；FE2-P3-1 sanitizeName 补拒 `:"<>|?*`（全角不受影响；服务端 filename.ts:72,103,114 已有同集净化经主审补验销项——缺口仅前端）；FE2-P3-2 SSE 401 自愈接线（fetchStreamTicket/probeSseBusy 401→rebootstrap，403/404/429 不触发）+ 源码锚定测试钉 useHeartbeat/useSse 同挂载点耦合；FE2-P3-3 router catch-all 404→/shelf（路由表提具名导出供测试锚定）；FE2-P3-4 rewrite.ts 头注修账；FE2-P3-5 cm 两测试确认为真实 mount 形态（收尾核验，无需重构）；FE2-P3-6 useDebouncedWordCount 直测 10 用例；TL-P3-2 .npmrc engine-strict=true（engines >=24 硬门）；TL-P3-4 .github/dependabot.yml 三源 weekly。

**证伪销项 ×1**：桌面菜单首窗回退经 FE2 收尾核实**安全**——main.ts:1729 可达回退目标（主窗/书架窗/书库窗）均加载同一 SPA 且 App.vue:41 onMenuAction→useAppActions 无条件挂载（先于 isShelfWin early-return），7 个 actionKey 全落在 dispatch 面；:1821 纯主进程 maximize 不经桥接。桌面域 P3-1 销项。

**L2 终门复跑全绿**（主审亲跑）：tsc / vue-tsc / eslint 0 错 + vitest **1031 文件 = 6705 过 + 4 跳 0 败**（147.40s）+ build:web 过 + e2e **43 过 + 2 跳**（29.7s）+ check:packaging / check:knowledge 过 + **check:counts 过**（双包对账门同批上岗；根 README 修账 1021/6594→1031/6705 四处）。COV 路同批另跑一次全量 test:coverage 用于阈值实测（studio/server branches 78.53）。

**改动面**：源码 15 改（self-heal / stream / summary / chapter-tree / useSse / router / rewrite + FE1 七组件 + api/search.ts）+ 配置 5（package.json / vitest.config.ts / .npmrc / dependabot.yml / check-counts.mjs）+ 新增测试 10 文件 + 适配测试 8 文件 + 新增语料 3 json；另一侧 lockfile 对齐 2 处。零提交（工作树待作者指令）。

**残留**：5 条登记 P2 维持（台账既有行，本轮复核成立）+ 新登记 = 台账 §三 R1010c 行；报告 §八批 4（阶段 24 实施待指令）不变。本报告至此收口。

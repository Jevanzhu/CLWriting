# 全量代码重评与进度质量评审报告

> **归档记（2026-09-11 修复批）**：P1×1 + P2×2 必修全修、P3×26 随批收 22 / 维持登记 4、L2 终门九件套全绿（1049/6795+5 跳）后收口——收口记见本报告 §十，批记见 `Archive/README.md`。随修复批 git mv 移入 `Archive/`（扁平），历史正文不改写。

- 执行模型：GLM-5.3（主审 = 会话模型；八域评审子代理同模型）。
- 日期：2026-09-11。评审对象：dev HEAD `b69c9752`（工作树净，提交态）。
- 作者指令原文：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务。」
- 收口状态：**已收口（2026-09-11 修复批，见 §十）**。

## 一、TL;DR（总体结论）

- **完成进度 ≈ 95%**（分域 92–98%）：README 宣称的完整产品面（建书→设定→AI 写章→机检→三审→定稿→导出，长篇/短篇双形态，win/mac 双平台打包）全部实装、接线完整、无 stub/TODO 欠账（全库 src 仅 8 处 TODO 类标记且多为修账注释）；规划中唯一未实施项 = 总览阶段 24「章节结构操作」（已拍板 + 执行方案落盘、实施待作者指令——本轮代码核验 `structure.merge` / fm `序` 键全库零命中，确未开工）。
- **完成质量 A-**（产品代码）/ B+（工程信号面）：产品代码**零 P1、零安全漏洞发现**，服务端/前端/AI/持久化四域连 P2 都为零；本地质量门九件套亲跑全绿（vitest 1037 文件 = 6725 过 + 4 跳 0 败）。两项拉低项：① CI 六矩阵腿「测试」步持续红（四族环境面，测试侧/runner 侧——台账 §三 G 既有挂账本轮重证并补代码级证据）；② mac 打包态字体枚举存在主路径失效风险（新发现，疑似-中）。
- 本轮发现：**P1×1 + P2×2 + P3×26**（P1 与 1 条 P3 系台账既有挂账重证；新发现 = P2×2 + P3 约 19 条）。

## 二、评审方法与范围

- 规模：src ≈ 10.8 万行（桌面壳+管线内核 9.2k / 服务端 12.4k / 前端 web-next 38.9k / AI+RAG 15.7k / 核心持久化 20.9k / 支撑子系统 11.3k），test ≈ 16.4 万行，834 commits，版本 1.0.0-rc.1。
- 编排：**两波八域子代理（每波 ≤4，遵守派发上限）+ 主审亲审交叉面**——波 1：A 桌面壳+进程管线 / B 服务端 / C2 前端组件层 / D AI 链路+RAG；波 2：D 重派（见下）/ C1 前端逻辑层 / E 核心持久化 / G 测试 CI 工具链。E2 支撑子系统（check/install/export/metrics/log/driver/review/learn/knowledge）由主审抽审（check 引擎核心两文件 1.8k 行深读 + 危险模式全扫 + install 数据安全关键文件）。主审另亲审根级配置面（tsconfig/eslint/vitest/playwright/ci.yml/desktop.yml/双 package.json/知识层 manifest）。
- 纪律：全程**禁读 Dev/ 下既有评审文档**（含 Archive 评审正本），只以当前代码独立判断；每条发现要求 file:line + 失败场景，疑似项显式标注；主审对 P1/P2 逐条亲验（A-P2-1 经 electron-builder.yml files 白名单 + tsup external + font-list darwin 源码三面亲验成立）。
- 事故如实记档：D 域首次派发撞使用限额（5 小时上限）失败，波 2 原样重派成功，评审对象与纪律不变。
- 局限（读考）：A-P2-1 的打包态行为系源码级推断（当前 dist 不在盘，未做装包实测）；评审为静态精读 + 本地门实测，不含真机打包态验证与真实 AI 上游联测；E2 域为抽审而非全量代理精读。

## 三、质量门实测（主审亲跑，2026-09-11，与代理评审并发）

| 门 | 结果 |
|---|---|
| vitest 全量 | 1037 文件 = **6725 过 + 4 跳 0 败**（218.05s，并发评审中慢于平日 147s 属正常） |
| tsc --noEmit | 0 错 |
| vue-tsc --noEmit（web-next） | 0 错 |
| eslint | 0 输出（clean） |
| check:counts | 过：1037/6725 + 29 spec/45 用例，README 声称值与实测一致 |
| check:packaging | 过：resources/ 入打包清单，prompt 版本表对账一致 |
| check:knowledge | 过：知识层 13 条 manifest 与磁盘一致，反向扫描无未登记 |
| e2e（build:web + playwright） | **43 过 + 2 跳**（29.3s；2 跳 = 需 CLWRITING_E2E_RELEASE 的发布 smoke） |
| CI（远端） | **六矩阵腿「测试」步红**（四族环境面，见 G-P1-1；e2e job 绿；前置 typecheck/vue-tsc/eslint/build/packaging 门全绿） |

## 四、分域结论汇总

| 域 | 范围 | 完成度 | P1/P2/P3 | 一句话结论 |
|---|---|---|---|---|
| A 桌面壳+管线内核 | src/desktop + src/process + 打包配置 | ≈95% | 0/1/4 | 生命周期/IPC 安全/进程管理防御深度罕见；扣分集中在 mac 打包态字体枚举（A-P2-1）与备案挂账 |
| B 服务端 | src/studio/server（50 文件） | ≈98% | 0/0/4 | HTTP/SSE/并发治理/停机全链完整，安全面超出单用户回环应用必要强度；唯一功能留白 = 误报语料查询侧（有意预留） |
| C1 前端逻辑层 | stores/composables/api/入口/editor/shared | ≈97% | 0/0/3 | 竞态纪律（代际守卫族）与脏数据四层防线系统性到位；唯一未实现项 = 三审进度 SSE（声明无排期的体验增强） |
| C2 前端组件层 | components/views | ≈92% | 0/0/3 | 编辑器 IME/undo/选区工程质量高，可访问性超同类；弱点集中在 win/浏览器回退路径打磨密度低（明知的选择） |
| D AI 链路+RAG | src/ai + src/rag | ≈95% | 0/0/1 | 三协议流式解析/错误路径/取消竞态体系成熟；两硬性守则（模型可见⟺已记录、默认值显式 resolve）落实程度高且体系化 |
| E 核心持久化 | document/format/fs/events/state/git/cache | ≈95% | 0/0/5 | 数据安全基建（原子写/跨进程锁/事件账本/回写保真）成熟度罕见；扣分 = 零接线死代码面与同型守卫收编不彻底 |
| E2 支撑子系统 | check/install/export/metrics/log/driver/review/learn/knowledge | ≈95%（抽审） | 0/0/0 | 机检引擎正则边界/TOCTOU/缓存指纹处理极细；books.jsonl 穿越/保留名/NUL 三重防线；迁移幂等保注释 |
| G 测试 CI 工具链 | test 结构/CI/scripts/双包宇宙 | ≈88% | 1/1/6 | 门禁自证文化与 e2e 顺序契约纵深属最强工程面；**扣分主因 = 主 CI 门持续红（信号失效中）** |

**加权综合完成度 ≈ 95%**（已宣称功能面口径）。

## 五、发现清单（P1/P2 详列，P3 归并）

### P1×1

- **G-P1-1 CI 主矩阵「测试」步持续红于四族环境面，合入门测试信号当前失效**〔= 台账 §三 G「2026-09-11 新登记」行重证，非新发现；本轮新增代码级独立证据〕。证据：① `test/studio/r71-books-rename-case.test.ts:93` 按大小写不敏感 FS 假设读旧路径（产品在敏感 FS 上正确真改名——测试侧平台假设分叉）；② TTL 族真墙钟实睡 8 处（`r47-ttl-evict-on-expiry.test.ts:104,125`、`r75-state-tree-issues-ttl.test.ts:175,198,208`、`d3-style-ttl.test.ts:132`、`r47-analysis-style-release.test.ts:109`——仓内 `r47-rebuild-probe-ttl.test.ts:74` 已有 fake timers 正确先例）；③ kk-P2-8 ubuntu 平台差异；④ win 腿 tinypool teardown 竞态杀进程于汇总前（连带 win 单测数对账从未完整跑绿）。失败场景：PR/push 六腿红，开发者无法区分「回归红」与「已知红」，门 fail-closed 但持续假红时判别力归零。修复方向：测试平台适配批（台账既立）——R71-8 按平台分支断言、TTL 族改注入时钟、kk-P2-8/win 竞态按台账处置。

### P2×2（均为新发现）

- **A-P2-1 mac 打包态系统字体枚举主路径必失效——font-list 原生二进制不随包分发**（疑似-中，主审三面亲验成立：electron-builder.yml `files: [dist/**, resources/**, package.json]` 无 node_modules/extraResources；tsup 仅 external electron，font-list JS 被 bundle 后 `__dirname` 指向 dist/desktop；`node_modules/font-list/libs/darwin/index.js:16` `path.join(__dirname,'fontlist')` 二进制无处可寻，scripts/ 无拷贝步骤）。失败场景：DMG 安装后字体下拉 → execFile 恒 ENOENT（错误仅 console.error 打包态不可见）→ 回落 system_profiler 慢路径 → 慢机/大字体库触 10s 超时 → 连败 2 次熔断 → 字体下拉返空直到重启。与台账 PM-12/R48-17 同族但定性加深（不止 kill 缺接线，主路径本身失效）；win 不受影响（自绘 PowerShell）。修复方向：构建期拷贝 fontlist 二进制入包或接通 PM-12 自管 spawn；**需打包态实测复验后定终级**。
- **G-P2-2 coverage 阈值「桶外文件」方向无守卫，web-next 新增子目录可静默逃出全部门禁**（`test/governance/coverage-threshold-globs.test.ts:98-115` 只断言空桶 + 配置双向锁；vitest glob 语义 = 不匹配任何键的文件不做阈值检查）。失败场景：前端新增 `utils/` 等纯 TS 目录 → 进报告但零守护——stores/composables/api/editor 历次「收暗区」同型，这次无机器门阻止重开。修复方向：governance 补反向断言（include∩¬exclude 全集逐文件至少命中一桶，不命中点名报红）。

### P3×26（每条一行；〔备案〕= 代码注释/台账已登记项的重证）

| ID | 标题 | 位置 |
|---|---|---|
| A-P3-1 | bootstrap 头注「await 先于任何 IPC 注册」与实际注册顺序相反（注释失实，当前无行为缺陷） | `src/desktop/main.ts:1179` vs `:1970` |
| A-P3-2 | server-manager 未监听 utilityProcess 'error'(FatalError)，V8 级崩溃诊断丢失 | `src/desktop/server-manager.ts:355` |
| A-P3-3 | close/quit 链确认框仍用 showMessageBoxSync（同步泵消息循环冻结三窗）〔备案：R1010-P3 G7-② 同族〕 | `src/desktop/main.ts:1077,1096` |
| A-P3-4 | mac/linux font-list 超时不杀子进程（孤儿进程累积）〔备案 = 台账 PM-12〕 | `src/desktop/font-cache.ts:255` |
| B-P3-1 | forgetBookKeyedCaches 内 forgetForeshadowSaveChain 双重调用（幂等零影响，注释误导） | `src/studio/server/api/books.ts:125,132` |
| B-P3-2 | 误报语料查询侧未接线（只写不读，存储积压）〔备案：check.ts 注释自认有意留白〕 | `src/studio/server/api/check.ts:99` |
| B-P3-3 | learn-commit 同步批量落盘无让出（上限 800×双 fsync，慢盘可秒级）〔疑似；上限即备案缓解〕 | `src/studio/server/api/knowledge.ts:133` |
| B-P3-4 | 非闸书级写端点（knowledge/style/config）缺 bookMoved 临界段复查（竞态窗写落旧 bookRoot 可复活幽灵目录，clutter 级）〔台账 B 域 config.ts 同型行扩面〕 | `src/studio/server/api/knowledge.ts:117` 等 |
| C1-P3-1 | workbench.textOut 无前端内存封顶，防线单侧依赖服务端锚契约 | `src/studio/web-next/src/stores/workbench.ts:88` |
| C1-P3-2 | useShelf.createBook 裸调 apiJson 未收进 api/books.ts（归置不一致） | `src/studio/web-next/src/composables/useShelf.ts:232` |
| C1-P3-3 | 书级 prefs 500ms 防抖关窗无冲刷钩子（末次布局态丢失）〔备案：R48-82 声明取舍〕 | `src/studio/web-next/src/stores/workspace.ts` |
| C2-P3-1 | FontPicker 实例 id 计数器写在 setup 内恒为 1（双开时 DOM 重复 id + aria 互串，仅 win 自绘路径） | `src/studio/web-next/src/components/ui/FontPicker.vue:44` |
| C2-P3-2 | TooltipHost 延迟窗内目标被移除时 tooltip 落视口左上角 | `src/studio/web-next/src/components/ui/TooltipHost.vue:45` |
| C2-P3-3 | ConfirmPrompt 的 Esc 缺 IME 组合期让渡（全库惯例唯一缺口） | `src/studio/web-next/src/components/ui/ConfirmPrompt.vue:14` |
| D-P3-1 | RAG buildIndex 增量路径对损坏库无自愈（同文件 reset/state 均有），裸抛英文 SQLite 错 | `src/rag/index.ts:364` |
| E-P3-1 | mac 上事件库 bookHash 不折叠大小写（books.jsonl 路径漂移分裂事件库「丢史」假象）〔备案：store.ts R40-23 登记〕 | `src/events/store.ts:37` |
| E-P3-2 | scanSummaries 裸 readdirSync TOCTOU 漏配（同域守卫家族漏点，fail-loud 误报一次） | `src/cache/rebuild.ts:530,538` |
| E-P3-3 | 分析信封迁源删字面旧文件未走 rmWithRetry（win 杀软瞬时锁下滞留） | `src/document/analysis.ts:223` |
| E-P3-4 | writePieceList 生产零接线，章纲未知段无保形写通道〔备案：R48-51〕 | `src/format/manifest.ts:45` |
| E-P3-5 | matchFenceLine 缩进判定 `\s{0,3}` 误纳 tab（tab 缩进 ``` 行误判围栏，触发面极窄） | `src/format/fence.ts:30` |
| G-P3-1 | win 腿单测数对账逻辑（parseWinPlatformDelta/反推分支）零直测、基线零实跑背书 | `scripts/check-counts.mjs:350,478` |
| G-P3-2 | desktop.yml tag 发布门门集与 ci.yml 不对称（缺 soak 门与窗口循环冒烟；win 腿吃 teardown 竞态假红拦发布） | `.github/workflows/desktop.yml:126` |
| G-P3-3 | e2e 顺序守卫镜像假设无运行期验证（localeCompare 镜像 Playwright 内部序）；spec 间恢复失败静默吞 | `test/e2e/spec-order.guard.test.ts:38` |
| G-P3-4 | soak 内存门覆盖面窄（仅 piece-list 一条路径；rag/召回无内存断言） | `test/soak/soak.ts:22` |
| G-P3-5 | CI 效率与 warning 通道小缺口（playwright 浏览器无缓存动作；lint 无 --max-warnings 0） | `ci.yml:170`、`package.json:35` |
| G-P3-6 | ci.yml Electron 系统依赖装 7 包只核对 3（libgbm/libasound 装失败静默 → 伪装成冒烟超时） | `ci.yml:191` |

## 六、完成进度评估

1. **路线对照（总览第三节）**：当前唯一开放任务 = 阶段 24「章节结构操作」（留洞制 fm `序`/`并入`，S2-S5）——**已拍板 + 执行方案落盘（2026-09-04），实施待作者指令**；本轮代码核验 `structure.merge` 端点与 fm `序` 键解析全库零命中，确未开工。此前的阶段 1–23 全部收口（含 win 适配阶段 21 全收口、字体系统 F0 系办结、Responses 适配 2026-09-04 收口）。
2. **宣称面核验（根 README）**：完整写作流程（建书/设定/正文+全自动写章/三审/定稿防吃书/导出）、配套（伏笔全程记录/字数曲线/文风系统/选段改写分析/对话助手）、平台（win NSIS + mac dmg 双包，rc.1 已出）、安全模型（Host 校验/Origin 白名单/令牌闸）逐条有实装——八域代理完成度核验 + 主审抽查均未发现宣称与实现脱节（唯 A-P2-1 使 mac 打包态「字体下拉」这一设置面子项存在降级风险）。
3. **台账开放项构成**：约 60 条——【待拍板】≈10（switch-provider 消费、事件读链 O(N) 立项、MAX_AGENT_TURNS、CI dev 腿恢复、win 实测面等）、【单立】≈15（测试平台适配批、章节结构操作等）、【维持】≈30（权衡备案，非缺功能）、【有意】少量。性质上多为「已知取舍」而非「未完成功能」。
4. **完成度数字**：分域 92–98%（见 §四表），加权 ≈95%。若把阶段 24（一个中等规模已拍板特性）计入规划总量，整体规划进度 ≈ 90–93%——即「除待开工的阶段 24 外，产品面已完成且经八域精读未见 stub/半成品」。

## 七、完成质量评估

**评级：产品代码 A- / 工程信号面 B+，综合 A-。**

亮点（八域交叉印证）：
1. **数据安全与并发基建成熟度罕见**：原子写 tmp+双 fsync+rename+目录 fsync、跨进程 O_EXCL 锁五层竞态处理、事件账本 append-only + 崩溃续跑迁移、保存链 journal/快照/覆写留底、bookMoved 临界段复查族——E 域 20.9k 行零 P1/P2。
2. **竞态与生命周期纪律系统性**（非点状补丁）：前端代际守卫族 + 入口捕获复检 + inflight 身份删除；桌面壳三链互斥 + flush 预算 + 崩溃退避三档；服务端 SSE 背压判死 + 互斥矩阵 + 有界停机 drain。
3. **AI 链路两硬性守则体系化落实**：「模型可见⟺已记录」以 lineage 三 digest + 指纹登记 + 治理测试闭环；「默认值显式 resolve」全参数快照落 llm/call 事件，重放可精确重建。
4. **测试工程质量高**：6725 单测断言普遍锚定语义（语料 golden-master 双向断言、scale 语义锚、错误分支逐路径），假绿面被 .only/空洞/注入-403 三道静态门主动封堵；e2e 顺序契约三层守卫 + retries:0 正确取舍。
5. **安全面超出必要强度**：Host/Origin/token 三闸 + SSE 一次性 ticket + 静态托管三重穿越防御 + IPC isTrustedSender 三层校验 + 日志 redact；本轮零安全漏洞发现，UI 层零 v-html。

弱点（拉低项）：
1. **CI 主门信号失效中**（G-P1-1）——门的精密程度与信号可用程度失衡，修复批落地前「红=可信回归」不成立。
2. **mac 打包态真机验证面依赖挂账而非构建期保证**（A-P2-1 + win 闪窗复验挂账）。
3. **注释密度过载**（多域独立提出，部分文件注释行超代码；存在注释失实实例 A-P3-1）与巨型文件（main.ts 2211 行、service.ts 1959 行、store.ts 1345 行）。
4. **同型守卫/模式收编不彻底**：缓存族复制 15 处、切书守卫模板复制十余处、rmSync/readdirSync 同族漏网——靠评审轮次扫尾而非结构化约束。
5. **测试套件可信度边界**：本地全绿对 macOS 业务面回归 ≈85–90% 高可信；但不能外推为 CI 绿（四族环境红），也不覆盖 Electron GUI 交互（零 _electron e2e）与真实 AI 上游（mock driver + 手动 verify:responses）。

## 八、处置建议（供拍板，本报告不代决）

1. **G-P1-1**：台账既立「测试平台适配批」建议尽快落地恢复 CI 全绿基线（本报告新增 TTL 族 fake-timers 清单可作批内清单）。
2. **A-P2-1**：建议先做一次打包态实测复验（build:desktop 后装 DMG 验字体下拉），确证后并入 PM-12 拍板或单立「打包资源批」（构建期拷贝 fontlist 二进制）。
3. **G-P2-2**：单立小批（governance 测试补反向断言，改动面一个测试文件）。
4. P3 族：新发现约 19 条多为边角（极端时序/双开场景/卫生项），建议择机随相关域批次收；〔备案〕7 条维持原登记处置。
5. 本评审按规则**未收口**：P1×1 + P2×2 修复 + 回归通过后收口，届时新发现项按台账 §五 约定登记 §三 对应域行。

## 九、评审过程记档

- 波 1（4 代理）：A 桌面壳+进程管线 / B 服务端 / C2 前端组件层 / D AI+RAG（D 撞使用限额失败）。
- 波 2（4 代理）：D 重派（成功）/ C1 前端逻辑层 / E 核心持久化 / G 测试 CI 工具链。
- 主审：质量门九件套亲跑（§三）+ E2 支撑子系统抽审 + 根级配置面 + A-P2-1/G-P2-2 亲验 + 阶段 24 代码核验 + 本报告总撰。
- 各域代理完整报告（含逐条代码短引与失败场景推演）已并入本报告 §四/§五 浓缩呈现；发现 ID 沿用各域代理编号（A/B/C1/C2/D/E/G 前缀）。

## 十、收口记（2026-09-11 修复批）

作者指令「全部修复，编排任务做。」——P1×1 + P2×2 必修全修；P3×26 随批收 22 / 维持登记 4；零提交（工作树留作者）。编排骨架 = 主审亲修 A 域 + 工具链组；波 1 四路文件互斥并发代理（SRV / FE1 / FE2 / CORE）；波 2 四路（G-P1-1 四族每族一路）。主审逐 diff 复核全量，L2 终门亲跑。

**G-P1-1（四族全处置，六腿 CI 复验待下轮 dispatch）**：① R71-8 改运行时 FS 大小写探测分支断言（`probeFsCaseInsensitive`——敏感卷断真改名/不敏感卷维持原位断言，代理另挂 64M Case-sensitive APFS 卷实测敏感分支绿）；② kk-P2-8 定性收束 = 测试侧平台假设（`M.msgBox` 文件级累积面在敏感卷上被前序切库警告各 +1 污染，与 CI「expected 1 got 3」精确对账；本地 mock 敏感卷复现字节级同形）→ 改快照增量口径（对齐本文件 1338/1385 行既有先例）；③ TTL 族 7 处真睡眠（6×1.5s + r43 判定面）改 `toFake:['Date']` 注入时钟 + `advanceTimersByTime(TTL+1)`，相关面测试耗时 -93%（11.2s→0.74s），断言与产品零改动；④ win tinypool teardown 竞态三方源码定性（vitest forks 池每文件销毁 worker × tinypool `_removeWorker` promise 无 catch × vitest 主进程 unhandledRejection 即 exit(1)，收尾杀于汇总前）→ ci.yml win 腿专用步「首跑非零同命令重跑一次」兜底（真失败不吞；测试残留子进程假设经 50 文件扫描证伪；上游升级评估 + tinypool patch 备选登记台账 §三 G）。

**A-P2-1 + A-P3-4 + PM-12（同链收口）**：tsup 构建期拷贝 fontlist 二进制入 `dist/desktop`（mac；cmp 字节级一致 + 执行位 + 真机跑通字体清单实测）→ electron-builder `asarUnpack: [desktop/fontlist]` → `main.ts` 经 `darwinFontListCommand` 注入（app.asar→app.asar.unpacked 同位改写；execFile 才可执行 asar 内路径的 Electron 语义已核）→ font-list 自身 system_profiler 回落链保持 → check-packaging 补静态（asarUnpack 覆盖门）+ dist（二进制在位 + 执行位门）→ 3 直测（含 `app.asar.bak` 前缀不误改写）。PM-12 生产 kill 接线随之落地（原「打包态路径不可解」的拍板理由失效，作者「全部修复」口径下并链办结）。残留 = DMG 打包态实测复验（台账 §三 A 单立）。

**G-P2-2**：coverage exclude 两侧补 `**/node_modules/**`（vitest.config + governance EXCLUDE 副本）+ 反向守卫（include∩¬exclude 逐文件至少命中一个阈值桶，桶外点名报红）——落地即抓到现网 27 个桶外文件（web-next node_modules 内第三方 .ts 被 include 误吞），真源文件经修后全覆盖。

**G-P3-4（修复过程中的真发现，超出原 P3「soak 覆盖面窄」范围）**：为补 RAG 召回受守路径扩展 soak 时暴露**真线性堆泄漏**（6 万次召回 +52MB，强制 GC 不回落）。六轮裸 .mjs bisect 定根因：node:sqlite 的 StatementSync 强引用其 DatabaseSync，与 R46-45/R46-42 的 `preparedByDb` WeakMap 弱键构成 ephemeron 环——close 后缓存条目**不随 GC 回收**（~0.35KB/次开/关；语句是否执行过无关，入缓存即滞留；WAL / busy_timeout / table_info / 部分索引 / 数据行逐一排除）。RAG 每次召回开库两回 = 重灾区。修复 = `closeRagDb` / `closeEventsDb`（close 前显式 `WeakMap.delete` 断链；RAG index.ts 5 处 + 状态端点 + events 3 处全改道）；验证 = 结构契约测试 ×2 文件（CI 常跑）+ gc 门控功能实测（8000 次开/关增长 <1.5MB，修复前 ~2.7MB）+ soak 2 万次召回增长 0.05MB。events 侧 R46-42 头注「连接 close 后缓存条目随 GC 消失」失实句随批修账。

**G-P3-3**：spec-order 运行期 reporter 落地并修正两处实现缺陷（onBegin 单参声明把 config 收成 suite；onEnd 用 throw——playwright 对 reporter 异常只记日志不改退出码，`process.exitCode`/`onExit` 改码两路亦被终态覆写，探针逐一证伪）→ 定稿 `onBegin(config, suite)` 双参 + `onEnd` 返回 `{ status: 'failed' }` 官方门机制（Multiplexer 回写 run 状态 → 退出码 1），签名口径与门行为均钉进 guard 直测。e2e 复跑 0 reporter 错误、收集序与快照一致。

**随批全收**（明细见各源文件 R0911- 锚注释 + Archive/README 修复批批记行）：A-P3-1（main.ts:1179 注释修账）/ A-P3-2（utilityProcess 'error' 三参监听 + 快速失败 FORK_ERROR + 持久诊断监听 + 2 测试）/ B-P3-1（重复调用合一）/ B-P3-3（learn-commit 每 100 条让出，可注入）/ B-P3-4（knowledge/style 四端点/config 写前 + 让出点书注册重验 → 409 BOOK_MOVED，8 用例）/ C1-P3-1（textOut 封顶 1M 锚 SSE_BACKPRESSURE_LIMIT，保最新段）/ C1-P3-2（createBook 归置 api 层）/ C1-P3-3（书级 prefs 关窗冲刷钩子 + 写链外提）/ C2-P3-1（FontPicker 模块级 uid）/ C2-P3-2（TooltipHost isConnected 守卫）/ C2-P3-3（ConfirmPrompt IME 组合让渡，shared/ime.ts 单源）/ D-P3-1（buildIndex 损坏自愈删库重建）/ E-P3-2（scanSummaries TOCTOU 守卫）/ E-P3-3（rmWithRetry 接线）/ E-P3-5（围栏缩进 ` {0,3}`）/ G-P3-1（win 对账直测 7 用例）/ G-P3-2（desktop.yml 补 soak 门 + mac/win 窗口循环冒烟 + electron-smoke CLW_SMOKE_APP_BIN 通道）/ G-P3-5（playwright 缓存 + lint --max-warnings 0）/ G-P3-6（libgbm/libasound 装后核对 ::error）。

**维持登记 4 项**（台账 §三 对应域行随批登记）：A-P3-3（close/quit 同步确认框，R1010-P3 G7-② 同族备案）/ B-P3-2（误报语料查询侧，check.ts 有意留白）/ E-P3-1（mac bookHash 大小写，R40-23）/ E-P3-4（writePieceList 零接线，R48-51）；另 FE1 残留 = beforeunload 刷新路径书级 prefs 不冲刷（关窗主路径已接，刷新频率低取舍维持）。

**L2 终门九件套（收口态 2026-09-11 主审亲跑）**：vitest 1049 文件 = 6795 过 + 5 跳 0 败〔157.49s〕；tsc 0 错；vue-tsc 0 错；eslint 0/0（--max-warnings 0 新门）；三 check 过（counts 1049/6795 + 29 spec/45 用例对账一致；packaging 含 fontlist 新双门；knowledge 13 条一致）；build:web 过；e2e 43 过 2 跳〔27.5s，reporter 零报错〕；soak 两段绿（有界往返 10 万次 -0.02MB / RAG 召回 2 万次 +0.05MB，全程 15s）。根 README 计数四处修账 1037/6725 → 1049/6795（win 差值 75 恒定 → 预期 win 6720 过 + 80 跳，待 CI 实跑确认）+ CI 口径句回填四族处置结果。新增测试面 +12 文件 / +70 用例 / +1 平台无关跳（gc 门控）。

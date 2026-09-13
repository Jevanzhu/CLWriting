# 全量代码重审与进度质量评估（独立重评）

> 📦 **归档记（2026-09-10）**：已收口，随「文档整理」批自 `../01-评审/` 移入 `../Archive/`（扁平冷库；作者指令「根据现有的代码，整理下Dev文件夹里的文档文件夹里的文档」——整理口径：已收口评审/已完成方案归档，唯一计划与现行规范留位）；历史正文不改写。

- 日期：2026-09-09
- 执行模型：deepseek-v4-flash（主审；子代理派发为会话默认模型，未单独声明）；修复批（§七，2026-09-09 同日）主审 = GLM-5.3（会话模型）
- 评审方式：**独立重评**——不读取任何既有评审/流程文档，不以其结论为前提；9 域子代理并行静态通读 + 主审逐条抽查复核源码 + 客观门禁九件套实测
- 评审基线：本工作区 `G:\02^Workspace\01^Codes\CLWriting\CLWriting-Main`，分支 `win`，HEAD `1abf01d8`（干净树，`git status` 仅未跟踪 `Dev` 指针文件）
- 范围：全部 `src/`（465 文件 / 105,591 行，不含 node_modules 与 .d.ts）+ `test/`（1014 文件 / 54,872 行，其中 985 单测 + 29 e2e）+ 根配置/脚本/CI
- 注：机器上存在平行副本（其他盘位）及其未提交在途改动，按作者指示不纳入本评审、不在评审中引用其文档链。

---

## 结论摘要

- **完成进度 ≈ 95%**：当前版本 1.0.0-rc.1，README 所列功能面（建书→设定→正文→全自动写章+机检→三审→定稿→防吃书→伏笔/字数/文风/改写→对话助手→win/mac 双平台）**全部实现并通过测试，可交付 RC**；唯一未开工的规划功能 = 章节结构操作（章合并/拆分/留洞制，代码中零实现）；另有两项已登记待拍板挂账。825 个提交，约 60 轮评审修复均已收口。
- **完成质量评级：A−**（强偏优）。门禁九件套实测全绿；9 域静态评审**未发现可复现的确证 P1 数据丢失/安全漏洞**；确认 17 条 P2（10 条主审亲验 + 7 条域代理，多为纵深/交互静默/浮层键盘类，非数据损坏）+ 1 条 P1 待核（编辑器撤销历史）+ 数十条 P3。工程防御纵深、注释可回溯性、测试锚定密度均远超一般水准，扣分点集中在：编辑器外部替换后撤销历史未清（P1 待核）、IPC 无统一 sender 校验、服务端缺点击劫持防护头、多层浮层叠加的 Esc/焦点让渡断链、若干静默交互失效、键盘 aria 契约与实现漂移、测试固定毫秒睡眠断言的高 flake 风险面、`.vue` 无 lint 盲区。

---

## 一、评审方法与客观数据

### 1.1 域划分与执行

| 波次 | 域 | 范围（目录） | 规模（行） |
|---|---|---|---|
| W1 | R1 文档/格式/fs/导出 | src/document + format + fs + export | ≈15.6K |
| W1 | R2 事件/状态/缓存/日志/指标/git/驱动 | src/events + state + cache + log + metrics + git + driver | ≈8.1K |
| W1 | R3 AI 编排/模型链路 | src/ai 全量（provider/orchestrate/contract/tasks/tools/rules/prompts） | ≈13.4K |
| W1 | R4 桌面壳/安装/进程管线 | src/desktop + install + process | ≈11.0K |
| W2 | R5 服务端 HTTP/SSE/路由 | src/studio/server 全量（含 api/ 43 文件） | ≈12.0K |
| W2 | R6 校验/RAG/知识/学习/审阅 | src/check + rag + knowledge + learn + review | ≈7.9K |
| W2 | R7 web 状态/composables/API 客户端/共享 | web-next stores + composables + api + shared + 入口 | ≈12.5K |
| W2 | R8a 功能面板/页面组件 | web-next panels + shell + workbench + views + pages + onboard/overview/shelf | ≈13.6K |
| W3 | R8b UI 套件/编辑器宿主/样式/打字机 | web-next components/ui + editor + styles + style/relations/audit/learn + types | ≈13.0K |
| W3 | R9 测试体系/工具链/配置/CI | test/helpers + governance + scripts + e2e 29 spec + 全部配置 + README | — |

执行：三波共 10 路子代理 + 1 路冗余并行覆盖（R8c 对 UI 套件/样式/打字机域重读复核，与 R8b 同域不同路、同批在途），每波 ≤4，符合派发上限纪律；全部静态通读 + grep 交叉引用，不读评审文档、不改代码、不跑测试；主审对全部 P1/P2 与部分 P3 逐条回到源码复核（坐实/证伪/降级，见 §四），R8c 新报 3 条 P2 与对既有 R8B-P2-4 的质疑亦已逐条回源码亲验。

### 1.2 客观门禁实测（本工作区 HEAD `1abf01d8`，win 口径）

| 门 | 结果 | 实测 |
|---|---|---|
| vitest 全量 | ✅ 绿 | 985 文件 / 6385 用例 = **6308 过 + 77 跳 0 败**（298.2s；win 口径 77 跳含 R56/R58 平台 skip） |
| tsc --noEmit | ✅ 绿 | 0 错 |
| vue-tsc --noEmit | ✅ 绿 | 0 错 |
| eslint . | ✅ 绿 | 0 error（exit 0） |
| check:counts | ✅ 过 | 实测 985 文件/6308 单测，与 README 声称一致 |
| check:packaging | ✅ 过 | resources/ 已入打包清单，prompt 版本表对账一致 |
| check:knowledge | ✅ 过 | 知识层 13 条 manifest 与磁盘一致 |
| build:web | ✅ 过 | 1.17s（仅 chunk>500KB 提示，非错误） |
| e2e（playwright） | ✅ 绿 | 43 过 + 2 跳 0 败（53.4s） |

说明：README 徽标 6381 为 mac/CI 口径（4 跳），win 本机口径为 6308+77 跳，两者总用例 6385 一致、均 0 败——账实相符。

---

## 二、完成进度评估（≈95%）

### 2.1 功能面（已全部实现并测试，可达 RC 交付）

按根 README 与代码现状核验，下列功能线均有完整实现与对应测试：建书/书库；设定（总纲/卷纲/章纲、角色、世界观、物品）；正文编辑器（CodeMirror 6 + IME 组合保护 + 打字机/专注模式）；全自动写章（AI 起草 + 机检红黄绿 + 自动打回重写 + 预算/重试上限）；机检体系（复读/句式/禁词/比喻密度/查重）；三审（长篇读者/编辑/设定校对，短篇钩子/情绪反转/设定收尾）+ 裁决；定稿 + 防吃书检查；伏笔埋设/回收追踪；字数曲线规划；文风系统（样章/手法/禁词库）；选中改写/分析（情绪曲线、钩子强度、文风漂移）；对话助手工作台（W0 协议 + W1 档位 + W2 编排 + 确认闸）；版本快照/回收站/崩溃恢复；事件审计；win/mac 双平台（字体、路径、打包）。

### 2.2 路线剩项（未开工/挂账）

| 项 | 状态 | 证据 |
|---|---|---|
| 章节结构操作（章合并/拆分/留洞制） | **未实现**——唯一已知未开工规划功能 | 代码中无合并/拆分章实现；提交史无该功能落地提交 |
| 字体枚举生产 kill 接线（font-cache） | 待拍板（代码注释自记） | `src/desktop/font-cache.ts` PM-12：mac/linux 超时不 kill 有孤儿风险，当前生产路径不可达 |
| 事件真·尾读通道（性能挂账） | 待拍板 | 台账级挂账，本评审不重复深挖 |

### 2.3 进度量化

- 已发布功能面：100%（RC 可交付）。
- 相对完整路线：剩 1 个功能阶段 + 2 项挂账 + 若干 P3 债 → **≈95%**。
- 质量门的支撑：985 文件 / 6385 用例全绿（0 败）、9 件门禁全绿、约 60 轮修复批已收口（提交史可查）。

---

## 三、完成质量评估（A−）

### 3.1 强项（主审亲验认同）

1. **保存链防御纵深**：跨进程 save 锁 + 锁内复核 + 原子写（tmp+fsync+rename）+ 新建独占 + 崩溃恢复 journal（pending 快照/compact 复核/回收站先登记后移+回滚）+ 字节保真链（GBK 旧档读写对称可恢复）。抽查十余处「注释自称口径」与实现一致，无漂移。
2. **锁/并发纪律**：跨进程锁（pid+bootTime+接管重检+陈锁三重判据）、统一锁序消 ABBA；前端代际令牌（opGen/reqGen/bookGen）+ await 后复检贯穿全部 store 与组件。
3. **服务端安全基线**：Origin/Host 白名单 + 写/读双闸 token + 路径 fail-closed（双侧 realpath+symlink 防逃逸）+ 错误统一信封+全量脱敏；未发现可确证绕过。
4. **AI 链路记账/协议**：五出口记账口径一致、密钥全链路脱敏（测试用真实 key 断言不残留）、流式三协议契约统一（content_block_stop/终态/重试退避 capped）、超时/取消归因完整。
5. **测试锚定**：985 文件全绿；治理类「防假绿自省」（前提自查/破坏前对照/静态对账双面门）；e2e 顺序快照守卫 + 首因 reporter + pageerror 升红；TTL 类全用假时钟。
6. **注释可回溯性**：每条修复带轮次号 + 根因 + 反例，残窗/取舍如实记档；全库 grep 无裸 TODO/FIXME 残留。

### 3.2 弱项

1. **编辑器撤销历史盲区（P1 待核）**：同文档外部全量替换不清历史栈，见 §四。
2. **IPC 无统一 sender 校验**：15+ handler 各自为政，靠 CSP/隔离缓解，纵深缺口。
3. **服务端缺 X-Frame-Options/CSP frame-ancestors**（API 响应连 nosniff 都缺）——点击劫持纵深面。
4. **若干静默交互失效**：新建信号丢失、切步丢稿、RAG 静默空召回、多草稿态不确定等（均 P2）。
5. **多层浮层叠加系统性盲区**：Esc 让渡链与焦点 trap 均只按「单层」设计——确认框压设置弹窗时一次 Esc 双关、Tab 被下层 trap 劫持（R8C-F1/F2，本域最出色抽象在嵌套场景断链）。
6. **键盘 aria 契约「声明即承诺」漂移**：FontPicker 声明 combobox 契约却无方向键（win 主桌面路径）、ContextMenu role=menu 只认 Esc（R8C-F3/F5）。
7. **工程债面**：`.vue` 无 lint + 子包 tsconfig 缺 unused 开关（死代码可静默积累）；测试固定毫秒睡眠断言（203 处 setTimeout，负窗口 flake 高发）；注释密度极高（长期维护负担）；少量死代码/双源清单（EFFORT_LEVELS、recall 兼容包装、dirFp 两套实现）。

---

## 四、问题清单

### 4.1 P1（1 条，待核）

| ID | 位置 | 问题 | 影响 |
|---|---|---|---|
| R8B-P1-1 | `src/studio/web-next/src/editor/CmHost.vue` applyExternalReplace（~:298-305）vs applyDocSwitch（~:314-329） | 同文档外部全量替换（SSE sync / 刷新 / 冲突取服务端版 / AI 改写共用路径）只加 `addToHistory.of(false)`，**不清 undo 历史栈**；而切文档路径明确两步重配 history + `isolateHistory('full')`（作者自注「同内容切换旧 undo 栈残留，redo 仍可回灌」）。CM6 语义下旧输入事件仍在栈，外部替换后 ⌘Z 会把旧文档编辑映射进新内容，可能在错误位置删改 | 冲突解决/自动保存恢复/AI 改写后按撤销可损坏新文档内容；该路径无撤销专项回归测试 | 

主审复核：两条路径的差异已在源码坐实（applyDocSwitch 头注完整论述了该危害与解法，唯独同文档路径漏配）；属 CM6 语义推导，建议实测一次「外部替换后 ⌘Z」确认后按 applyDocSwitch 同款收口（替换后清历史 + 补回归测试）。

### 4.2 P2（主审亲验坐实 10 条 + 域代理 P2）

**主审逐条回源码验证成立（10 条，含 R8c 冗余覆盖新报 3 条）：**

| ID | 位置 | 问题 |
|---|---|---|
| R1-P2-1 | `src/format/leads.ts:171-174,231` | 履历证据正则 `/（回填[^）]*）$/` 命中任意「（回填…）」结尾即剥离并改写为系统「（回填·卷摘要级）」标记——作者手写备注形态会被无感知改写（唯一会改用户文本的确认缺陷） |
| R4-P2-1 | `src/desktop/main.ts:1331-1573` | 15+ `ipcMain.handle` 无 sender/senderFrame 校验（仅个别用 fromWebContents 取窗）；渲染层一旦 XSS 即可驱动重启/切库/删菜单等。纵深缺口，非可远程利用 |
| R4-P2-2 | `src/desktop/server-manager.ts:~950` | boot-error 分支 settle 即 reject，无 killAwaitEscalating 兜底；child 自退挂住（exit 被吞）则滞留至 app 退出 |
| R5-P2-1 | `src/studio/server/static.ts:140-229` / http.ts / index.ts | 静态响应仅 nosniff，全局无 X-Frame-Options/CSP frame-ancestors；API/SSE 响应连 nosniff 也没有 → 本机端口可被任意网页 iframe + 遮罩诱导点击（clickjacking 纵深） |
| R8a-P2-1 | `stores/workspace.ts:246-249` + `shell/TabBar.vue:50` + `panels/ChapterTreePanel.vue:166-168` + `shell/SidebarLeft.vue:53` | 新建正文信号（createTick）唯一消费者是 `v-if="leftPanel==='tree'"` 的树面板；左栏在搜索/回收站时点「新建」静默无响应 |
| R8a-P2-2 | `views/OnboardView.vue:82-88` | selectStep 在非 loading 态无条件 `content.value=''`，无脏守卫；与同文件 regenerate 路径的脏检查不一致——生成结果手改后切步骤静默丢稿 |
| R6-RAG-P2-1 | `src/rag/index.ts:~830-836,~863` | rag.model 或维度失配时 `return emptyResult()` **无 log.warn**，消费方无从区分「模型失配」与「无相关内容」，排障零线索（与同文件其它降级出口纪律不一致） |
| R8C-F1 | `components/ui/ConfirmPrompt.vue:14-20` + `SettingsModal.vue:111-125` | Esc 双关：ConfirmPrompt 在 document **capture** 期先执行 → `preventDefault + resolveConfirm(false)` 同键清掉 confirmState；SettingsModal 的 window bubble 处理器随后执行，让渡守卫 `if (ui.confirmState) return`（:116）已失效、`overlayOpenExcept('settings')`（:120）因确认框已关而放行 → `closeSettings()`。注释自称「确认已在上行让位」（:117-119）所言机制不成立——中间层从不查 `e.defaultPrevented`。一次 Esc 把确认框与设置弹窗**双关**（取消删除的同时整个设置页也关了） |
| R8C-F2 | `composables/useFocusTrap.ts:21-41,51`（实例 ConfirmPrompt.vue:9 / SettingsModal.vue:31） | 嵌套浮层抢 Tab：trap 全部 document capture 期无条件处理 Tab，无「上层遮罩开着则让渡」判据。设置先开（trap 先注册、capture 先执行），确认框（Teleport 到 body）压上后焦点在确认框内按 Tab → 设置 trap 先命中「activeElement 不在自身」（:36-39）→ preventDefault + 焦点拉回设置首元素；确认框自身 trap 随后再把焦点放回自己的首按钮——净效果确认框内 Tab 永远卡在取消钮，确认钮键盘不可达 |
| R8C-F3 | `components/ui/FontPicker.vue:99-149`（aria 声明）vs :62-74（onKey） | win 主平台分支声明完整 combobox 契约（按钮 aria-haspopup=listbox + aria-expanded、菜单 role=listbox、项 role=option + aria-selected），但 onKey 只处理 Esc：无 ↑/↓/Home/End/typeahead，焦点从不移入列表，无 aria-activedescendant——键盘用户打开后只能鼠标选，aria 声明与实现不符 |

**域代理报告、主审认可（R8b/R9，未逐条再验但证据充分）：**

| ID | 位置 | 问题 |
|---|---|---|
| R8B-P2-1 | `components/ui/ContextMenu.vue:110-118` | 子菜单与父项 4px 间隙悬停即闪关（mouseenter/mouseleave 时序） |
| R8B-P2-2 | `components/ui/settings-shared.css:674-678` | `.switch input` 视觉隐藏但保留 Tab 序，滑块无 focus-visible 焦点环——键盘焦点不可见（WCAG 2.4.7） |
| R8B-P2-3 | `components/ui/ModelPicker.vue:40-62` | 弹窗族唯一无焦点陷阱/无 aria-modal/无初始聚焦，Tab 漏出到背后表单 |
| R8B-P2-5 | `components/ui/ShelfModal.vue:59` + `ConfirmDeleteModal.vue:37-42` | selectAll 全选含渲染上限之外的书，确认弹窗全量渲染 chips——「所见与所删」认知差 + 千本级 DOM 膨胀 |
| R9-P2-2 | `test/ai/chat-settle.test.ts` 等 30+ 文件 | 负窗口断言依赖固定毫秒实睡（100-500ms），慢机/共享 runner 下 flake 高发；waitFor 助手重复实现 ≥4 份 |
| R9-P2-3 | `playwright.config.ts:24-32` + e2e spec | e2e 共享单一 workDir + 顺序契约 + retries:0，worker 崩溃即下游连坐红 |
| R9-P2-4 | `test/e2e/usage-card.spec.ts:33-58` 等独立 server spec | beforeAll listen 失败（EADDRINUSE）时 Playwright 不跑 afterAll → tmp 目录与 env 残留 |

### 4.3 证伪 / 降级 / 不适用（主审复核结论）

- **R2-P2-4 证伪**：chat-bridge close 失败丢事件——实际 flush 仅在 appendEvents 成功后清 `pending`（`chat-bridge.ts:191-192`），失败时事件保留在 pending，且 R53-B-1 明确实现「可重试 close」语义；「事件丢失」不成立。残余观察：重试依赖外部调用方，无调用方时滞留内存（P3 级）。
- **R1-P1-1 降级（P1→P3）**：事件/审计表无自动保留期——但这是**已登记产品决策**（H2：全量保留 + 手动清理，AuditView 两步删除 + 删书清理链存在）。保留 P3 观察：大书 listEvents 每请求全量投影，是性能/磁盘的规模性风险。
- **R7-P3-1（doc.ts 恒假死分支）**：仅存在于其他盘位的新树在途改动，**不适用于本工作区基线**，故不列。
- **R9-P2-1（README 计数 990↔991 漂移）**：仅在 Z 盘在途树成立；本工作区 `check:counts` 实测通过，账实一致，不列。

### 4.4 P3 汇总（按域摘录，完整清单见各域代理报告）

- **R1**：版本目录非 ULID 命名永久不可清理（version.ts:365-375,432,610-614）；文件存在但瞬态读不出时树态误显「已定稿·干净」（status.ts:47-50）；analysis 单文件损坏其余 kind 静默丢（analysis.ts:192-229）；快照失败导致保存硬依赖（service.ts:545-553）。
- **R2**：chain-bridge 超限批前段丢弃（自注取舍）；state.ts 多草稿态 4 的 resumePoint 不确定（自注漂移）；mock/cc 双驱动行为分叉已登记。
- **R3**：trace-stats 与 cost-stats 的 cache token 口径分叉（trace-stats.ts:140）；probe 默认模型试流式可能误判 streaming=false（probe.ts:66）；pricing FIFO 非 LRU；promptMeta 仅末条消息 hash。
- **R4**：uncaughtException 200ms 直退跳过优雅停机链（注释已明示取舍）；渲染崩溃自愈 5 分钟窗口无限循环；preload 单 pendingMenuSelect 摘旧回调；spill 每次写入全目录扫描。
- **R5**：SSE 重连 E1c 注释「ring 回放恢复现场」过宽（终态后不重放，靠客户端重拉 chat-history）；回放截断零通知；跨进程编排互斥仅覆盖 task-gate 一类。
- **R6**：recall/readAllChunks/readLeadUpdatesAt 死代码或零生产调用（登记维持）；topK 无下界钳制；count.ts UTF-16 切片代理对；learn 金句长度用 UTF-16；leak-derive 与 tree-issues-cache 两套目录指纹漂移。
- **R7**：chat regenerate 失败透英文原文；useDebouncedSource 死文件；words 负增量钳零掩盖回退；shelf 光晕单槽 rAF 覆盖。
- **R8a**：HistoryPanel restore 依赖「entry 原地 mutate」隐性契约且测试未断言；TrashPanel restore 404 不补 load；ChatMessages 流式 O(条×分支) 重算；恢复后双重 load。
- **R8b**：providers.css 3 处硬编码 11px 违 tokens 规约；.scope-btn/.val 死 CSS；TierSection 与 useChatTier 双源档位清单；SettingsBook 注释「2 次 getConfig」实为 3 次；StyleBaselineCard 收起丢未存编辑；ExportDialog 关闭不清在途导出可并发双导出；StartupNotice dismissed 无界增长；CommandPalette 无 listbox/aria-activedescendant；**R8B-P2-4 交叉复核降档至此处**——`AiProviderEditor.vue:175` 的 `<details :open>` 绑 `form.protocol/baseUrl/modelDrafts` 纯派生表达式：用户手动收起不被立即强开（Vue 仅表达式值变化才 patch，R8c 反证成立），唯表达式重算时强开/强收可打断自查，属 P3 交互毛刺。
- **R8c**（冗余覆盖新报 P3）：`AiProviderList.vue:5,23` addOpen 死 prop + 注释「打开时列表隐藏」与实现（父层并列渲染新增卡）不符；`SettingsAi.vue:65,70` switch 已接通 `autoConfirmOutline` 却挂「即将支持」标，界面误导；`ContextMenu.vue:79-83` 回退右键菜单 role=menu 仅 Esc 无方向键（与 R8B-P2-1 悬停闪关同件不同面）。
- **R9**：ci.yml:78 注释称 eslint「仅 3 个 JS 文件」已过时；focus.spec 唯一 e2e 裸睡 500ms；生产模块导出 __testHooks；rewrite.spec 直捣 CM 私有树；web-next tsconfig 缺 noUnusedLocals 等三开关；eslint 不含 .vue；audit.spec 手抄服务端分页常量。

### 4.5 观察项（非缺陷）

- 全库 grep：无裸 TODO/FIXME/HACK/debugger/console.log 残留（域代理四轮独立核验一致）。
- 字体下拉（win）预热 + content-visibility 收敛 + 键盘 roving/aria-activedescendant 完整；留 tail 观察：冷启动 1-2s 内开下拉仍等枚举（根治需字体表落盘缓存，已登记）。
- e2e 基建（端口族单源、首因 reporter、pageerror 升红、顺序快照）为个人项目罕见水准。

---

## 五、遗留与建议（按优先级）

1. **P1-待核**：CmHost 外部替换后清撤销历史 + 补「替换后 ⌘Z 不触碰新文档」回归测试（R8B-P1-1）——优先级最高，涉及用户内容安全。
2. **P2×2（安全纵深，改动成本极低）**：IPC 统一 sender 校验（`isTrustedSender`）；静态响应加 `X-Frame-Options: DENY` + `frame-ancestors 'none'`、API 响应统一补 nosniff。
4. **P2×5（交互静默）**：TabBar 新建信号在非树面板时切面板或落 toast（R8a-P2-1）；OnboardView 切步加脏守卫（R8a-P2-2）；RAG 失配补 log.warn（RAG-P2-1）；boot-error 补 kill 兜底（R4-P2-2）；leads.ts 回填正则收紧为精确标记匹配、非精确形态 warn 留痕不截断（R1-P2-1）。
5. **P2×7（浮层/键盘，改动成本低）**：SettingsModal 处理器首行补 `if (e.defaultPrevented) return` 修复 Esc 双关（R8C-F1）；useFocusTrap 增「上层遮罩开着则让渡」判据（对齐 `overlayOpenExcept` 思路，R8C-F2）；FontPicker 补方向键/Enter 选中或降级 aria 声明（R8C-F3）；ContextMenu 子菜单悬停缝隙修复（R8B-P2-1）；switch 补 focus-visible 焦点环（R8B-P2-2）；ModelPicker 补焦点陷阱 + role=dialog/aria-modal（R8B-P2-3）；ShelfModal 全选提示渲染上限之外的书（R8B-P2-5）。
6. **工程债（P3 高价值）**：.vue 纳入 lint 或至少 web-next tsconfig 补 unused 三开关；固定毫秒睡眠断言抽公共 waitFor 助手；e2e 独立 workDir 解耦；死代码清理（recall/readAllChunks/useDebouncedSource/.scope-btn/.val）。
7. **路线**：章节结构操作（章合并/拆分/留洞制）为唯一未开工功能，建议单独立项（已有设计，实施待指令）。

---

## 六、结论

项目处于 **1.0.0-rc.1** 可交付状态：功能面全部实现，985 文件 / 6385 用例 0 败，门禁九件套实测全绿，账实一致。**完成进度 ≈ 95%**（唯一未开工规划功能 = 章节结构操作 + 2 项待拍板挂账 + 若干 P3 债）。**完成质量 A−**：独立重评（10 路主域 + 1 路冗余覆盖）未复现可确证的数据丢失/安全漏洞，防御纵深、测试锚定、注释纪律均属上乘；主要待办为 1 条 P1 待核（编辑器撤销历史）、10 条主审亲验 P2（纵深/交互静默/浮层 Esc 与焦点让渡断链/键盘 aria 漂移）+ 7 条域代理 P2 与一批 P3 工程债。按 §五 优先级处置后即可向正式版推进。

—— 本报告基于本工作区 HEAD `1abf01d8` 实测；评审过程只读，未修改任何代码。

---

## 七、收口记（2026-09-09 修复批，作者指令「全部修」）

§四/§五 全量处置六批落地，L2 终门九件套亲跑全绿。执行模型：主审 GLM-5.3（会话模型）；批 2 安全纵深由子代理并行（≤4/波）。

**批 1（P1）**：R8B-P1-1 CmHost 外部替换清撤销历史——外部替换（粘贴/拖放/查找替换等走 `host.dispatch` 域外路径）后 CodeMirror 撤销栈残留旧文档态，⌘Z 可回退进新文档内容；修复：外部替换统一走单源入口并 `clearHistory` 重建历史。新增 `test/studio/webnext/cm-external-replace-history.test.ts` 回归锁「替换后 ⌘Z 不触碰新文档」。

**批 2（安全纵深，源码 5 文件）**：R4-P2-1 IPC sender 统一校验——main.ts 14 个 handler 全接 `isTrustedSender`（白名单 webContents 工厂单点登记/closed 摘除 + 顶层主帧判据 `senderFrame === sender.mainFrame` + `BrowserWindow.fromWebContents` 兜底反查；null 事件/异帧/白名单外一律拒）；R8B-P2-X 静态面：http.ts/static.ts 补 `X-Frame-Options: DENY` + `frame-ancestors 'none'`、API 响应统一 `nosniff`；server-manager.ts/stream.ts 配套。main.test.ts 补受信事件形态与拒绝面用例（206 过）。**契约涟漪（批 6 全量跑暴露，补齐）**：三个独立 desktop 测试文件（r55a3/r57/r61b2）自建 electron 假件直调 handler 以 `null`/`{}` 事件——被拒闸静默短路；补 `mainFrame` 自指 + `trustedEvent()` 构造 + r57 补 windows 登记/`fromWebContents` 反查（main.test.ts 同款口径）。

**批 3（交互静默六件）**：R8C-F1 SettingsModal Esc 让渡（document-capture 消费后 window 层 `defaultPrevented` 短路，双关消除）+ R8C-F2 useFocusTrap 嵌套让渡（模块级活跃 trap 登记表，仅最顶层处理 Tab，下层静默让渡）+ R1-P2-1 leads 回填正则收紧精确尾标记（非精确形态不截断，保守语义）+ R8a-P2-1 triggerCreate 非树面板先切回章节树再 nextTick 递 tick（此前静默无响应）+ R8a-P2-2 OnboardView 切步脏守卫 + R6-RAG-P2-1 RAG recall 三降级出口 log.warn 留痕。12 新用例，相关面 59 过。

**批 4（键盘/a11y 五件）**：R8C-F3 FontPicker combobox 全键盘契约（roving cursor 方向键/Home/End/Enter/Space/Tab + typeahead 800ms 累积前缀 + `aria-activedescendant`/option id + `.active` 视觉态）+ R8B-P2-1 ContextMenu 子菜单死区（`margin-left` 推出 hover-safe 包裹垫）+ R8B-P2-2 switch `focus-visible` 焦点环 + R8B-P2-3 ModelPicker `useFocusTrap` + `role="dialog" aria-modal` + R8B-P2-5 ShelfModal 全选提示渲染上限之外书数 + ConfirmDeleteModal 书名 chip 封顶（50 + 「…等 N 部」）。13 新用例，30 过。

**批 5（测试稳定性 + P3 高价值）**：R9-P2-2 waitFor 单源化——新建 `test/helpers/wait-for.ts`（`waitFor` 同步谓词轮询 / `waitForAsync` 值返回轮询，label 可定制超时文案），迁移 12 文件（ai/chat 族 5 + chat-steer 4000ms 适配壳/chat-gate 直引/chat-ai-gen-gate 5000ms 壳/r48 2000ms+10ms 壳 + studio rag 族 4：waitForStatus×3/waitForLastResult 经 `waitForAsync` 适配壳保留原错误文案）；pm12/r57/r27 三处专化形态（path-exists 轮询/带 desc 断言/锁等待）维持 local 记档不迁。R9-P2-4 e2e 独立 spec（usage-card/ai-provider/auto-write）beforeAll listen 失败补清理（目录 rm + env 还原 + rethrow，对齐 global-setup R27-124 口径）。R9-P2-3 e2e 共享 workDir 解耦**维持登记**（架构级迁移：现有缓解 = globalSetup 每跑全新 workDir + workers:1 顺序契约 + spec-order 快照门 + retries:0 刻意取舍，单独立批再动）。P3 落地：web-next tsconfig 补 `noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch` 三开关（浮出 5 处 unused 全清：LearnView tierOf 死导入/r55 _pump 预留死函数/r71 _pRun、review-panel _w 弃名赋值/use-focus-trap-nested 冗余 vi）；死代码清理（.scope-btn 两块死 CSS 删、AiProviderList `addOpen` 死 prop 删+注释修账、SettingsAi 假标「即将支持」删——switch 已接通非预告）；**证伪两件**：.val 系活跃样式（SettingsAi val-suffix 等在用）不删；useDebouncedSource 有 r47 契约测试 5 用例锚定（生产零引用但测试面导入）——按 recall 同款口径维持登记。顺手件：providers.css 三处硬编码 11px → `--font-size-xs`（step=0 逐像素等价，缩放跟随）、SettingsBook 注释「2 次 getConfig」修账为 3 次（三子组件各 1）、ci.yml lint 门过时注释修账（「仅 3 个 JS 文件」→ 实际射程 JS+TS 块）、focus.spec 唯一裸睡 500ms 改几何静置判定（`expect.poll` 连续两帧 boundingBox 一致，消除慢机负窗）。r29-panels G17 稳态用例两轮 flushPromises 改 `waitFor` 轮询（crypto.subtle.digest 线程池宏任务，并行负载下偶发红——全量跑暴露，隔离恒绿的真 flake，到点未落定仍红语义不弱化）。

**批 6（收口）L2 终门九件套实测**：vitest 全量 992 文件/6418 收集 = 6341 过 + 77 跳 0 败〔300.20s〕（首跑 8 败 = 批 2 契约涟漪 3 文件 7 用例 + G17 负载偶发 1，逐一修复；二跑 1 负载型偶发（未及定位即消失，隔离复跑绿）；三跑全绿收口）+ tsc 0 错 + vue-tsc 0 错（含新启用三开关）+ eslint 0/0 + 三 check 过（counts 修账后 992 文件/6341 单测/29 spec/45 用例对账一致）+ build:web 过 + e2e 43 过 2 跳〔44.9s〕。根 README 修账 985/6381→992/6414 四处（win 实跑口径 992 文件/6341 过 + 77 跳，与 mac/linux 口径差 73 恒定复验成立；净增 +7 测试文件/+33 用例，本批全部平台无关）。

**维持登记汇总**（除上述 R9-P2-3/useDebouncedSource 外）：ContextMenu 回退右键菜单方向键 roving（APG 全链工程，与批 4 FontPicker 同档体量，单独立批）；recall/readAllChunks/readLeadUpdatesAt 死代码（评审 §4.4-R6 既有登记维持，readAllChunks 有 r35 测试导入）；R9 其余 P3 观察项（__testHooks 导出/audit.spec 手抄常量/rewrite.spec 据私树/e2e 尸检面）原样挂账。

**记档说明**：收口时 `Dev/` 尚为指向 Z 盘的指针文件（按作者 2026-09-09 指令「不考虑 Z 盘、不跑其他盘副本」未越线记档）；同日作者将 Dev/ 挪回本地，链上记档随即补齐——本报告入 `01-评审/`、主 README 计数 3→4、总览 §1.3 增行、台账 §一 增行 + §三 R0909-W 维持登记行、`Archive/README.md` 批记行，本节与链上各正本一致。修复批已随作者同日指令「先提交改动」提交 win `71e5a01`（64 文件 +1414/−273 含 8 新增测试文件；Dev/ 链文档在盘不入 git）。

# 全量代码重审与进度质量评估（独立重评）

- 日期：2026-09-10。**执行模型：GLM-5.3**（主审 = 会话模型；子代理同模型，general-purpose 型只读评审）。
- 基线：dev HEAD `267e6864`（win←dev 合并提交），工作树干净，与 origin/dev 同步。
- 指令：作者「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务」。
- 纪律：**未读任何既有评审报告正文**（01-评审/ 三篇历史件仅知文件名）；评审独立于前轮结论，全部发现基于本轮直接读码 + 客观门实跑。Dev/Main/00-*.md 总览台账仅在收尾阶段用于**进度口径对账与文档链同步**（进度章引用阶段行状态，不影响代码发现）。
- 评审方式：**十域分工**——七域子代理并发（每波 ≤4，遵守派发上限纪律；桌面壳 / 服务端 / AI 链路 / 编排与账本 / 文档格式与导出 / 前端状态层 / 前端组件层，全文逐文件读）+ 三域主审亲评（RAG·知识·校验·学习·安装 / 工具链·构建·CI·依赖 / 测试体系——子代理配额撞 5 小时上限后由主审按「高风险路径全文 + 其余骨架扫描」口径接手，详 §十一）；主审对全部 3 条 P2 逐一 file:line 亲验成立，对子代理「待复核」项逐一定谳（tsc 0 错 → AI 域 P3-1 定谳为纯类型面精度问题）。

## 一、总评

| 维度 | 结论 |
|---|---|
| **完成进度** | **≈95%〔94–96%〕**——README 宣称功能面 100% 有完整实现（十域完成度表逐一核对，无 stub/TODO/半成品：全仓 10.7 万行源码 0 处真实 TODO/FIXME、0 处裸 `any`）；实施路线 24 个阶段 23 个已收口，唯余阶段 24「章节结构操作」方案已落盘待作者开工指令；版本 1.0.0-rc.1，win/mac 双平台打包链 + 发布冒烟已入 CI。 |
| **完成质量** | **A-**——0 条 P1；3 条 P2（全部主审亲验成立：桌面壳启动冻结防线漏网一处 / 编排域健康信号节流失实一处 / 前端状态层守卫族漏网一处）；约 35 条 P3（a11y、注释-实现漂移、窄前置容错、挂账备案类）。防御工事密度与测试回归纪律为罕见水平：10.7 万行源码内嵌数百条编号修复批注与测试互为索引，1008 单测文件 / 6525 用例 + 29 e2e spec 全绿，覆盖率阈值门在 CI 在位。 |
| 客观门 | 九件套一轮全绿（§二）。 |

**一句话结论**：项目处于「可发布的 rc 形态、收尾打磨期」——核心链路（数据安全 / 安全闸链 / AI 编排 / 并发防御）质量过硬，剩余风险集中在三条 P2 竞态/防线漏网（不丢数据但可冻结启动、可诱导放弃编辑、可令数据安全警示信号闪烁）与一批 P3 卫生项。

## 二、客观门实测（主审亲跑，2026-09-10）

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **0 错** |
| `npm run typecheck:web-next`（vue-tsc） | **0 错** |
| `npm run lint`（eslint） | **0 err / 0 warn** |
| `npx vitest run` | **1008 文件 = 6525 过 + 4 跳 0 败**（119.33s） |
| `npm run test:e2e`（含 build:web 前置） | **43 过 + 2 跳**（发布 smoke 需 `CLWRITING_E2E_RELEASE`，按设计跳过；29.1s）——build:web 随此前置通过 |
| `npm run check:counts` | 过——实测 1008 文件 / 6525 单测、29 spec / 45 用例，与 README 声称一致 |
| `npm run check:packaging` | 过 |
| `npm run check:knowledge` | 过——知识层 13 条 manifest 条目与磁盘一致 |

全局卫生：源码 0 处真实 TODO/FIXME（3 处匹配均为注释 `\uXXXX` 转义与知识条目文本）、0 处 `: any`；dist/tmp/test-results 均正确忽略；近 90 天 758 次提交，各域最后改动均在 2026-09-06~10（活跃维护态）。e2e 运行日志有一条 `[task-gate] 锁根目录被重复配置覆盖` 告警（usage-card 族独立 spec 换 server 的已知形态，告警为设计内留痕）——记观察项。

## 三、领域评审汇总（十域）

| # | 域 | 规模 | 评审方式 | P1 | P2 | P3 | 评级 |
|---|---|---|---|---|---|---|---|
| 1 | 桌面壳（src/desktop + 打包） | ~4.4k 行 / 15 文件 | 子代理全文读 | 0 | 1 | 7 | **A-** |
| 2 | 服务端（src/studio/server） | ~12.2k 行 / 48 文件 | 子代理全文读 | 0 | 0 | 3 | **A** |
| 3 | AI 链路（src/ai） | ~13.5k 行 | 子代理全文读 | 0 | 0 | 6 | **A** |
| 4 | 编排与账本（process/events/state/cache/driver/metrics/log） | ~11.7k 行 | 子代理全文读 | 0 | 1 | 2 | **A-** |
| 5 | 文档格式与导出（document/format/export/fs/git/review） | ~16.5k 行 | 子代理全文读 | 0 | 0 | 3 | **A-** |
| 6 | 前端状态层（stores/composables/api/shared/editor） | ~10k 行 | 子代理全文读 | 0 | 1 | 3 | **A-** |
| 7 | 前端组件层（components/views/pages，88 组件） | ~26k 行 | 子代理深读 40 核心 + 全域定向扫描 | 0 | 0 | 9 | **A** |
| 8 | RAG·知识·校验·学习·安装（rag/knowledge/check/learn/install + 知识层） | ~8.3k 行 + 知识层资产 | **主审亲评**（rag/index.ts、check/run.ts 全文 + leads/install/knowledge/learn 高风险面 + 防覆盖纪律核验） | 0 | 0 | 2 备忘 | **A** |
| 9 | 工具链·构建·CI·依赖（tsup/vitest/playwright/eslint/tsconfig/electron-builder/workflows/scripts/package.json） | 配置面 + 13 scripts | **主审亲评**（配置全文读 + CI 全步核对） | 0 | 0 | 1 观察项 | **A** |
| 10 | 测试体系（test/ 1008 文件 + 29 e2e spec） | — | **主审亲评**（分层矩阵 + 断言强度抽样 + e2e 基建全文） | 0 | 0 | 弱点 2 观察项 | **A** |

子代理自验撤回记录（不计入发现，证纪律有效）：服务端 3 项候选经上下文核verify撤回（analysis 档位口径与 spec 一致 / 章号双类型有 fail-closed 兜底 / chat-history 全量投影系契约必需）；AI 域「规则注入伪路径」疑点经查实为真实路径撤回；前端组件 2 项疑似 P2 降级（目录拖拽有服务端兜底、SSE 重放重复已在回放侧修）。

## 四、P2 发现详单（3 条，主审逐条亲验成立）

### P2-1〔桌面壳〕启动期 recent[] 失效过滤仍走同步盘 IO——失联网络卷冻结防护未闭合

- 定位：`src/desktop/main.ts:1050`（bootstrap 首行 `readStore()`）→ `main.ts:427`（`filterValidRecent`）→ `src/desktop/workdir-store.ts:114-121`（`isExistingDir` = 同步 `existsSync`+`statSync` 逐条 stat，recent ≤5 条）。
- 亲验：bootstrap 首行先 `readStore()`；重审-1 防线（`main.ts:1054-1082` 注释自述「指向失联网络卷……冻主进程」）的 `probeDirReachable` 只护 `store.current`（:1060）与 `process.cwd()`（:1077），时序上也在 readStore **之后**——recent 条目完全在防线外，首读同步扫描无预算。
- 影响：recent 残留失联网络卷（NAS/SMB 挂载点在而服务器无响应）时冷启动主进程冻结数十秒。与仓内 R47-9 / R54-A-2 / R61-B-1 / 重审-1 反复修复的同一冻结族，启动侧入口漏网。
- 建议修法：recent 过滤改带超时预算（`fs.promises.stat` + race，超时跳过判定保留展示），或首读仅 parse 不过滤、过滤挪进已 async 化的 `desktop:get-recent` handler；补「recent 含失联卷不冻结启动」回归测试。

### P2-2〔编排与账本〕网盘副本扫描节流窗内丢弃上次结果——注释承诺「回上次结果」实际回 `[]`，健康信号约 92% 时间不可见

- 定位：`src/state/state.ts:37-38`（注释承诺）vs `:42-49`（实现）→ 消费点 `:420/:440`。
- 亲验：`scanCloudCopiesThrottled` 窗内 `return []`；`detectState` 仅在 `cloudCopies.length > 0` 时产 `cloudCopy` 健康项，而 `/api/state` TTL 仅 5s、节流窗 60s——已检出的持续网盘双写冲突仅在每个 60s 边界的扫描瞬间可见，其余约 55s 健康项消失，状态在态 1/态 7 间周期闪烁。降级方向危险：节流把「有问题」降成「无问题」（fail-open），且态 1 是「进门先体检」第一闸，云副本属数据安全类警示。注释与实现契约不一致；`test/state/r58-cloud-scan-throttle.test.ts` 只钉「窗内新副本不可见」单向，未钉「已检出副本窗内保持可见」。
- 建议修法：节流表存结果 `Map<string, string[]>`，窗内返回缓存值（与注释及登记取舍完全一致：新副本 ≤60s 延迟可见、已检出副本持续可见）；补「窗内已检出副本仍可见」测试臂。

### P2-3〔前端状态层〕`doc.refresh()` 缺在途保存守卫：陈旧 baseline 覆盖已落盘基线 → 下次保存必吃假 REVISION_CONFLICT

- 定位：`src/studio/web-next/src/stores/doc.ts:539-583`（dirty 分支 baseline 写入 :552-554）；对照同文件三处既有守卫：`reloadFromRemote:474`（入口 `e.saving`）、`overwriteRemote:519`、`syncCleanWithTree:604-606/616`（过滤 + await 后复检）。
- 亲验：refresh 入口（:540-541）只查 `!e`，dirty 分支两次 await（GET :544 / sha256 :552）后仅复检书名（:553、:545）不复查在途保存；若 doSave 的 PUT 在 refresh 的 GET 与写 baseline 之间落定（doSave :426 已写新 `r.revision`），:554 用 GET 抓到的旧内容哈希覆盖回去——下次保存 `expectedRevision` 陈旧必 409，弹「此文档已在其他地方修改」假冲突。横幅之后的新键入是真正本地独有的，作者若信横幅选「重载」即被真实丢弃。无自动数据损坏，但假冲突信号可诱导放弃真实编辑。
- 建议修法：对齐同文件守卫族口径——入口加 `if (!e || e.saving) return false`（或等待在途保存后重判），dirty 分支 `await sha256Revision` 之后补 `e.saving` 复检（复检不过放弃写 baseline，交常规保存链）；补「refresh 与在途保存交叠」用例。

## 五、P3 发现清单（分域简列，约 35 条）

**桌面壳（7）**：① mac/linux 字体枚举超时不杀子进程（PM-12 备案待拍板，`main.ts:1491` 不传 deps 使必杀路径生产不可达）；② 崩溃风暴封顶对话框 `showMessageBoxSync` 同步阻塞主进程（`main.ts:319-328`）；③ preload-error 监听只挂主窗（`main.ts:1325`）；④ 窗口状态校验用整屏 bounds 而创建侧用 workArea（`main.ts:366` vs `:1138`，口径不一）；⑤ probeDirReachable 挂起 stat 占 libuv 线程池槽位（Node 限制，已备案）；⑥ 字体缓存 TTL 过期重载失败弃旧值（serve-stale 更优，小体验项）；⑦ OS 关机（session-end 后）quit 链仍可能弹同步确认框（无人应答窗内挂起至 OS 强杀，数据面有 flush 兜底）。

**服务端（3）**：① stream.ts 五端点互斥检查矩阵手工重复（闸检查 40 处引用 / 409 BUSY 33 处，注释自认「三处重复不动」——维护漂移面）；② io.ts:117 / knowledge.ts:71,115 三处 handler 内冗余 `checkToken`（与全局写闸口径不一致，误导安全模型分层判断）；③ SSE `?token=` query 兼容通道仍在（`stream.ts:382-393`，token 进 URL 的泄露面，移除条件 = useSse 回退路径下线，已在案）。

**AI 链路（6）**：① run 回调 `degraded` 字段在 turns.ts:616-627 / finish.ts:95 的泛型 T 未声明（主审跑 tsc 0 错定谳：无编译红点，纯类型面精度问题；运行时经 runner `extractDegraded` 动态提取无碍）；② 工具参数「合法 JSON 非对象」形状跨协议换供方回放可致网关 400（`anthropic-adapter.ts:97` 的 `as` 断言吞形状，窄前置 fail-visible）；③ 降级链对真·上下文超限 400 白耗一次剥 tools 调用（`adapter-errors.ts:153`）；④ CLW_VERIFY_VISIBLE 诊断走 console.warn 绕过统一日志通道（`turns.ts:448`）；⑤ 历史成本按现价重算（R50-B-4 备案权衡）；⑥ chat 线 llm/call 指纹只覆盖末条消息（Q-11 备案口径）。

**编排与账本（2）**：① metrics/short-index.ts 模块头宣称「数据来自已定稿」但 scanShortCollection 未滤定稿（唯一调用方 export 侧自行二次过滤，无用户可见影响；文档/实现不一致 + 新调用方潜伏陷阱）；② events/store.ts:866/958 `appendEvent`/`latestSession` 纯测试面接口挂生产 SessionStore（契约面偏宽）。

**文档格式与导出（3）**：① 版本文件 fence 字节层判定未同步 R54-E-2 尾随空白容忍（`version.ts:461` isFenceLine 仅收 `---`/`---\r` vs `frontmatter-core.ts:62` 容忍尾随空白——外改版本文件恢复端点 fail-closed 失败，注释「同口径」失实）；② 章号分隔符容忍度两链不一致（`tree.ts:102` 容忍长划/空格 vs `foreshadow.ts:571` 仅短横——外建非规范名章在伏笔足迹链路隐形，产品口径待裁量）；③ leads.ts stringifyHistory 外围空行 trim 与「原样还原」注释表述精度差。

**前端状态层（3）**：① 书级 prefs 持久化 `catch(() => {})` 完全静默（`workspace.ts:207-218`，与全局偏好一次性 warning toast 口径不一致）；② workbench 未知事件逐条 console.debug（高频刷屏，观测面）；③ prefs 迁移分支 `lastPersisted` 先于 PUT 落定置位（极窄窗口漏判脏字段，注释自称有意）。另有已登记过渡挂账：useSse ticket 换票失败回退 `?token=`（非缺陷，收口条件在案）。

**前端组件层（9）**：① HistoryPanel 恢复按钮键盘焦点不可见（opacity:0 仅 hover 显形，无 :focus-visible）；② 章节树目录拖拽静默无反馈（前端 `if (!node?.docId) return` 丢弃，服务端有兜底）；③ 章节树 a11y 语义薄弱（100 行 = 100 Tab 停靠点，无 tree/treeitem/roving——对照库内 CommandPalette 已有标准）；④ @补全名单会话内陈旧（仅切书时拉取）；⑤ ReviewPanel 头注释宣称未实现的「意见点击定位」前瞻特性（误导维护者）；⑥ SVG 渐变写死 id 潜在多实例冲突（当前单实例）；⑦ ContextMenu 浏览器回退版子菜单键盘不可达（桌面端走原生 Menu 不受影响）；⑧ SearchPanel 搜索框缺 aria-label；⑨ ForeshadowPanel 已回收项键盘不可达。

**RAG·知识·校验·学习·安装（主审，2 备忘）**：① buildIndex 空正文错误文案「没有**定稿**正文可索引」与头注「含未定稿草稿（召回服务写作连续性）」口径打架（纯文案）；② `recall()` 兼容包装生产零调用仅服务存量测试（自文档化登记维持）。

**工具链·CI（主审，1 观察项）**：dev push 腿未接（ci.yml 触发面 = main push / 指向 main 的 PR / 手动；注释明示收窄决策，验证责任在本地——与台账挂账一致，独立复核维持）。

**测试体系（主审，2 观察项）**：RelationGraph/RelationDetail 交互细节、Wb 卡片族为浅层断言（可接受）；e2e 顺序耦合为架构级约束，缓解已机制化（spec-order.snapshot.txt + spec-order.guard.test.ts 锁顺序、workers:1、端口族偏移表、first-cause-reporter）。

## 六、测试体系评估（主审）

- 分层矩阵：单测 1008 文件 / 6525 用例（vitest，mac/linux 口径；win 实跑 6450 + 79 跳，平台门 skipIf(win32) 差恒定 75）+ Playwright e2e 29 spec / 45 用例（mock driver 驱动，不调真实大模型）+ 发布冒烟（编译产物起服）入 CI。
- 分布：studio 409（服务端+webnext 231）/ ai 121 / document 90 / format 62 / check 48 / process 44 / install 29 / rag 31 / fs 26 / events 25 / desktop 23 / state 18 / scripts 14 / export 12 / cache 13 / metrics 6 / knowledge 6 / log 5 / governance 5 / review 5 / driver 3 / learn 2 / corpus 1。
- 断言强度抽样（runner.test.ts / r29-components-zero-coverage / e2e global-setup）：真钉行为——确定性拒绝端点用「内核分配端口后释放」替代 localhost:1 环境假设；零覆盖组件主动 mount 直测；`j5-overlay-dim` 逐文件读 CSS 锁遮罩常量防双源漂移。回归纪律：历轮修复编号（R 系）与代码内联批注互为索引，几乎每个 bug 有对应回归文件。
- mock 边界：AI 面走 mock driver + `MOCK_TOOL_INPUT` 治理开关 + prompts-golden 金样锁组装；三适配器 SSE 边界（分片/无 index/usage 末见/截断/降级链）专项覆盖密度高。
- 弱点：覆盖率阈值门（基线 −2pp 防回退）只在 CI ubuntu·24 腿跑（设计取舍）；`.vue` SFC 不在 lint 射程（vue-tsc 自管，登记在案）。

## 七、进度评估

**口径 1 · 实施路线（总览第三节）**：24 个阶段中 23 个已收口（历史冻结可考），当前唯一开放任务 = **阶段 24「章节结构操作」**（留洞制 fm `序`/`并入`，设计 v2 + 执行方案均已落盘 2026-09-04，实施待作者指令）。

**口径 2 · README 宣称功能面（十域逐一核对）**：建书（长篇/短篇集）、设定表单（九类字段）、编辑器（自动保存/版本校验/快照/undo 隔离/IME 守卫/崩溃镜像）、全自动写章（AI 起草→机检→报红打回→全绿交作者→上限停下问人）、三审（长篇三视角/短篇三审）、定稿防吃书（账本两端闭合 + 红闸 + 批量定稿）、伏笔全程追踪、字数曲线与节奏分布、文风系统（定标/条目库/收割/验收）、对话助手（15 工具风险分级 + 确认闸）、导出（批注剥除 + 定稿过滤警示）、事件审计（分页/血缘/两步清史）、书架（搜索/排序/批量管理）、win/mac 双平台打包——**全部有完整实现，无缺失或简化项**。

**口径 3 · 工程配套**：CI 三腿矩阵全门在位（typecheck×2/lint/build/产物门/packaging/pack 清单/覆盖率阈值/README 对账/知识层对账/e2e/发布冒烟）；check 脚本三件实核对；版本 1.0.0-rc.1。

**进度结论：≈95%〔94–96%〕**。扣分项 = 阶段 24 未实施（方案就绪，属「待指令」而非「待设计」）+ 台账既有挂账（switch-provider 消费、PM-10/PM-12 待拍板、锁超时降级取舍等均为明示登记的有意延后）+ 本轮 3 条 P2。若阶段 24 落地且 P2 清偿，即达发布态。

## 八、质量评估

**亮点（支撑 A- 的面）**：
1. **数据安全纵深**：原子写（tmp+rename+fsync）+ 排他写 + 跨进程锁（pid+bootTime+stale 判定）+ 删书墓地 rename + 覆盖前快照 + 乐观锁三形态 + flush 预算与冲突/失败确认 + 取消回滚——防丢稿链路完整咬合。
2. **安全闸链**：Electron 隔离/沙箱/sender 白名单校验/CSP 注入；HTTP 侧 Host 白名单→Origin 白名单→写端点 token（timingSafeEqual）→GET/HEAD token 闸 + 显式豁免表；路径穿越双侧 realpath fail-closed；密钥 HKDF→AES-256-GCM 信封加密 + 全出口脱敏；对话工具 15 项风险分级 + 写类确认闸。
3. **并发防御体系化**：跨进程 task-gate、per-file/per-book 串行链、书名快照 + 连接代数 + 在途去重台账（前端全域惯例）、树红点聚合纪元指纹首尾核 + 批丢弃、SSE 背压双闸 + watchdog 家族。
4. **项目铁律端到端成立**：「模型可见 ⟺ 已记录」（promptMeta/digest 事件 + CLW_VERIFY_VISIBLE 抽样校验器）；「默认值显式 resolve」（maxTokens/quirks/超时逐层显式落事件）。
5. **可维护性罕见水平**：数百条编号修复批注与回归测试互为索引；每条忽略路径有注释理由；自文档化挂账（生产不可达代码、test-only 包装均明示）。
6. **测试文化**：6525 用例全绿 + spec-order 快照守卫 + 零覆盖组件主动自审计 + 金样锁 + CSS 常量锁——防回潮密度远超常规工程。

**短板（扣至 A- 的面）**：3 条 P2 均属「守卫/防线族的漏网项」（同族防线已系统性建设，个别入口漏掉）——这正是该工程模式的残余风险形态；P3 面集中于 a11y 收尾（章节树/恢复按钮/已回收项）、注释-实现口径漂移（fence 字节层、short-index 头注）、窄前置容错（跨协议工具参数形状）；plus 既有挂账的明示延后项。

## 九、处置建议

- **必修档（P2×3，建议随修复批收口）**：§四 P2-1（recent 预探）、P2-2（节流缓存结果）、P2-3（refresh 守卫对齐）——三条修法均小面（单函数级 + 各补一条回归臂），与本仓守卫族既有口径对齐即可。
- **建议修档（P3 高价值精选）**：桌面壳②③（同步对话框改 async / preload-error 全窗挂）、服务端②（冗余 checkToken 删除）、AI②（非对象参数 `_raw` 兜底）、文档①（fence 字节层对齐 + 注释收口）、前端①③（恢复按钮 focus-visible / 章节树 a11y）。
- **维持登记档**：其余 P3 与既有挂账（PM-12、switch-provider、锁超时取舍、SSE ?token= 通道、dev CI 空窗等）沿用台账 §三 机制，随轮次消化。
- **进度侧**：阶段 24 待作者开工指令（方案就绪）。

## 十、收口条件（按项目规则：P1/P2 修复 + 回归通过才收口）

本轮 P1×0、P2×3——报告完成 ≠ 收口；P2×3 修复 + L2 终门全绿后收口，届时归档移动待确认闸。

### 收口记（2026-09-10 修复批，作者指令「全部修复，编排下任务做」）

**修复范围**：P2×3 必修全修 + P3 全部非维持项随批收（作者「全部修复」指令按 §五/§九 全名单执行，超出 §九「建议修」精选档）；维持登记项见下。执行方式：子代理当日配额耗尽，全部修复由主审串行亲修。

- **P2-1**（recent[] 失联卷同步冻启动）：workdir-store.ts 删同步 filterValidRecent/isExistingDir，新 `filterValidRecentBudgeted`（逐条 Promise.race 超时预算 + 并行 + stat 注入；超时保留、确定性失败剔除——R48-73 口径）；main.ts bootstrap await 先行（早读窗口不存在）。回归：desktop/workdir-store.test.ts +失联超时保留/确定性失败两臂。
- **P2-2**（云副本节流窗健康失明）：state.ts 节流窗内缓存上次结果回放（P2-1/P2-2 同文件邻位）。
- **P2-3**（doc.refresh 竞态）：入口对齐守卫族（e.saving 拒）+ savedAt 快照 + 双 await 后迟到守卫；**净分支实现两轮收敛**——首版 content 后置到守卫后，ee-P1-7 既有用例红（其契约钉死「sha256 在途期 e.content 可观察为服务端值」）；终版改早写 + 失败回滚（守卫命中且窗口内无键入时回滚窗口前值；有键入则键入优先），ee-P1-7 与本批新用例同绿。回归：新建 r1010-doc-refresh-save-race.test.ts 4 用例（保存落定整体放弃/在途 saving 拒/入口闸/迟到 GET 不覆盖新基线）。
- **P3 随批收**（分组记要，代码内均有 R1010-P3 注记）：G1 指标口径注释修正（short-index 头注 + 冷启动断言同步）；G2 服务端卫生（io.ts/knowledge.ts/http.ts 冗余 checkToken 三处删 + rag 报错文案）+ G3 AI 链路（verifyVisibleSample log.warn 留痕 / anthropic+responses 非对象 toolInput `_raw` 兜底 / isMidChain400 排除 context-window 400——A7 shrink 契约适配：超窗 400 直达 shrink 重试不再走降级链，a7-shrink-retry 2 用例脚本与计数同步）+ G4 文档格式（fence 行尾空白容忍〔r34d 新臂〕+ chapterNoFromName 单源五处归一〔filename 新 describe 6 用例〕+ stringifyHistory 精度注记）+ G5 前端状态（书架布局持久化失败一次性 toast〔R55-F-7 口径〕/ workbench 未知 type debug 降噪 / prefs lastPersisted **证伪维持**——报告建议「移到 PUT 后」经推演会破坏迁移 PUT 与并发保存 409 的 R61-F-3 零脏字段基线，维持原位并补全理由注记）+ G6 前端组件×9（HistoryPanel 恢复钮 focus-visible / 目录拖拽 toast 明示〔r1010-tree-roving 2 用例〕/ 章节树 tree/treeitem/group + roving tabindex + ↑↓→←Home/End 全键盘导航〔IME 让渡；同文件 5 用例〕/ @补全名单 5min TTL 触发刷新 / ReviewPanel+review store 头注过时前瞻宣称修账 / WordCurveChart 渐变 id 实例唯一〔useId〕/ SearchPanel aria-label / ForeshadowPanel 已回收区键盘可达 / ⑦ ContextMenu 浏览器回退子菜单**注释档维持**——桌面原生 Menu 不受影响，触发条件=浏览器版转正）+ G7 桌面壳×5（崩溃风暴封顶对话框 sync→async〔server-manager 契约放宽 Promise + main.test 断言面换 msgBox〕/ preload-error 入 createSecureWindow 工厂三窗挂 / loadWinState 校验整屏 bounds→workArea 对齐创建侧口径〔假件补 workArea〕/ font-cache TTL 过期重载失败 serve-stale〔不刷龄，新臂 1 用例；首次失败照抛负缓存不变〕/ before-quit 入口 sessionEnding 直通〔OS 收尾期级联 quit 不再起交互链，新臂 1 用例〕）。
- **维持登记（不修，理由在位）**：桌面①（PM-12 待拍板，台账既有）⑤（Node libuv 限制）；服务端①（stream 互斥矩阵注释自认）③（?token= 通道有下线条件，R0909 既有）；AI⑤⑥（备案权衡）；RAG②（test-only wrapper 有登记）；CI dev 空窗（台账待拍板）；G5③（证伪维持，见上）；G6⑦（注释档，见上）。
- **环境事故记档**：修复中途一次全量跑后紧接第二次跑触发本机（16GB）swap 卡死——主审诊断为环境性（背靠背全量 + 4 forks 池），代码面复核无算法性放大（全部线性/有界）；此后单次全量 + 间隔执行，未再复现。
- **L2 终门（二轮全绿，收口口径）**：vitest 1010 文件 = 6548 过 + 4 跳 0 败〔136.80s；首轮 1 败 = P2-3 首版净分支后置破坏 ee-P1-7 契约，如上收敛修复〕+ tsc 0 错 + vue-tsc 0 错 + eslint 0/0 + 三 check 过〔counts 实测 1010/6548/29 spec/45 用例对账一致〕+ e2e 43 过 2 跳〔30.1s〕。根 README 修账 1008/6525→1010/6548 四处（win 口径行同步改「过数 −75 恒定差」表述，新增用例均平台无关，待 CI win 腿复验）。
- 改动面：53 改 + 2 新增（+784/−159 含新文件 407 行全量）；零提交（工作树待作者指令）。台账 §一/§三、总览 §1.3、Archive 批记行同批同步；归档移动待确认闸。

## 十一、评审方法记档（透明性声明）

1. **子代理配额事件**：第 2 波尾三路（RAG·知识·校验 / 测试体系 / 工具链·CI）于 2026-09-10 01:39 撞子代理 5 小时使用上限（05:02 重置）派发失败，零输出零残留；该三域改由主审亲评接手（第 1~2 波七域子代理产出不受影响）。三域亲评深度声明：RAG 域 rag/index.ts（985 行）全文 + check/run.ts（765 行）全文通读，check 域其余（count.ts 1064 / runner.ts 451 / tree-issues-cache.ts 357 等）骨架 + 关键函数抽样——**深读密度低于子代理域，P1/P2 结论置信度相应标注为「主审抽样口径」**；工具链/测试体系为配置与小体量面，全文读齐。
2. **原计划第 3 波「安全面专项 / 文档一致性」两路未单立**：安全面经桌面壳/服务端/AI 三域子代理深评（安全闸链逐层验证）+ 主审复核已覆盖；文档一致性经三 check 实跑（counts/packaging/knowledge 均过）+ README 功能面十域核对已覆盖，未再见独立盲区。
3. **既有评审文档**：全文未读（目录仅见文件名）；总览/台账仅用于收尾进度对账与文档链同步，本轮全部发现可独立复现。

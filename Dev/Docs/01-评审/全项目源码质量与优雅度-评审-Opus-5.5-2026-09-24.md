# 全项目源码质量与优雅度评审

- 执行模型：Opus-5.5（主评审 + 两个只读子评审，同模型）
- 日期：2026-09-24
- 基线：分支 `win` @ `5f57a527`，工作树净
- 口径：刻意不读 `Dev/Docs` 既有文档与历轮评审报告，只以源码、测试与构建配置为据；回答两个问题——**代码是否优雅**、**完成质量是否足够高**
- 状态：**已收口**（P2×5 修复 + 端点/组件级回归 + L2 全量绿，见第八节）；P3×27 待逐条处置

## 〇、范围与方法

| 区域 | 规模 | 评审深度 |
|---|---|---|
| 领域核心：document / events / fs / format / export / install / state / check / rag / cache / update 等 | 约 4.0 万行 .ts | 主评审。高风险文件通读（DocumentService、events/store、journal、trash、queue、atomic、cross-process-lock、safe-path、export、migrate-layout-v3、update/check），其余抽读 |
| 服务端 / 桌面 / AI / process：studio/server、desktop、ai、process | 约 4.0 万行 .ts | 子评审 B。核心与高风险文件通读，P2 由主评审逐行回读复核 |
| 前端：studio/web-next | 104 个 .ts 约 1.4 万行 + 111 个 .vue 约 2.7 万行 | 子评审 A。stores / composables / api / editor 核心文件通读，P2 与所引行号由主评审回读复核 |
| 测试资产 | 1304 个测试文件 + 33 个 e2e spec，约 20.3 万行 | 命名与结构统计 + 抽样精读 |
| 构建与门 | tsconfig ×2、eslint、tsup、vitest、ci.yml | 通读 |

方法：

1. **门实测**（本机 Windows 11）：tsc、vue-tsc、eslint、check:counts / check:docs / check:packaging / check:knowledge、`vitest --coverage` 全量。e2e（playwright）与 mac/linux 腿本轮未跑。
2. **度量**（一次性脚本，未入库）：TS AST 函数级代码行 / 圈复杂度 / 嵌套深度；模块级与文件级（仅运行时 import）依赖环 Tarjan SCC；注释行与修复批号标签密度；类型逃逸计数；测试命名统计。
3. **人工评审**：三切片并行，每条发现回溯调用方，标 CONFIRMED（代码路径已走通）或 PLAUSIBLE（推断，未实证）。
4. **严重度**：P1 = 数据丢失 / 安全 / 主流程不可用；P2 = 真实缺陷或承诺失守，有具体触发场景；P3 = 设计债、一致性、可维护性。

## 一、总评

### 1.1 完成质量是否足够高？——**是**，达到可发 1.0 的水准

- **未发现 P1**。P2 共 5 条（后端 2、前端 3），多数属于「同类路径只修到一处」型缺口，改动面都小（见第四节）。
- **类型纪律近乎零逃逸**：全库 `any` 0 处、`@ts-ignore` 0 处、`as unknown as` 17 处、`eslint-disable` 1 处、TODO 1 处；根与 web-next 两侧 tsconfig 均开 strict + noUncheckedIndexedAccess + noUnused* + noFallthrough + verbatimModuleSyntax。
- **数据安全工程罕见地严谨**：原子写（tmp + fsync + rename + 目录 fsync + win 瞬时锁退避）、跨进程文件锁（独占创建 + 陈旧锁隔离接管 + 续期）、按文档串行的 SaveQueue、revision 冲突检测、保存 journal 与压缩、回收站「先登记后移文件」、固定锁序——每一步都论证了崩溃窗口与平台差异。
- **安全基线完整**：仅回环监听 + Host / Origin / token 分层闸 + 常量时间比较、Electron 安全旗不可覆盖、IPC 只认可信发送方、vault 以 provider id 作 AAD、子进程数组参数无 shell、日志统一脱敏；前端全切片无 v-html / innerHTML / window.open。
- **测试体量大且全绿**：vitest 1296 文件通过 / 8 跳过，7965 例通过 / 76 跳过；CI 门集合齐备。
- 扣分：覆盖率阈值在 win 本地跑不过（两项各差约 0.1 个百分点，见 P3-7）；三个前端视图零覆盖；e2e 本轮未跑。

### 1.2 代码是否优雅？——**局部优雅，整体不够**

单点写法质量高（命名、类型、错误信封、单一咽喉点都好），但**演进痕迹没有被消化**，五个结构性问题拉低了整体：

1. **注释考古化**：注释占 28.8% 行，内含 11,098 个修复批号标签；函数体被修复叙事包裹（`executeSave` 421 行里只有 218 行代码），行号与文档路径引用已开始失效。
2. **巨型函数与巨类**：4,770 个函数中 85 个超过 100 行代码、47 个圈复杂度 > 25；DocumentService 单文件 1742 行，拆分只拆文件不拆职责（剥 private、留转发桥）。
3. **横切规则靠约定与注释对齐，而非结构保证**：后端忙闸互斥矩阵约 7 处手写、输入校验两套纪律、三个供应商适配器的流尾收口各复制 2–3 份、安全响应头三份；前端「读 dirty 前先冲刷」「切书后每次 await 复检书名」「遮罩登记」「前后端回包形状一致」四条规则全靠逐点列举——每一条都已有漏网实例（P2-4、P2-5 即是）。
4. **依赖结构成环**：12 个核心模块互相可达（一个强连通分量）；运行时文件级 5 个环，最大一个横跨 ai 与 process 共 15 个文件，根因是通用工具放错了模块。
5. **测试资产按批次组织**：约 41% 的测试文件以批号命名；约 35 个测试文件读生产源码文本做断言来「钉」实现——有的反过来决定了代码放在哪，有的锁住注释原文，把重构变成破坏测试。

对照组：最新写就的 `src/update/check.ts` 每千行只有 7.5 个批号标签、结构清爽——团队写得出优雅代码，问题出在「修复模式」下只加不减。

### 1.3 一句话

**工程可靠性一流，代码形态欠修剪。** 像一台被反复加固的保险柜：锁都很好，但焊缝和贴在柜门上的维修记录越来越多。1.0 可以发（先修 P2）；1.0 之后最值得投入的不是新功能，而是一轮「只减不加」的整理。

## 二、维度评分（1–5）

| 维度 | 分 | 依据 |
|---|---|---|
| 正确性与健壮性 | 4 | 未见 P1；错误路径普遍收编为结构化信封；前端每次 await 后复检迟到结果；P2 多为同类路径只修一处 |
| 数据安全与并发 | 5 | 原子写、跨进程锁、journal、revision 冲突、回收站登记次序、锁序 |
| 安全 | 4 | 请求闸分层 + Electron 加固 + vault AAD + 前端零 v-html；扣分：KEK 1.0 仅混淆级、SSE `?token=` 回退通道仍在、写工具确认卡看不到参数（P2-3） |
| 类型安全 | 4 | 近零逃逸；扣分：OpenAI 参数 `Record<string, unknown>` 强转、driver 能力全可选、盘上数据未校验即断言、前后端回包类型手抄无共享契约（P3-21） |
| 错误处理 | 4 | 统一错误信封 + 脱敏；best-effort 与 fail-closed 的取舍大多写明理由 |
| 性能意识 | 3 | 流式导出、指纹缓存、SSE 背压、慢盘异步链、前端正文回写节流；扣分：自愈编排仍同步 IO（P2-2） |
| 架构与模块边界 | 3 | 分层意图清楚；12 模块强连通、通用工具错位、模块级单例多；前端「书会话」无生命周期对象、store 兼作事件总线 |
| 抽象与复杂度 | 2 | 85 个 >100 行函数、47 个高圈复杂度函数、巨类与机械拆分、隐式状态机 |
| 可读性与命名 | 3 | 命名清楚，中文领域标识用得得当；阅读成本被注释密度与缺格式化拉高 |
| 注释质量 | 2 | 「为什么」写得好，但被批号史淹没；已有失效行号 / 路径引用与过时状态描述，且有测试锁住注释原文 |
| 重复与一致性 | 2 | 忙闸、校验、流尾、安全头、tmp 写块多处复制，已漂移；前端已建好防竞态、字数防抖、截断等共享工具，旧写法却没替换 |
| 测试质量 | 3 | 体量与行为级集成测试强，前端抽样确定性好；批号命名、源码文本断言、固定 sleep、规则靠逐点列举测试维持，拉低可维护性 |
| 工程化与工具链 | 3 | 严格 tsc、多道 CI 门；缺格式化器，ESLint 非类型感知且不覆盖 .vue |

综合：**完成质量约 4 / 5，优雅度约 2.5 / 5。**

## 三、亮点（应保持）

1. **数据安全链**
   - `src/fs/atomic.ts`：tmp + fsync + rename + 目录 fsync；EPERM / EBUSY 退避；以 `link` 实现独占创建。
   - `src/fs/cross-process-lock.ts`：`open('wx')` 独占 + 陈旧锁经原子 rename 隔离接管 + maxHeld + 续期。
   - `src/document/queue.ts`：按文档串行的 SaveQueue，短小清楚。
   - `src/document/journal.ts:519-597`：compact 在锁内取基线 stat 并补追尾段；`:384-429` 降级裸写做 inode 自校验——崩溃窗口逐一论证。
   - `src/document/trash.ts:13-14`、`src/install/migrate-layout-v3.ts:45-57`：清单派生路径一律过路径安全校验；「先登记、后移文件」保证不产生不可见孤儿。
2. **失败即信封、不裸抛**：`src/export/index.ts` 全函数守住 `{ok:false}` 契约（前置、过滤后、写入期、投稿视图四层收编）；`src/install/migrate-layout-v3.ts:70-79` 迁移跑在启动链路，一律收进 errors 不阻断启动。
3. **细节到位**：导出文件名的字节预算把原子写临时名后缀算了进去（`src/export/index.ts:202-215`）。
4. **请求闸分层与统一错误信封**：`src/studio/server/index.ts:320-436`（非回环即抛、Host → CORS → 写请求 Origin → token）；`http.ts:102-107` 先 SHA-256 再 `timingSafeEqual`；`http.ts:73-88` 信封含脱敏与 nosniff；`http.ts:136-256` readJson 有 1MB 上限、空闲 408、413 排空；`api/stream-sse-writer.ts:97-123` SSE 双阈值背压。
5. **Electron 加固**：`src/desktop/windows.ts:312-327` 安全旗写在展开之后不可覆盖；`ipc.ts:135-164` 外链白名单 + 可信发送方；`server-manager.ts:308-350` token 经 env 传给子进程后擦除。
6. **「模型可见 ⟺ 已记录」有单一咽喉**：`src/ai/tasks/spec.ts:116-205` runSpec 汇总 promptFiles / promptTools；`src/ai/runner.ts:433-473` 显式 resolve effort / timeout / maxTokens / quirksVersion 并写入 trace。
7. **供应商错误收编**：`src/ai/provider/adapter-errors.ts:52-93` 五分支定序映射、usage 随错误带出，`:129-188` 400 降级链；`vault.ts:191-208` AAD 绑定 provider id，`:146-171` 版本防降级；`store.ts:649-657` revision 冲突、`:704-711` 先备份再 0600 原子写。
8. **最小依赖**：运行时依赖只有 3 个（@anthropic-ai/sdk、openai、font-list）；YAML / frontmatter 手写且字节保真——有维护成本，换来零供应链面与对作者原文的精确保留。
9. **子进程与日志**：`src/git/exec.ts` spawn 数组参数、无 shell；`src/log/redact.ts` 统一脱敏。
10. **新代码示范**：`src/update/check.ts` 的结构、注释密度与命名是全库最佳，可作整理后的目标形态。
11. **前端正文回写单源**：`web-next/src/shared/body-writeback.ts` 零依赖、不变量先写成文字；待写槽存 {docId, body} 原子对，切档先落旧档，跨档污染从结构上排除；回写函数由视图注入，store 可直接冲刷而不反向依赖。
12. **前端请求层**：`web-next/src/api/client.ts:196-322` apiJson 统一信封与错误码，超时与外部 signal 联动并在结束后摘除监听；401 / 403 自愈只重放幂等请求；重试链的 sleep 可注入，测试完全确定。
13. **「不丢字」闭环**：`web-next/src/composables/useStaleGuard.ts:32-43` 用五个方法讲清「迟到结果作废」；`web-next/src/stores/doc.ts:466-529` refresh 先落待写正文、再三重复检，窗口内键入优先；与 `composables/useUnloadFlush.ts` 的关窗冲刷链合起来可信。
14. **编辑器宿主**：`web-next/src/editor/CmHost.vue` 输入法组合期挂起外部替换与切档（`:222-265`，切文档执行体见 `:356` 起），切档重置撤销历史，撤销不会跨文档。
15. **前端安全面干净**：全切片无 v-html / innerHTML / window.open；对话纯文本渲染；外链经 `web-next/src/components/ui/UpdateBanner.vue:48-63` 走主进程白名单 openExternal，失败退为复制到剪贴板。

## 四、问题清单

### 4.1 汇总

| ID | 级 | 域 | 标题 | 判定 |
|---|---|---|---|---|
| P2-1 | P2 | AI 编排 | /auto-write 包装 driver 漏委托中断能力，后台账本草稿 AI 调用不可中断 | CONFIRMED |
| P2-2 | P2 | AI 编排 | 自愈编排在服务端事件循环上同步 rebuild + 同步机检，绕过慢盘异步链 | CONFIRMED |
| P2-3 | P2 | 前端 | 写工具确认卡看不到参数，15 个工具中 13 个显示英文原名 | CONFIRMED |
| P2-4 | P2 | 前端 | 批量定稿丢掉 gateDegraded，防吃书闸降级放行时仍报成功 | CONFIRMED |
| P2-5 | P2 | 前端 | 历史恢复前未冲刷 200ms 正文回写窗口，报「已恢复」实未生效 | CONFIRMED（触发窗口窄） |
| P3-1 | P3 | 横切 | 注释考古化：修复史挤占代码且开始腐烂 | CONFIRMED |
| P3-2 | P3 | 横切 | 巨型函数与巨类 | CONFIRMED |
| P3-3 | P3 | 横切 | 依赖环：12 模块强连通 + 5 个运行时文件环 | CONFIRMED |
| P3-4 | P3 | 横切 | 缺格式化器；ESLint 非类型感知且不覆盖 .vue | CONFIRMED |
| P3-5 | P3 | 横切 | 测试资产按批号组织，源码文本断言与固定 sleep | CONFIRMED（间歇红风险 PLAUSIBLE） |
| P3-6 | P3 | 横切 | 测试缝渗入生产代码，模块级单例多 | CONFIRMED |
| P3-7 | P3 | 横切 | 覆盖率阈值贴线，win 本地跑不过 | CONFIRMED |
| P3-8 | P3 | 核心 | DocumentService 机械拆分：剥 private、留转发桥 | CONFIRMED |
| P3-9 | P3 | 核心 | journal 全文快照只写不读，与前端未保存镜像职能重叠 | CONFIRMED |
| P3-10 | P3 | 核心 | 导出同名产物归档失败仍覆盖，警告却称「已保留原位」 | CONFIRMED（触发面窄） |
| P3-11 | P3 | 核心 / 后端 | 小型重复与类型谎言 | CONFIRMED |
| P3-12 | P3 | 服务端 | 忙闸互斥矩阵约 7 处手写，已漂移 | CONFIRMED |
| P3-13 | P3 | 服务端 | 输入校验两套纪律；providers.models 漏校验 | CONFIRMED |
| P3-14 | P3 | 服务端 | 任务闸锁文件名用不可逆哈希，衍生两张注册表 | CONFIRMED |
| P3-15 | P3 | AI | 三个适配器流尾收口复制粘贴，stopReason 未归一 | CONFIRMED |
| P3-16 | P3 | AI / 核心 | 类型安全在边界打折 | CONFIRMED |
| P3-17 | P3 | 桌面 | server-manager 以 12 个闭包变量拼隐式状态机 | CONFIRMED |
| P3-18 | P3 | 桌面 | KEK v2 搁置成死分支，启动日志含开发者指令 | CONFIRMED |
| P3-19 | P3 | 服务端 / 前端 | SSE `?token=` 过渡回退通道仍在用；连接状态靠十个标志位手工复位 | CONFIRMED |
| P3-20 | P3 | 前端 | 切书安全靠「先切后回滚」与每次 await 手写书名复检 | CONFIRMED（设计层面，子评审原判 P2） |
| P3-21 | P3 | 前端 | 回包类型与子组件接口手抄，无共享契约 | CONFIRMED |
| P3-22 | P3 | 前端 | 两个对话框绕开遮罩登记：⌘P 盖在对话框上、win 窗控不变暗 | CONFIRMED |
| P3-23 | P3 | 前端 | RAG 轮询失败终止不重置连败计数，重建后首败即停 | CONFIRMED |
| P3-24 | P3 | 前端 | workspace store 兼作事件总线与函数注册表 | CONFIRMED |
| P3-25 | P3 | 前端 | prefs store 暴露 76 个成员，职责过宽 | CONFIRMED |
| P3-26 | P3 | 前端 | 已有共享工具未替换旧写法：小型重复与内部状态外露 | CONFIRMED（重复计数的性能代价 PLAUSIBLE） |
| P3-27 | P3 | 前端 | 在途对话回合以数组下标追踪 | PLAUSIBLE |

### 4.2 P2 详述

**P2-1 /auto-write 包装 driver 漏委托中断能力，后台账本草稿 AI 调用不可中断**

- 位置：`src/studio/server/api/stream.ts:724-732`（`watchedDriver` 只委托 startSession / stream / dispose / emit）；`src/ai/orchestrate/self-heal.ts:738-746`（通过后以 `opts.driver` 启动 bg-lead-draft）；`src/process/summary.ts:356-358`（`driver!.registerCtrl?.()` 可选调用静默空转）。
- 问题：为复位 watchdog 手写的包装对象没有 registerCtrl / unregisterCtrl / isRunning / interrupt。self-heal 通过后用它启动后台账本推进草稿，`registered` 为真，但登记落空，ctrl 从未进入真实 driver。
- 触发：带布线的书跑 /auto-write 并通过 → 编排闸释放、'self-heal' ctrl 注销（`stream.ts:753`）→ 后台草稿生成仍在跑 → 作者点「中断」：`stream.ts:587-595` 各项全假，回 `interrupted:false`；该调用只能等自然完成或 10 分钟总超时，照常计费，SSE 快照显示空闲。这正是 `self-heal.ts:731-737` 注释声称已修复的场景；chat 内 write_chapter 路径传真 driver，不受影响。
- 漏测原因：`test/process/r0912-bg-task-interrupt.test.ts:184-234` 直接调 runSelfHeal 并注入带 registerCtrl 的假 driver，没走端点。
- 建议：包装改原型委托（只覆写 emit），或给 runSelfHeal 加 `onActivity` 回调、不再包装 driver；把中断相关能力收为 StudioDriver 必需成员（根因是能力方法全可选，漏委托时编译器不报）；补一条「/auto-write → /interrupt」端点级回归。

**P2-2 自愈编排在服务端事件循环上同步 rebuild + 同步机检**

- 位置：`src/ai/orchestrate/self-heal.ts:211`（同步 `rebuild`）、`:218`（`new DatabaseSync`）、`:230`（默认 check = 同步 `checkWithDb`，每轮重写调用一次）。
- 问题：异步版已就位且他处已切换——`runRebuildAsync`（`src/cache/run-rebuild-async.ts:80`）与 `runCheckForDocumentAsync`（`src/check/run.ts:341`）已被 check 端点、review 端点、chat 的 check_chapter（`src/ai/orchestrate/chat/turns-tools.ts:277`）采用，唯独 self-heal 没切。
- 触发：书在 SMB / 网盘 / 慢 USB 盘上时，/auto-write 起步 rebuild 与每轮机检阻塞 server 进程事件循环，期间全部 API 与 SSE 心跳停摆，前端可能误判断线；批量连写成倍放大。
- 建议：rebuild 改走 `runRebuildAsync`；`ChapterCtx.check` 改返回 Promise，默认实现复用 chat 路径的异步机检。

**P2-3 写工具确认卡看不到参数，15 个工具中 13 个显示英文原名**

- 位置：`web-next/src/components/panels/chat/ChatMessages.vue:125-133`（TOOL_ICONS / TOOL_LABELS 只覆盖 write_chapter、check_chapter）、`:279-312`（工具卡模板）；`web-next/src/stores/chat-dispatch.ts:250-263`（`chat_tool_pending` 已把 input 截到 2000 码点存进卡片，但没有模板读取）；契约 `src/ai/contract/chat.ts:21-37`（15 个工具，10 个写类）；`src/ai/orchestrate/chat/turns.ts:603`（写类工具发出 pending 后阻塞，等作者确认）。
- 问题：确认卡是 AI 写操作唯一的人工关卡，却只显示工具名、状态与确认 / 拒绝按钮；10 个写工具中 9 个没有中文名，界面直接显示 `move_chapter`、`rewrite_selection`、`apply_spill`、`lead_update` 等内部名。
- 触发：模型调用改名 / 移动 / 改写 / 删除类工具时，作者看不到目标章、新名称或改写指令，只能凭英文函数名放行；模型选错目标时这道关卡形同虚设。缓解：delete_chapter 为软删，可从回收站还原；其余写工具的可回退性未逐一核实。
- 建议：契约侧扩成 `TOOL_META`（中文名、风险、参数摘要函数），作为前端唯一来源；卡片按工具显示参数摘要（docId 经章节树解析为章名，另显示新名、目标位置、改写指令前若干字），改写类附 diff 预览。

**P2-4 批量定稿丢掉 gateDegraded，防吃书闸降级放行时仍报成功**

- 位置：`web-next/src/composables/useChapterTreeActions.ts:176-205`（doBatchFinalize 只读 ok / skipped / error）；`web-next/src/api/documents.ts:179-202`（FinalizeOk、BatchFinalizeItem、BatchFinalizeOk 均无该字段）；服务端 `src/studio/server/api/documents-save.ts:208`、`:247`、`:265` 单章与批量逐项均透出该字段。对照单章路径 `web-next/src/stores/doc.ts:614-620` 会弹 warning，但靠 `(r as { gateDegraded?: string[] })` 强转读取，`:616` 注释称「字段面在 FinalizeOk」，与事实相反。
- 问题：防吃书闸（`src/document/finalize.ts:365-399`）在「账本推进文件读取失败」或闸自身抛错时 fail-open 放行，并用 gateDegraded 告知「本轮跳过、已放行定稿」。单章路径把它提示给作者，批量路径完全不感知，类型层也没有这个字段。
- 触发：布线章的账本推进文件读取失败（或闸异常）时，作者批量定稿 N 章，看到绿色「已定稿 N/N 章」；这些章没过闭合比对，作者也不知道要补检。
- 建议：给 FinalizeOk 与 BatchFinalizeItem 补 `gateDegraded?: string[]`，删掉 doc.ts 的强转与错误注释；doBatchFinalize 汇总降级章数与原因，toast 改 warning（如「已定稿 N 章，其中 K 章防吃书检查降级已放行」）。根因见 P3-21。

**P2-5 历史恢复前未冲刷 200ms 正文回写窗口，报「已恢复」实未生效**

- 位置：规则原文 `web-next/src/shared/body-writeback.ts:18-22`（2b 条列举了 4 个「读 dirty 前先冲刷」的调用点，不含历史恢复）；`web-next/src/components/panels/HistoryPanel.vue:104` 直接读 `cur.dirty`，随后 `:115-121` 确认弹窗、`:125` restoreSnapshot、`:131` doc.refresh、`:133` 提示「已恢复」；`web-next/src/stores/doc.ts:489-506` refresh 在 dirty 时保留本地正文并推进基线。
- 问题：正文回写有最长 200ms 的尾随节流，窗口内的键入只在模块待写槽里，`entry.dirty` 仍为 false。凡「先读 dirty 再决定存不存」的地方都要手动先冲刷，而这条规则只存在于注释和逐点列举的测试里。HistoryPanel 漏了——它自己 `:100-103` 的注释描述的正是该窗口会重现的失败方式。
- 触发：作者打字后 200ms 内点「恢复」→ 读到 dirty=false，跳过「先存后恢复」→ 确认弹窗期间定时器到点，条目变 dirty → 服务端写入快照版本 → refresh 保留本地旧稿并推进基线 → 提示「已恢复」，编辑器里仍是旧稿，下一次自动保存用旧稿覆盖刚恢复的版本。快照仍在、可以重试，不算丢数据，但属于「报成功、实际没生效」。
- 漏测原因：`test/studio/webnext/body-writeback-before-dirty-gate.test.ts` 只覆盖列举的 4 个点；`history-restore-dirty.test.ts` 用 mock 条目的 dirty 布尔值，不涉及待写窗口。
- 建议：把规则从约定变成结构，二选一：① 首笔输入即经注入回调同步把条目标 dirty（内容仍节流，各保存链入口本就会冲刷）；② doc store 提供内部先冲刷的 `isDirty(docId)`，组件不再直读 `entry.dirty`。顺带把 `EditorDocHead.vue:215-225` 在组件里直改条目状态（path / name / conflict）的逻辑收回 store action。

### 4.3 P3 详述

**P3-1 注释考古化：修复史挤占代码且开始腐烂**

- 度量：注释行 34,890 / 121,304（28.8%）；含批号标签的注释行 7,484，标签 11,098 个。按目录：document 注释占 37.7%、每千行 131 个标签；check 165.6、learn 163.0、export 162.3；对照 update 7.5。文件榜首：`src/document/service.ts` 392 个标签（注释占 45%）、`src/events/store.ts` 183、`src/state/health.ts` 149。
- 前端：注释占 17.3%，但 220 个源文件中 178 个带批号 / 轮次 / 日期标记；核心文件远高于均值——`useSse.ts` 42%、`useBookSwitchGuard.ts` 41%、`stores/doc.ts` 36%、`prefs.ts` 与 `chat.ts` 各 32%、`CmHost.vue` 30%；`composables/useChapterTreeActions.ts` 头注写明历史记载「原样保留」。
- 典型：`executeSave` 421 行中代码 218 行；`src/ai/provider/openai-adapter.ts:457-475` 用 19 行批号史解释 14 行代码；构建配置同病（`tsup.config.ts` 约 9.8KB 对约 50 行代码，`vitest.config.ts` 约 20KB）。
- 已腐烂的实例：
  - 行号引用失效：`src/ai/orchestrate/self-heal.ts:668` 引 `:796`，实际调用在 `:808`；`src/desktop/main.ts:623` 引 `:235`，该处是无关注释；`src/document/service.ts:734-745` 同类。
  - 文档路径悬空：`src/desktop/main.ts:24`、`src/desktop/workdir-store.ts:7` 引 `Dev/Plans/desktop-workdir-方案.md`，`Dev/Plans/` 目录不存在。
  - 状态过时：`src/studio/server/api/state.ts:140` 称 acknowledge 端点「前端接线另批」，实际 `WbStateCard.vue:84`、`WorkbenchView.vue:220` 早已接线。
  - 生产日志含开发者指令：见 P3-18。
  - 前端过时注释：`web-next/src/api/client.ts:304` 称「25 个 api/ 模块、63 处调用」，现为 28 个模块；`composables/useChapterTreeActions.ts:181` 称「其余 9 个动作」；`views/WorkbenchView.vue:96` 称「对齐本文件 kindReqId」，kindReqId 实在 EditorView；`shared/body-writeback.ts:73` 称「返回是否有待落输入」，函数返回 void；`stores/chat-dispatch.ts:24-25` 称本地副本已删（见 P3-26）。
  - 测试锁注释：`test/studio/webnext/r43-frontend-batch.test.ts:297`、`:308` 断言源码中存在「R43-8（四十三轮）」这类标签原文——删注释即测试变红，清理被测试挡住。
- 影响：现行契约要从修复叙事里打捞；失效引用误导维护；真正有价值的「为什么」被稀释。
- 建议：一轮「只减不加」整理——注释只留现行不变量与不显然的理由，修复史交给 git（commit message 本就是正本）；禁 `:NNN` 行号引用、改引符号名；加一道源码面机器门（仿 check:docs）拒绝新增批号标签与行号引用。

**P3-2 巨型函数与巨类**

- 度量：4,770 个函数中代码行 >100 的 85 个、>150 的 39 个；圈复杂度 >25 的 47 个、>40 的 14 个；嵌套 ≥5 层的 45 个（.vue SFC 的 script 未计入）。
- 代表（代码行 / 圈复杂度）：
  - `src/ai/provider/responses-adapter.ts:224` stream（232 / 83，嵌套 9 层）
  - `src/events/projection.ts:204` validateEventStream（127 / 74）
  - `src/ai/orchestrate/chat/turns.ts:112` runAgentTurns（317 / 72）
  - `src/check/run-tree-issues.ts:183` collectTreeIssuesCore（178 / 66）
  - `src/ai/runner.ts:369` runTask（292 / 62）
  - `src/export/index.ts:254` exportBook（260 / 55，全函数 414 行）
  - `src/events/store.ts:389` firstOpenStore（405 行代码的巨型对象字面量）
  - `src/desktop/server-manager.ts:231` createStudioServerManager（445 行代码）
- 类级：`src/document/service.ts` 1742 行——executeSave `:334-754`、doMoveOrRename `:1079-1316`、doCopy `:1378-1495`、doTrash `:1499-1742`；`src/ai/orchestrate/self-heal.ts` 886 行，`buildRewritePrompt`（`:639-650`）9 个位置参数，同为 string 的参数互换编译器不报。
- 建议：按操作拆命令对象（Save / Move / Copy / Trash 共享显式 DocContext）；exportBook 拆成「收集 → 过滤 → 编号 → 备目录 → 写出 → 投稿视图」管线；runTask 拆 resolve / 重试循环 / 记录三段；ESLint 开 `complexity` 与 `max-lines-per-function`（先 warn，只卡新增）。

**P3-3 依赖环：12 模块强连通 + 5 个运行时文件环**

- 模块级：learn、state、metrics、rag、process、events、install、cache、check、document、git、ai 构成一个强连通分量（统计含 type-only 与动态 import）——核心层之间没有可执行的分层。
- 运行时文件级（排除 `import type`）5 个环：
  - 15 个文件：`ai/pricing`、`ai/provider/` 下 responses / openai / anthropic 适配器与 registry、probe、index、usage-estimate，`ai/runner`、`ai/tasks/spec`、`ai/rules/` 下 index、style-rule、style-remedy，`process/prepare`、`process/summary`；
  - `install/books` ↔ `books-repair` ↔ `books-resolve`；`fs/atomic` ↔ `fs/cross-process-lock`（`atomic.ts:6` 自认）；`check/run` ↔ `check/run-tree-issues`；`studio/server/api/audit` ↔ `stream`。
- 根因是通用工具放错模块：`clipByCodePoints` / `codePointLength` 在 `process/summary.ts`（被 ai/prompts、ai/rules、ai/tools 引用）；`estimateTokens` 在 `process/prepare.ts`（provider 层 `usage-estimate.ts:15` 因此反向依赖编排层）；`runRegisteredBgTask` 在 `process/summary.ts`；锁写函数在记账模块 `ai/calls.ts:336/406`，被 `ai/provider/store.ts:23` 借用；`allHeldTaskGatesFor` 在 audit 模块。
- 影响：最底层适配器传递依赖到编排层；ESM 环初始化顺序敏感；单测难以隔离。
- 建议：码点 / token 工具迁 `shared/`，锁写迁 `fs/`，后台任务登记独立成模块，allHeldTaskGatesFor 回 task-gate；之后上 dependency-cruiser 或 `import/no-cycle` 固化分层。

**P3-4 缺格式化器；ESLint 非类型感知且不覆盖 .vue**

- 仓库无 Prettier / dprint / biome / editorconfig，已出现缩进错乱：`src/document/service.ts:448`、`:1098` 闭包体未缩进；`src/export/index.ts:611-650` try 块体未缩进。
- `eslint.config.js:92-99` 的 TS 块未配 `projectService`，`no-floating-promises` / `no-misused-promises` 等类型感知规则不可用——而代码里 fire-and-forget（如 `void runSelfHeal(...)`）很常见；`.vue` SFC 不在 lint 射程（`eslint.config.js:9`、`:89-90`）。
- 建议：引入格式化器一次性全库格式化（单独提交，配 `.git-blame-ignore-revs`）；TS 块开类型感知推荐集；接 eslint-plugin-vue。

**P3-5 测试资产按批号组织，源码文本断言与固定 sleep**

- 1304 个测试文件中约 41% 以批号命名（后端切片 411 个中 163 个、前端 296 个中约 160 个，如 `test/ai/r26-batch-a.test.ts`、`r30-batch-a`、`r35-batch-a`），同一行为散落多个文件（如 `r37-` / `r44-style-harvest-async` 与 `r0912-2-style-harvest-async-io`），与项目自身「按被测行为命名」的规则相悖。
- 约 35 个测试文件读生产源码文本做正则 / 包含断言（另有 6 个治理测试按源码检查依赖方向，属合理的架构门，不计入）。例如 `test/events/r0911-g-p3-4-close-cache.test.ts`；`test/desktop/r38-exit-guards.test.ts:31-49` 甚至从 ipc.ts 源码里抠出正则再测；`test/studio/webnext/r1010c-fe2-sse-401-selfheal.test.ts:140-149` 断言 Book.vue 源码含 `useSse(() => bookName.value)` 等字符串，`web-next/src/pages/Book.vue:23-26` 注释自述 SSE 看护逻辑因此只能留在页面层——测试反过来决定了代码放在哪。这类断言对无害重构敏感、对语义破坏不敏感，是 P3-1 / P3-2 整理的直接阻力。
- 后端切片 42 个文件共 59 处固定 sleep（如 `test/studio/stream-ticket.test.ts:210`、`cc-owner-ctrl.test.ts:92`），慢腿（尤其 win）有间歇红风险（PLAUSIBLE）。
- 端点级缺口：P2-1 即因测试绕过端点直调编排而漏网。
- 规则靠逐点列举：前端「读 dirty 前先冲刷」由 `body-writeback-before-dirty-gate.test.ts` 逐点列举 4 个调用点维持，列表外的历史恢复（P2-5）因此漏网——列举式测试只能证明列出的点。
- 正面：前端抽样确定性好，真 sleep 后多接 `vi.waitFor`，重试链借可注入的 sleep 变成纯微任务。
- 建议：按行为合并重命名；源码文本断言改行为断言或导出纯函数直测；sleep 改 `vi.waitFor` / 事件钩子。

**P3-6 测试缝渗入生产代码，模块级单例多**

- `testableConst` 127 处；后端切片导出测试钩子 74 个（`analysis.ts` 12、`snapshots.ts` 11、`settings.ts` 10，`ttl-cache.ts` / `desktop/main.ts` / `provider/store.ts` 各 6）；`src/ai/runner.ts:492-513` 读 `CLWRITING_DRIVER` 环境变量切 mock；`src/studio/server/index.ts:540-551` 猴补 `server.close`。
- 根因：状态放在模块级单例（router `activeRoutes`、task-gate `lockRoot`、review `reviewRunning`、runner 降级回调表、store 回调注册），测试只能靠导出钩子改写；只有 server-manager 做到了依赖注入。
- 建议：`createStudioServer(deps)` 组装根注入 gate / registry / driver；mock driver 只在组装根选择，不在 runner 内判断。

**P3-7 覆盖率阈值贴线，win 本地跑不过**

- 本机 `vitest --coverage`：src/fs 分支 88.92%（阈值 89%）、src/rag 87.86%（阈值 88%）两项红。阈值按 ubuntu 腿校准，win32 平台守卫跳过的分支使覆盖率偏低，余量只有 0.1 个百分点级。
- 影响：win 开发者本地无法用覆盖率门自检；阈值贴线，任何小改动都可能让 CI 红。
- 建议：阈值留 1–2 个百分点余量或按平台分档；Library.vue、Welcome.vue、LearnView.vue 三个零覆盖视图补组件测试或显式排除。

**P3-8 DocumentService 机械拆分：剥 private、留转发桥**

- 为把元数据操作拆到 `service-meta.ts`，`src/document/service.ts` 把字段剥去 private、改标 `@internal`（`:205-214`、`:289`、`:838`、`:872`、`:1078`），并在 `:70-81` 保留 re-export 转发桥。
- 影响：封装削弱（任何模块可改内部状态）；拆出的文件仍与主类双向耦合，读者在两个文件间来回跳。
- 建议：拆职责而非拆文件——提取 DocContext（锁、清单、journal、快照）作显式依赖，各操作成为独立模块函数；转发桥收敛为调用方直引。

**P3-9 journal 全文快照只写不读，与前端未保存镜像职能重叠**

- `src/document/journal.ts` 每笔保存把全文快照（≤256KB）写进 journal；但 `:135-142` 注释自承 pending.content「全仓零程序性消费方」——两个读取方（`src/state/health.ts:177`、`src/studio/server/api/state.ts:172`）只用 opId。
- 为这份无人读取的数据付出了大量复杂度与 IO：头尾截断降级（`:87-102`）、惰性构造（`:124-134`）、256KB 闸、compact 尾段补追（`:519-597`）、降级写 inode 自校验（`:384-429`），以及每笔保存一次 journal 追加 + fsync。
- 作者侧唯一出口是 crashedWrite 提示（`health.ts:216-224`），叫作者「对照 工作区/.journal 下的快照残片补回」——要小说作者手读 JSON 转义的隐藏 JSONL；点「忽略此提醒」后写 aborted，下次 compact 即丢弃快照。实际承担未保存恢复的是前端 localStorage 镜像（`web-next/src/shared/dirty-mirror.ts`、`stores/doc.ts:201-220`）。
- 建议二选一：① 给 crashedWrite 卡片加「查看 / 导出快照」（与盘上现状对照、导出为 .md），让快照有消费闭环；② journal 只记 opId / baseRevision，删去快照相关全部机制，恢复职责明确交给前端镜像 + 版本历史。

**P3-10 导出同名产物归档失败仍覆盖，警告却称「已保留原位」**

- 位置：`src/export/index.ts:550-553`（全本）、`:640-647`（投稿视图）；警告文案 `:241-243`。
- 问题：同名旧产物先 `archiveOldExport`，失败时记警告「已保留原位，请手动移入 .旧版/」，随后原子写照常 rename 覆盖原文件——警告失实，作者手改过的导出稿被销毁。同文件的分章目录（`:460-486`）已对同类场景改为「写入带序号新目录、不覆写原目录」，全本与投稿视图两处没有对齐。
- 触发面：归档失败而覆盖成功，例如 `导出/.旧版` 被同名普通文件占据导致 mkdir 失败；文件被占用时两步通常同败，故触发面窄。
- 建议：归档失败时改写带序号的新文件名，或放弃本项并报错，与分章目录口径一致。

**P3-11 小型重复与类型谎言**

- `src/fs/atomic.ts:170-187` 与 `:268-283` 的 tmp 写 + fsync 块重复；`atomic.ts:75` `return undefined as T`（onExhausted 分支对泛型撒谎）；`src/fs/cross-process-lock.ts:116`、`:281`、`:352` 三处内联 `Atomics.wait`，而同文件已 import `fsBackoffSleep`。
- `src/events/store.ts` 的 appendEvents 与 appendEventsResolveLineage 事务样板重复。
- `src/studio/server/static.ts:156-171`、`:202-213`、`:253-262` 安全响应头字典三份（改一处漏两处即部分响应缺头）；`src/desktop/main.ts:357` 与 `:629-638` devUi 判定两份；`src/ai/provider/openai-adapter.ts:73-82` `createOpenAIProvider` 纯别名。
- 建议：各抽单点；`undefined as T` 改返回 `T | undefined` 或用重载表达。

**P3-12 忙闸互斥矩阵约 7 处手写，已漂移**

- 位置：`src/studio/server/api/stream.ts:484-513`（spawn）、`:626-685`（auto-write，await 前后各写一遍）；`chat.ts:48-63`；`task-gate.ts:249-259`；`audit.ts:225-249`；`books-lifecycle.ts:304/323`；`documents-core.ts:305-318`；`review.ts:109-134`。
- 已见漂移：`review.ts:130-133` 的书级任务闸按「书 + 动作」取键，只会与同书另一文档的三审冲突，409 文案却说「本书有其他任务在跑」，且 `:120-125` 的按文档内存闸被书级闸吞掉、形同虚设；`stream.ts:627` 与 `:668` 同一句文案一处半角逗号一处全角逗号。
- 影响：每新增一种长任务要改齐约 7 处，漏一处即互相踩踏；409 原因不准。
- 建议：收敛为表驱动的 `busyReason(book, intent)`，各端点只调一次；allHeldTaskGatesFor 迁回 task-gate（同时解掉 audit ↔ stream 环）。

**P3-13 输入校验两套纪律；providers.models 漏校验**

- 115 个 defineRoute 中只有 15 个用 `parse`，约 36 处内联 readJson 后直接 `as` 断言（如 `style.ts:134/168/231/260`、`files.ts:125`、`snapshots.ts:480`、`books.ts:122`、`settings.ts:296`）；parse 在 handler 前执行却没有「parse 前置闸」钩子，有端点被迫绕开（`stream.ts:650-652`）。
- 具体漏洞：`src/studio/server/api/providers.ts:406-421` 的 models 端点对 protocol / auth 只做 `as` 断言、不校验 baseUrl scheme，而同文件 `parseProviderInput`（`:565-580`）已有三选一与 scheme 校验，注释明言是为防「listModels / probe 打错目标」——models 端点恰恰直接调 listModels。
- 影响：非法 protocol 或缺 scheme 的 URL 以 500 GEN_FAIL 返回而非明确 400（有 token 闸，不构成越权）。
- 建议：抽共享的连接参数校验；给 defineRoute 加前置闸钩子后按模块族迁移存量内联校验。

**P3-14 任务闸锁文件名用不可逆哈希，衍生两张注册表**

- 位置：`src/studio/server/api/task-gate.ts:81-83`（文件名 = 截断的 sha256(key)）、`:173-199`（KNOWN_ACTIONS 与 GATED_ACTIONS）、`:221-239`。
- 问题：锁目录不能自描述，跨进程要查「本书有哪些任务在跑」只能拿已知动作表逐个哈希探测，于是需要两张表 + 治理测试防漏登记；排障时也无法从文件名看出持有者。
- 建议：文件名改 `${action}.${hash(book)}.lock`，列目录即可枚举，两张表与对齐测试可删。

**P3-15 三个适配器流尾收口复制粘贴，stopReason 未归一**

- 位置：`src/ai/provider/openai-adapter.ts:477-486` 与 `:517-526`（content_filter 块两份）、`:348-357` / `:511-515` / `:544-557`（usage 估算三份）；`anthropic-adapter.ts:441-450` 与 `:469-478`（refusal 块两份）、`:455-467` / `:491-500`（usage 估算两份）。
- 问题：done 事件、截断估算、过滤 / 拒答、usage 兜底在每个适配器内部重复 2–3 次，三个适配器之间再各写一份；stopReason 未归一（`anthropic-adapter.ts:428-432` 自注），`src/ai/runner.ts:134-183` 只能鸭子类型兜底、默认 `'end_turn'`。
- 建议：抽 `StreamFinalizer` 统一产出 done / error 并归一 stopReason 枚举——adapter-errors 已证明这条路可行。

**P3-16 类型安全在边界打折**

- OpenAI 系请求参数先构造成 `Record<string, unknown>` 再 `as unknown as` 转 SDK 类型（`openai-adapter.ts:148-229`、`:322`；`responses-adapter.ts:258`），SDK 形状校验失效；anthropic 侧 toParams 有类型可作对照。
- `src/ai/runner.ts:134-183` 对 `unknown` 结果鸭子类型抽取；StudioDriver 能力方法全可选，`task-gate.ts:318-323` 自承缺失时 fail-open——P2-1 就是「可选能力被静默丢弃」的实例。
- 盘上数据未校验即断言：`src/document/trash.ts:199` `(o.role as DocumentRole) ?? 'note'`，任意字符串原样进入角色联合类型。
- 建议：OpenAI 参数按 SDK 类型构造、扩展字段用交叉类型；runTask 结果定义判别联合；driver 拆出必需能力接口；盘上枚举字段读入时校验。

**P3-17 server-manager 以 12 个闭包变量拼隐式状态机**

- 位置：`src/desktop/server-manager.ts`（正确性证明写在注释 `:645-658`）。
- 问题：启动 / 重启 / 退避 / 停止由多个布尔旗与计数器组合表示，合法组合只存在于注释里的证明；新增状态时容易出现非法组合，编译器与测试都无法穷举。
- 建议：显式 `State` 联合类型 + 转移表，旗值由状态派生。

**P3-18 KEK v2 搁置成死分支，启动日志含开发者指令**

- 位置：`src/desktop/os-kek.ts:82`（`OS_KEK_SHELVED = true`）、`:105-111`；`src/ai/provider/vault-key.ts:16-27`。
- 问题：v2 整条路径在发行版不可达，1.0 的静态密钥保护只有混淆级（代码如实写明了威胁模型）；每次启动 warn 一条「恢复 = os-kek.ts OS_KEK_SHELVED 改 false」，是写给开发者的修改指引。
- 建议：该日志降为 debug 并去掉内部指令；v2 隔离到特性开关模块；对外说明写明混淆级保护。

**P3-19 SSE `?token=` 过渡回退通道仍在用；连接状态靠十个标志位手工复位**

- 位置：`src/studio/server/api/stream.ts:248-264`；`src/studio/web-next/src/composables/useSse.ts:46-58`、`:259-282`（回退）、`:97-137`（标志位）、`:285-297` 与 `:365-378`（两段复位）。
- 问题：
  - 一次性 ticket 已上线，但换票失败（含网络抖动、瞬时 5xx）时仍回退为把长期有效的 studio token 拼进 URL；服务端注释写的移除条件至今未达成，`useSse.ts:272-275` 注释称 e2e 依赖该回退。前后端同在一个安装包、同版本发布，不存在「服务端尚未上 ticket」的错配，「过渡期兼容」没有实际兼容对象。服务端只在 SSE 路径接受 `?token=`（`src/studio/server/index.ts:425-430`），日志已剥 query（`http.ts:112-116`），风险低。
  - 连接状态由 errorCount、backoffStep、busy429Notified、probing429、ticketFallbackWarned、devMismatch 两项、reboot401 三项共 10 个标志位拼成，复位逐行抄在 onopen 与 connect 两处（其中 7 个重复），新增标志时容易漏掉一处。
- 建议：两端一起删除回退通道，e2e 改用 ticket，换票失败并入现有退避；连接状态收成显式状态对象，只用一个 `resetEpoch()` 复位。

**P3-20 切书安全靠「先切后回滚」与每次 await 手写书名复检**

- 定级说明：子评审原判 P2；机理成立但无现行触发，按第〇节严重度口径降为 P3。
- 位置：`web-next/src/composables/useBookSwitchGuard.ts:56`（手写 bookGen 计数器）、`:104-111`（注释自述：确认弹窗出现时路由已切到目标书、SSE 已连上、事件已写进 store，取消只能清空、回退、重新同步）、`:116` 起的 watch 链叠了多层修复；`web-next/src/composables/useChapterTreeActions.ts:77-88`（stillIn / failScoped，注释自列 5 次因漏配守卫出过的 bug）；`web-next/src/api/client.ts:267` 注释承认 signal 联动「当前全库无调用方传」。
- 问题：「书会话」没有独立的生命周期对象，隔离迟到结果的责任落在每个异步动作身上，每次 await 后都要手写 `if (bookName !== book) return`；取消能力已写好，却没有接到切书上。
- 影响：每个新异步动作都可能漏；「先切后回滚」让确认期间的 SSE 事件先写进目标书的 store，需要 clearEventStores 善后。
- 建议：在路由提交前（`beforeEach` / `onBeforeRouteUpdate`）完成冲刷与确认，作者取消就不切，整段回滚逻辑可删；引入 `BookSession { name, signal, stillIn() }`，进书创建、离书 abort，API 调用带 `session.signal`，迟到结果由 AbortError 统一吸收。

**P3-21 回包类型与子组件接口手抄，无共享契约**

- 位置：`web-next/src/api/*.ts` 回包类型全部手写；漂移实例 `api/documents.ts:179-202` 对照 `src/studio/server/api/documents-save.ts:208/247/265`（即 P2-4）；工具名未从 `src/ai/contract/chat.ts` 派生（即 P2-3）；`web-next/src/views/EditorView.vue:179-191` 手写复制 CmHost 经 defineExpose 暴露的接口。
- 问题：前端并非不能引用根目录代码——`stores/chat-dispatch.ts:26` 已 import 根 `src/shared/text`，通路现成；但回包形状全靠手工同步，服务端加字段时前端不报错，只静默缺失。
- 建议：回包类型放 `src/shared/contract/`（或由服务端导出 type-only 模块）两端共用；需运行时校验的用 schema 同时生成类型与校验，`sse-guards.ts` 的手写校验可一并迁入；CmHost 导出 interface 用于 `defineExpose<…>`，或父组件用 `InstanceType<typeof CmHost>`。顺带：`EditorView.vue:37-43` 的 isReviewable 读取第 43 行才声明的 entry（computed 惰性求值故能运行，但阅读顺序是反的）。

**P3-22 两个对话框绕开遮罩登记：⌘P 盖在对话框上、win 窗控不变暗**

- 位置：`web-next/src/components/panels/ChapterMetaDialog.vue:115-123`（`.meta-mask`，z-index 100）、`SplitChapterDialog.vue:91-97`（`.split-mask`）；`web-next/src/stores/ui.ts:83-91` overlayStates 未登记二者；`web-next/src/composables/useHotkeys.ts:38` ⌘P 只看 `ui.overlayOpen`；`components/ui/CommandPalette.vue:219-223` z-index 150。
- 问题：遮罩状态、Windows 窗控（WCO）变暗、热键屏蔽都依赖在 ui store 登记，这两个全屏遮罩只写了自己的 CSS。遮罩 alpha 在 `ui.ts:22-32` 的 MASK_ALPHA 与各组件 CSS 里写了两份，靠 `test/studio/webnext/j5-overlay-dim.test.ts` 读 CSS 原文对账，且只覆盖已登记的 7 个。
- 触发：打开「章节属性」或「拆分」对话框后按 ⌘P，命令面板盖在对话框上（150 > 100）；Windows 下标题栏窗控保持高亮，与页面遮罩不一致。
- 建议：抽 `<ModalMask kind>` 组件，挂载即登记、alpha 从 ui store 读（只留一份），所有对话框改用；CSS 重复值与读 CSS 的测试随之删除。

**P3-23 RAG 轮询失败终止不重置连败计数，重建后首败即停**

- 位置：`web-next/src/components/ui/SettingsBookAnalysis.vue:349-385`（pollRagStatus 内 3 段内联停止代码）、`:387-397`（只有 stopRagPolling 重置 ragPollInFlight 与 ragFailStreak）、`:307-322` / `:332-347`（startRagBuild / startRagRebuild 不重置）。
- 问题：「停止轮询」一个动作有 4 份实现，失败终止那份（`:369-375`）漏了连败计数重置。
- 触发：索引构建轮询连败达上限后终止 → 作者点「重建」重试 → ragFailStreak 仍停在上限 → 新一轮轮询首次失败即终止（本应容忍到上限），作者看到「重建很快又失败了」。
- 建议：所有停止路径统一调 stopRagPolling，start* 入口重置计数；进一步抽 `usePolling({ interval, maxFails, tick })`，集中在途标志、连败计数、退避与组件激活 / 停用。

**P3-24 workspace store 兼作事件总线与函数注册表**

- 位置：`web-next/src/stores/workspace.ts:49-57`（createTick、pendingInsert {text, tick} 用递增 tick 模拟一次性事件，注释记录过丢信号）、`:58-61`（editorGetSelection / editorGetCursorOffset 函数存进 store）、`:40-44` 与 `:401-410`（三个联合类型字面量各写两遍）、`:244-254`（书级偏好关窗时未追踪在途写入，prefs.ts 已有同类的 putInFlight）；`components/shell/WorkspaceShell.vue:49-55` 把 `wb.warning` 当事件通道，读完置 null，并以 `'error'` 类型 toast 显示 warning。
- 影响：丢信号的 bug 已出现过两次；联合类型改一处漏一处，编译器不报；警告显示成错误。
- 建议：导出 `type ActiveView = …` 等类型别名；一次性命令改用类型化事件总线，或由 EditorView provide 一个 `EditorHandle`；书级偏好补在途追踪；warning 改用 'warning' 类型。

**P3-25 prefs store 暴露 76 个成员，职责过宽**

- 位置：`web-next/src/stores/prefs.ts:729-806`（return 暴露 76 个成员，其中 34 个 setter 逐个平铺）；`:565` `const baseStep = 0` 恒零加数。
- 问题：807 行同时负责外观偏好、写作与建书默认值、AI / 机检阈值、书级覆盖合并、持久化、写 DOM 与窗控变暗；`:325` 的 PREF_ROWS 已经是表驱动，对外接口却没有跟上。
- 建议：按领域拆 store，或暴露基于 PREF_ROWS 的泛型 `get / set(key)`；写 DOM 与窗控变暗拆成 composable；删 baseStep。

**P3-26 已有共享工具未替换旧写法：小型重复与内部状态外露**

- 防竞态：`composables/useStaleGuard.ts` 已在 workspace、WorkbenchView、useSse 使用，`views/EditorView.vue:47-62`（kindReqId）、`editor/CmHost.vue:425`（compReqId）、`composables/useBookSwitchGuard.ts:56`（bookGen）仍手写计数器；CmHost 同一段补全映射写了两遍（`:435-438`、`:470-473`）。
- 字数防抖：`composables/useDebouncedWordCount.ts` 头注称由 EditorView 的字数防抖推广而来，`EditorView.vue:128-150` 自己却仍用手写副本；EditorView、FocusStatsBar、WritingInfoPanel、HistoryPanel 各有定时器，对同一正文各算一次（MB 级长章的性能代价 PLAUSIBLE）。
- 截断函数：`stores/chat-dispatch.ts:24-25` 注释称本地副本已删，`:65` 的 clipByCodePoints 仍在；唯一来源 `src/shared/text.ts:34` 已被 AuditEventList、StyleEntryPanel 使用。
- 书级 URL：api 层 `/api/books/${encodeURIComponent(…)}` 模板 78 处，api 层之外 `composables/useHeartbeat.ts:52/100`、`useSse.ts:284` 另有拼接点。
- 样式：`.spin` 在全局 `styles/utilities.css` 与 7 个组件内共定义 8 次，时长有 0.8s / 0.9s / 1s 三种；遮罩 alpha 在多个组件写死；同一 `--text-warning` 在 `StartupNoticeBanner.vue:77/84` 与 `WbDraftCard.vue:85` 回退到不同色值（token 已在 base.css 定义，回退值只会掩盖拼写错误）。
- 内部状态外露：`api/client.ts:127-135` 导出签名 `apiFetch(path, init, _retried, _gauge?, _replayed?)`，把递归重试与计量状态暴露给调用方；`:114-125` 对 PUT 做 `JSON.parse(body)` 找 operationId，来猜这个请求能否重放。
- 建议：统一改用 useStaleGuard 与 useDebouncedWordCount（字数作为以 docId + content 为键的派生值只算一次）；chat-dispatch 改 import 共享实现；提供 `bookUrl(name, ...segments)`，心跳与 SSE 的 URL 构造移入 api/；删组件内 `.spin` 与已定义 token 的回退值；apiFetch 对外只留 `(path, init)`，内部递归走私有函数，可重放性由调用方显式声明。

**P3-27 在途对话回合以数组下标追踪**（PLAUSIBLE）

- 位置：`web-next/src/stores/chat-dispatch.ts:101`（ChatTurnState.currentIdx），`:168`、`:246`、`:255`、`:289-297`、`:326`、`:348` 以 `messages.value[turn.currentIdx]!` 写入，`:375` 裁剪时手工偏移；`stores/chat.ts:398-408` 截断后重定位。
- 问题：下标是派生信息，任何裁剪、过滤、插入漏了重定位，增量就会写进别的消息；`!` 断言让越界在类型层不可见。目前各变动点都维护了下标，未找到现成触发。
- 建议：改记消息 id 再查找，或直接持有那条响应式消息对象的引用。

## 五、分模块小结

| 模块 | 评价 | 主要问题 |
|---|---|---|
| fs | 优：原子写、锁、路径防御扎实 | 小重复（P3-11）；与 atomic 互环（P3-3） |
| document | 良：逻辑正确、防御到位 | 巨类与机械拆分（P3-2、P3-8）；注释密度全库最高（P3-1）；journal 快照无消费（P3-9） |
| events | 良 | firstOpenStore 巨型字面量、事务样板重复、源码扫描测试钉死形态（P3-2、P3-5、P3-11） |
| format | 良：手写 YAML 字节保真，取舍自洽 | 维护成本高，靠测试兜底 |
| export | 良：信封契约完整、流式导出 | exportBook 单函数 414 行（P3-2）；同名覆盖（P3-10）；缩进错乱（P3-4） |
| install / state / check / rag / cache | 良 | 高圈复杂度函数集中（collectTreeIssuesCore、buildIndex、commitIndexBatch）；注释密度高 |
| update | 优：全库最清爽 | — |
| studio/server | 良：请求闸、错误信封、静态文件路径防御扎实 | 忙闸矩阵、校验两套、测试缝与单例（P3-12、P3-13、P3-6）；stream.ts 一文件承担 spawn / auto-write / interrupt / SSE 四职 |
| desktop | 优：安全基线最好 | 隐式状态机、KEK 搁置（P3-17、P3-18） |
| ai/provider | 良：adapter-errors、vault、store 质量高 | 流尾复制、OpenAI 参数弱类型（P3-15、P3-16） |
| ai/orchestrate | 中：最复杂、修复最密 | P2-1、P2-2；self-heal 与 runAgentTurns 过大 |
| ai 其余（prompts / tools / rules / contract） | 良：单一咽喉兑现记录纪律 | 与 process 互环（P3-3） |
| process | 中：业务管线清晰 | 混入通用工具导致 ai 反向依赖（P3-3） |
| web-next：components | 良：体量适中（最大脚本段约 430 行），安全面干净 | 工具确认卡缺参数（P2-3）、历史恢复漏冲刷（P2-5）、遮罩登记不全（P3-22）、手写轮询（P3-23）、样式重复（P3-26） |
| web-next：stores | 良：doc / chat / chat-dispatch 每次 await 后复检，本地未保存镜像兜底崩溃恢复 | prefs 职责过宽（P3-25）；workspace 兼作事件总线（P3-24）；回合按下标追踪（P3-27） |
| web-next：composables | 良：useStaleGuard、useUnloadFlush 是范例，清理普遍到位 | useSse 标志位（P3-19）；切书补丁链（P3-20）；useRelationGraph 655 行，加载 / 布局 / 交互混在一起 |
| web-next：api | 良：apiJson 错误码、超时、401 自愈齐全 | 回包类型手抄已漂移（P2-4、P3-21）；URL 拼接重复、内部参数外露（P3-26） |
| web-next：shared / editor | 优：body-writeback、dirty-mirror 零依赖；CmHost 的输入法与撤销历史处理是前端技术含量最高处 | 「读 dirty 前先冲刷」无法由模块自身强制（P2-5）；CmHost 手写计数器与重复映射（P3-26） |
| web-next：views / pages | 中：逻辑清楚 | 修复注释与手写计数器最集中（P3-1、P3-26）；Book.vue 的代码位置被源码文本测试反向锁住（P3-5） |

## 六、度量附录

### 6.1 门实测（本机 Windows 11）

| 门 | 结果 |
|---|---|
| tsc（根）/ vue-tsc（web-next） | 通过 |
| eslint | 通过 |
| check:counts | 通过（1304 测试文件 / 8116 用例；33 e2e spec / 54 用例） |
| check:docs / check:packaging / check:knowledge | 通过 |
| vitest --coverage | 用例全绿：1296 文件通过 / 8 跳过，7965 例通过 / 76 跳过，耗时 348.6s；覆盖率门红 2 项（P3-7） |
| e2e（playwright） | 本轮未跑 |

覆盖率（全库）：Statements 88.10%、Branches 79.74%、Functions 87.21%、Lines 91.06%。

### 6.2 规模

| 区域 | 文件 | 行 |
|---|---|---|
| 后端 .ts（src，除 web-next） | 336 | 约 8.0 万 |
| web-next .ts | 104 | 约 1.4 万 |
| web-next .vue | 111 | 约 2.7 万 |
| 测试（test/，含 33 个 e2e spec） | 1304 + 33 | 约 20.3 万 |

测试代码与生产代码之比约 1.7 : 1；运行时依赖 3 个。

### 6.3 类型纪律

`any` 0；`@ts-ignore` 0；`as unknown as` 17；`eslint-disable` 1；TODO 1。

### 6.4 注释与批号标签（按目录，节选）

| 目录 | 行 | 注释占比 | 标签 / 千行 |
|---|---|---|---|
| studio/web-next | 41,063 | 17.3% | 53.3 |
| studio/server | 14,539 | 32.8% | 124.1 |
| ai | 14,504 | 35.0% | 93.5 |
| document | 9,751 | 37.7% | 131.1 |
| desktop | 6,246 | 39.4% | 111.3 |
| check | 4,824 | 38.8% | 165.6 |
| export | 733 | 41.2% | 162.3 |
| update | 265 | 29.8% | 7.5 |
| 全库 | 121,304 | 28.8% | 91.5 |

### 6.5 函数复杂度（TS AST，按区域）

| 区域 | 函数数 | 代码行 >80 | 圈复杂度 >25 |
|---|---|---|---|
| web-next（.ts） | 928 | 28 | 6 |
| studio/server | 754 | 32 | 6 |
| ai | 591 | 15 | 11 |
| desktop | 437 | 5 | 0 |
| format | 424 | 1 | 5 |
| document | 409 | 11 | 4 |
| process | 205 | 2 | 1 |
| events | 150 | 3 | 1 |
| check | 148 | 4 | 3 |
| rag | 91 | 3 | 3 |
| install | 90 | 2 | 2 |

### 6.6 依赖环

见 P3-3：模块级 1 个强连通分量（12 模块）；运行时文件级 5 个环（15 / 3 / 2 / 2 / 2 个文件）。

### 6.7 测试资产

批号命名约 41%（前端 296 个中约 160 个）；读生产源码文本做断言约 35 个文件（另 6 个治理测试属架构门）；固定 sleep 59 处 / 42 文件（后端切片）；平台守卫跳过约 99 处。

## 七、建议

### 7.1 发版前（收口必需）

- 修 P2-1 至 P2-5，各补一条端点 / 组件级回归测试；L2 全量回归后收口。
- P2-5 建议按结构化方案修（首笔输入同步标 dirty，或 `isDirty()` 内置冲刷），不要只给 HistoryPanel 再补一个冲刷点；P2-4 顺带补齐回包类型字段，作为 P3-21 的第一步。

### 7.2 1.0 后第一轮「只减不加」整理（按收益 / 成本排序）

1. **工具链先行**（P3-4）：格式化器 + 类型感知 lint + .vue lint——成本低，立刻挡住新债。
2. **注释瘦身 + 源码面机器门**（P3-1）：先拿标签最密的 10 个文件开刀，同步改写钉住源码文本的测试（P3-5）。
3. **解环**（P3-3）：迁移四组错位工具，随后上依赖规则门。
4. **横切收敛**（P3-12、P3-13、P3-15、P3-26）：busyReason 表驱动、defineRoute 前置闸 + 共享校验、StreamFinalizer；前端统一改用已有的共享工具。
5. **前端规则落结构**（P3-19、P3-20、P3-21、P3-22）：BookSession + signal、共享回包契约、ModalMask 组件、SSE 连接状态对象——把靠逐点列举维持的规则变成结构保证。
6. **拆巨型**（P3-2、P3-8、P3-17、P3-25）：DocumentService 命令化、exportBook 管线化、runTask 三段化、server-manager 显式状态机、prefs 按领域拆分。
7. **测试整理**（P3-5、P3-6）：按行为合并重命名；组装根注入替代导出测试钩子。

### 7.3 纪律建议

- 修复只落代码与测试，叙事进 commit message——项目对文档已有「正本 = git 历史」的约定，源码注释尚未执行。
- 修一处必检索同构路径：P2-1、P2-2、P2-4、P2-5、P3-10 都是「同类场景只修了其中一处」。
- 靠列举维持的规则，要么落成结构，要么配一道能枚举全部调用点的机器检查——逐点列举的测试只能证明列出的点。

## 八、处置记录

### 8.1 P2 修复批（2026-09-24，基线 `5f57a527` 工作树上直接落地）

| ID | 修复形态 | 回归测试 |
|---|---|---|
| P2-1 | 端点不再包装 driver：编排进度改经 `SelfHealOpts.onActivity` 回调复位 watchdog，真 driver 直通——中断能力无转发面可漏（报告 4.2 的备选形态，比原型委托更彻底） | `test/studio/auto-write-interrupt.test.ts`（真实 server + cc driver + 假 provider：编排通过后 `/interrupt` → `interrupted:true`、后台草稿收口）；`self-heal.test.ts`「onActivity 与 driver.emit 逐事件一一对应」 |
| P2-2 | 开库改 `openCheckDbAsync`（rebuild 内核经 `runRebuildAsync` 入 worker）、机检体改 `driveToEndAsync(checkWithDbCore)`——与 check 端点、chat `check_chapter` 同一条异步链；db 句柄单一 `finally` 收口 | `test/studio/self-heal-check-async-chain.test.ts`（两处异步入口 spy 计数：归零即「该腿被改回同步」） |
| P2-3 | 契约侧新增单源 `src/ai/contract/tool-meta.ts`（`TOOL_META` = 中文名 + 风险 + 参数摘要；前端只渲染，章名经章节树解析）；工具确认卡按工具显示参数摘要 | `test/ai/tool-meta.test.ts`（7 例）；`chat-panel.test.ts` 参数摘要 3 例；`chat-dispatch-state-machine.test.ts` 入参截断 4 例 |
| P2-4 | `FinalizeOk`/`BatchFinalizeItem` 补 `gateDegraded?: string[]`；删 `doc.ts` 的类型强转与失实注释；`doBatchFinalize` 汇总降级章数、toast 转 warning | `test/studio/webnext/batch-finalize-gate-degraded.test.ts`（3 例） |
| P2-5 | 按报告建议 ① 落结构：首笔输入即经注入回调同步标脏（`registerBodyWritebackDirty` → doc store `markEntryDirty`），内容仍按 200ms 窗口节流；HistoryPanel 恢复前冲刷；`EditorDocHead` 直改条目状态改走 store action | `test/studio/webnext/history-restore-pending-writeback.test.ts`；`editor-body-writeback` / `before-dirty-gate` 两组随口径更新 |

收口批同日追加（复核中发现的修复自身残余，一并处置）：

- **P2-3 残余**：`clipToolInput` 由整串截断改**字段级**截断（额度按键数均分、键结构保留）——超限入参（长改写指令 / 整章正文，恰是最需要核对的一批）的工具卡摘要不再整条落空；字段级不成立（无字符串字段可截 / 截断后仍超闸）才退回整串截断，内存闸恒为准。该文件内的 `clipByCodePoints` 本地副本删除，统一引 `shared/text.ts` 单源（兼收 P3-26 该分项）。
- **P2-2 关联缺口**：`/auto-write` 登记进 server 在途工作表（`trackInFlightWork`，先例 = rag 的 `buildIndex`）——`server.close()` 收尾此前只等连接清空，而本端点 200 先回、编排后台跑，close 后编排仍持会话库（`<userData>/clwriting/session/*.db`）句柄在写，调用方立刻 `rmSync` 临时目录在 Windows 落 EPERM。e2e `auto-write.spec.ts:135`（批量连写）在 P2-2 改变编排时长后由潜在转为确定性红，即由本条修复收口。
- P2-1 端点测试随形态更新：不再断言「包装存在」，改为钉「真 driver 直通」端到端通道（任何丢中断能力的改法仍会红）。

变异验证（逐处临时回退 → 对应用例变红 → 恢复，全批执行）：

| 项 | 回退动作 | 结果 |
|---|---|---|
| P2-1 | 恢复四成员包装 driver | 端点用例 30s 超时红 |
| P2-2 | ① 同步 rebuild + `new DatabaseSync`；② 机检体换同步 `driveToEnd` | 两腿各红一次（异步入口 spy 归零） |
| P2-3 | 去掉字段级分支 | 2 例红（含作者可见的卡牌用例） |
| P2-4 | 回退降级聚合 | 3 例中 2 例红 |
| P2-5 | 标脏 / 冲刷两半各自单独回退 | 均仍绿（复合锁：测试钉结果不钉机制，已知并记） |

已知取舍（如实记账）：

- P2-5 的同步标脏是**悲观**的：窗内净编辑为零（键入后又撤销回原文）时脏位留到下次保存，代价至多一次内容等值的写入。不引入「反标脏」——它会误清他处写者（元数据表单等）置的脏，风险大于收益。已写入 `body-writeback.ts` 不变量 2c。
- P2-2 起 rebuild 走 worker，默认 120s 超时：超时后 `/auto-write` 以 failed 收口（与 check 端点同口径），此前同步实现会无限期阻塞。超时档可经 `CLWRITING_REBUILD_TIMEOUT_MS` 调大。

门实录（本机 Windows 11，收口批后）：

| 门 | 结果 |
|---|---|
| tsc（根）/ vue-tsc | 通过 |
| eslint（`lint` 全库 `--max-warnings 0`） | 通过 |
| vitest 全量 | 1301 文件通过 / 8 跳过；7986 例通过 / 76 跳过，退出码 0 |
| e2e（playwright，33 spec） | 51 用例通过 / 3 跳过（首轮 1 例红 = 上述在途登记缺口，修复后复跑全绿） |
| check:counts / docs / packaging / knowledge | 四项通过（README 计数随批同步：1309 文件 / 8137 单测） |

### 8.2 P3 修复批 R0916-7（2026-09-25 起，基线 `cb483819` 工作树）

作者拍板 1.0.0 前 27 条全修（本节随批滚动补记）；**发版仍待作者确认，本批不推 tag、不动版本号**。

#### 波 A（2026-09-25）

| ID | 修复形态 | 回归测试 |
|---|---|---|
| P3-10 | `archiveOldExport` 返回成败；归档失败时全本/投稿视图产物改写 `nextFreeName` 序号兜底名（`-N` 递推，与分章目录「分章-N」不覆写口径同族），警告改为「本次产物改写入 X，不覆写原产物」——警告与事实一致，手改导出稿不再被销毁 | `test/export/r38-overwrite-archive.test.ts` 新增 3 例：归档失败→序号兜底 + 原稿保全 + 双警告；归档成功→仍写原名无 `-2`；短篇视图同型 |
| P3-23 | pollRagStatus 内 3 段内联停止收编 `stopRagPolling()`（「停止轮询」4 份实现 → 1 份出口）；`stopRagPolling` 补 `ragFailStreak = 0`；`startRagBuild`/`startRagRebuild` 入口归零——失败终态后重建不再继承连败计数 | `settings-book-analysis.test.ts` 新增「失败终态后重建，连败计数不继承」：5 连败到终态→点重建→再 4 败仍「构建中」、第 5 败才终态 |
| P3-18 | 搁置通道启动日志降 `log.info` 并删除开发者指令（「恢复 = os-kek.ts OS_KEK_SHELVED 改 false」），改述「内置通道混淆级保护为未签名发行期的预期形态」并指 README；`OS_KEK_SHELVED` 常量与搁置决策不变（作者 2026-09-20 拍板） | `os-kek.test.ts`：断言 info 文案含「钥匙串通道当前未启用」、warn 无「搁置」、输出不泄漏 `OS_KEK_SHELVED` |
| P3-11 | 七处小型重复/类型谎言单点收编：①`atomic.ts` tmp 写+fsync 块收编 `writeTmpFile`（atomicWriteFile 与 createFileExclusive 两写路径落盘保证不再分叉）；②`retryOnTransientFsError` 返回类型 `T \| undefined`（删 `undefined as T` 类型谎言，唯一吞错调用方 rmWithRetryQuiet 语义不变）；③`cross-process-lock` 三处内联 `Atomics.wait` → 既有 `fsBackoffSleep`（0/负超时返回 timed-out 不抛错，行为等价已验）；④`events/store.ts` 事务样板收编 `withEventsTx`（appendEvents / appendEventsResolveLineage / clearBook / clearBooks 四处；R61-10 回滚加固单源；workspaceSession/迁移改写走 BEGIN IMMEDIATE 语义不同、留自持）；⑤`static.ts` 安全响应头三份 → `STATIC_SECURITY_HEADERS` 单源；⑥`main.ts` devUi 判定两份 → `isDevUi()` 单源；⑦`openai-adapter` 纯别名 `createOpenAIProvider` 删除（与 `createOpenAIProviderChat` 同名同义，调用方无从分辨；15 个测试文件调用面随迁唯一工厂） | typecheck 全绿；`test/events`+`test/ai/provider`+`test/fs`+`test/desktop` 定向 150 文件 1159 例全绿；`r38-batch-d` R38-5 静态锚从薄壳别名改锚唯一工厂签名 + `buildDegradeAttempts` 下传点 |
| P3-7 | 实测处置（不调阈值）：本批收口后 win 本地全量 `vitest --coverage` 复跑**全桶过门**——评审时红的两项已绿：src/fs 分支 90.00（门 89）、src/rag 分支 88.70（门 88）；src/ai 函数 95.03（门 95，P3-11 删别名后回升）。阈值按 CI ubuntu 腿校准是阶段 43 既定决策，「win 分档/留余量」会放松绿门（违「只紧不松」），不采纳；贴线桶点名入档：ai functions 余 0.03pp（≈1 个函数粒度，最脆）、document S 余 0.04pp、learn S 余 0.19pp、studio/server S 余 0.18pp——后续批触此四域先本地跑 coverage 自查。三个零覆盖视图（Library/Welcome/LearnView）已由 RC 重审 P2-5 显影桶显式登记（0/0 = 「e2e 自管」边界 + 回收条件），非静默暗区，不补组件测试 | 本节实测数字（coverage-summary.json 全桶核算）；CI ubuntu·24 腿阈值门继续兜底 |

波 A 门实录（本机 win）：tsc 通过 / eslint 通过 / 全量 vitest 与 coverage 实测数字见上方 P3-7 行（提交前全量跑）。

#### 批 1（2026-09-25，提交 `74fd2e15`）

| ID | 修复形态 | 回归测试 |
|---|---|---|
| P3-22 | 抽 `ModalMask` 统一组件（`:open` 即登记、浓度自 ui store 内联上色）：7 个全屏遮罩（palette/settings/export/shelf/confirm + 新增 chapterMeta/splitChapter）与书架两个子弹窗遮罩浓度全部单源化（`MASK_ALPHA` / `SHELF_DEEP_ALPHA`），组件 CSS 镜像值与「读 CSS 对账」锁随删。章节属性/拆分对话框入登记表：⌘P 守卫生效、win 窗控变暗生效 | `j5-overlay-dim.test.ts` 改锁「浓度单源 + 行为登记」（含两对话框开→`overlayOpen`/`maskAlpha` 生效、关闭复位；子弹窗渲染面 = SHELF_DEEP_ALPHA + 源码零镜像） |
| P3-24 | workspace store 收口：导出 `ActiveView` 等类型别名（三处字面量联合收一处）、`pendingInsert` 改一次性令牌（consume-once 在类型层可见，替「读后置 null」）、编辑器两函数槽收敛为 `EditorHandle`（兼容 computed 保持读方语义）、书级偏好补在途追踪（先等在途落定再清窗直发，防两笔 PUT 乱序）；WorkspaceShell 的 warning toast 由 'error' 改 'warning' | 新增 `workspace-shell-warning-toast.test.ts`（2 例）；`workspace.test.ts` 令牌通道 4 例 + 在途冲刷 2 例；`chat-dispatch-state-machine` 15 处断言改对象身份 |
| P3-27 | chat-dispatch 回合目标由 `messages.value[turn.currentIdx]!` 改持响应式消息对象引用（`current: ChatMessage \| null`）：裁剪/截断天然跟随，消 6 处下标越界断言与 `trimMessages` 手工偏移、删 chat.ts 的「反向扫 last undone 重定位」补偿块 | 新增 2 例（回合中 splice 头部裁剪、filter 式截断，增量仍落原目标气泡）；变异：回退为下标形态 → 13 例红 |
| P3-19 | `?token=` 过渡回退通道两端同删（服务端 SSE 路径拒收、前端换票失败并入既有退避，不新增重试体系）；连接状态收成 `SseEpochState` + `resetEpoch()` 单点复位（原 10 个散落标志、3 处逐行复位清单收编）；e2e 全量检索确认零直接 SSE 消费方，无受影响 spec | 新增 4 例（换票 404/网络/5xx/超时 → 不回退、URL 无长期 token）+ 2 例（纪元复位归零）；`r51-h5-sse-ticket-warn-dedupe` 随通道删除；变异：恢复回退分支 → 4 例红 |
| P3-25 | prefs 对外 76 → 10 成员（评审路线 B）：`PREF_ROWS` 泛型 `get/set`（键类型由行表推导，拼错编译期红）、31 个平铺 setter 收进键控表、写 DOM 与窗控变暗拆出 `usePrefsDomEffects` composable（时序不晚于原实现）、`baseStep` 恒零加数删除；26+19 个调用点随迁，无兼容别名双轨；`setOverlayDimmed` 签名语义逐位不变 | 新增 `prefs-generic-getset.test.ts`（5 例：类型面 `@ts-expect-error` ×4、响应依赖、init 时序）；变异：持久化键改错 → 键名锚用例红 |

批 1 门实录（win）：tsc / vue-tsc / eslint 全绿；`vitest run test/studio` 517 文件 3052 例通过 0 红。
SSE resync 三族测试（r29 4 例 / r55 3 例 / reaudit-03 1 例）断言改竞态无关形态：换票成功路径比旧 404 回退多一次 await（读响应体），useSse watch 的即时连接可能被链尾 resync 抢先作废——原「实例总数」断言依赖微任务竞态，语义锁改为「旧连必断 + 恰一条存活 + 指向书正确」。

#### 批 2（2026-09-25，提交见下）

| ID | 修复形态 | 回归测试 |
|---|---|---|
| P3-12 | 忙闸互斥矩阵表驱动：`task-gate.ts` 出 `BUSY_MATRIX`（行=意图/列=信号，表内序=判定序）+ `busyReason(book,intent)` 单源；7 处手写点（stream spawn/auto-write、chat 三态、audit、books-lifecycle、documents-core、review）全改调；`allHeldTaskGatesFor` 迁回 task-gate（audit ↔ stream 环解除，grep 双向证明）；review 按文档闸先于书级闸（`REVIEW_RUNNING` vs `REVIEW_BUSY`，文案不再误称「其他任务在跑」）；409 文案半/全角统一 | 新增 `busy-gate-matrix.test.ts` 169 例（期望矩阵独立字面量 + 逐格三测 + 端点层 10 意图被拦/放行臂 + 三审闸语义 4 例）；变异：删 auto-write 行 chat 格 → 3 例红 |
| P3-14 | 任务闸锁文件名 `${action}.${hash(book)}.lock`（列目录即枚举持有者），删 `KNOWN_ACTIONS`/`GATED_ACTIONS` 两表与对齐测试；旧格式三层迁移（启动清扫非在持残留 / acquire 先占新锁再探旧名、在持则回滚退让 / 旧名不含书信息故不入枚举面，如实记档）——旧格式无可双重持锁 | 新增 `task-gate-lock-format.test.ts` 8 例（格式、枚举、旧名在持退让不留新锁、崩溃残留清理、启动清扫）；治理门改 action token 门（扫 `acquireTaskGate` 调用点字面量）；变异：删旧名探测 → 3 例红 |
| P3-16（半） | task-gate 的 driver 可选能力 fail-open 改显式：`resolveInterruptChannel` 缺能力时 `log.warn` 带 `action@book` 可回溯（`driver/types.ts` 的必需化因跨面留后续） | 新增 `r0916-p3-16-interrupt-capability.test.ts` 3 例 |
| P3-15 | 三适配器流尾收口单点 `stream-finalize.ts`（done 一次性门 / 截断估算 / content_filter·refusal 判错 / usage 兜底）；`stopReason` 收成闭合判别联合 `StopReason` + `normalizeStopReason`（线上别名归一表），`runner.ts` 删静默 `'end_turn'` 兜底改显式 `'unknown'` + 留痕 | 新增 `stop-reason-normalize.test.ts` 34 例（逐线决策表 + 三线适配器级断言）、`stream-finalize.test.ts` 10 例（一表三线共跑）、`runner-stop-reason.test.ts` 7 例；变异：归一函数回退 → 9 例红；runner 守卫回退 → 5 例红 |
| P3-16（前三项） | ①OpenAI 系参数按 SDK 类型构造（Chat 线交叉类型、responses 线单点 `asSdkParams` 白名单转换，删整对象 `as unknown as`）；②`runner.ts` 结果提取改显式守卫 + 判别（未知值归 `'unknown'` 留痕）；③盘上角色读入校验 `parseDocumentRole`（非法→'note' + 留痕） | 新增 `openai-params-sdk-shape.test.ts` 15 例（类型可赋性探针 + 键形状对照）、`trash-role-validate.test.ts` 18 例；变异：role 校验回退 → 3 例红 |
| P3-17 | server-manager 12 个闭包变量 → 显式状态容器：相位 `idle│starting│running│backoff`（由载荷派生）+ 停机面三值联合（存储）+ 单一转移点 `transition()` + 转移表 `isLegalTransition()`；非法转移拒绝并 error 留痕（原注释里的「12 变量正确性证明」删除，换状态机说明） | 新增 `server-manager-state-machine.test.ts` 12 例（132 格转移表逐格核验 + 6 条转移轨迹 + 3 组原场景回归 + 非法拒绝）；变异：放行 `stop-clear` → 6 例红（含两条既有并发用例） |
| P3-26（前端面） | 三处手写防竞态计数器（EditorView `kindReqId`、CmHost `compReqId`、useBookSwitchGuard `bookGen`）收编 `useStaleGuard`；CmHost 两段重复补全映射抽 `completionEntriesOf`；四消费点字数计算共享（`useDebouncedWordCount` 单槽派生记忆，MB 级长章 4 趟 O(n) → 1 趟，定时器仍各消费点自持）；`.spin` 全库单源（0.9s 档，8 处组件内定义删除）、`--text-warning` 失实回退值删除 | 新增 `stale-guard-adoption-late-response.test.ts` 4 例、`word-count-shared-derivation.test.ts` 2 例、`styles-single-source.test.ts` 6 例；`book-switch-guard-segments` +1；变异：四处守卫各自回退 → 对应用例红；字数记忆关闭 → 4→1 断言红 |
| 遗留收口 | `test/document/r40-static-anchors.test.ts` 的 R40-4 原第二断言钉 `task-gate.ts` 内 `'style-harvest'`（KNOWN_ACTIONS 已删）——改锚调用点 token；`stream-ticket.ts` 头注「`?token=` 保留」陈旧表述随 P3-19 更正 | 同上（r40 静态锚随批更新） |

批 2 门实录（win）：tsc / vue-tsc / eslint 全绿；`vitest run test/studio test/ai test/document test/desktop test/governance` 872 文件 5609 例通过 / 33 跳过，exit 0。

#### 批 3（2026-09-25，提交见下）

| ID | 修复形态 | 回归测试 |
|---|---|---|
| P3-13 | ①`defineRoute` 加 `gate` 前置钩子（执行序 gate → readJson → parse → handler，cleanup 单点收尾），`/spawn`、`/auto-write` 由绕开 parse 改为「忙闸入 gate、体校验入 parse」——409 仍先于 400，绕开理由随之消失；②`providers.models` 复用新抽 `parseConnectionInput`（protocol 三选一 / auth 推断 / baseUrl 必填 + `^https?://` scheme / apiKey 字符闸），非法值 400 且点名到字段（原 `as` 断言 → 500 GEN_FAIL）；③按点名迁移 `style.ts`（4 端点）、`files.ts`（content/expectedRevision，`bodyLimit` 保住 16MB 的 413 阈值）、`snapshots.ts`（restore）、`books.ts`（书名/kind/host）——`settings.relations.mine` 与 providers 容错读体两处如实留档不迁（前者 409 须先于 400 且容错语义 parse 不可表达） | 新增 `api-input-validation.test.ts` 13 例（models 非法 protocol/scheme/apiKey → 400 点名 + 合法仍 200）、`api-input-validation-migrated.test.ts` 20 例（表驱动逐端点 非法→400 / 合法→200）；`router-schema.test.ts` +5（gate 单测）；变异：models 回退成 `as` 断言 → 2 例红；gate 块位移到 parse 后 → 忙闸 409 两例红（`expected 400 to be 409`） |
| P3-21 / P3-26（api 面） | ①回包类型共享契约落 `src/shared/contract/`（纯类型零导入，14 个类型；`api/documents.ts` 12 个手抄接口删除改 `export type` 转发，调用方 import 面零变化）+ 根 tsc 单侧对齐探针（契约 ↔ 服务端权威类型：keyof 键集相等 + 双向可赋值，服务端加字段即门红）；②`bookUrl(name, ...segments)` 单源收编 86 处构造点（api 层 81 + 心跳 2 + SSE 3）；③`apiFetch` 对外收成 `(path, init)`，递归/计量/出参进私有 `apiFetchCore`，删 `JSON.parse(body)` 嗅探 operationId 改 `ApiFetchInit.replayable` 显式声明；④`CmHost` 导出 `CmHostHandle` 供 `defineExpose` 反向钉住，`EditorView` 删手抄接口、`isReviewable` 的 `entry` 提到读取之前 | 新增 `api-book-url.test.ts` 11 例（逐形态与旧模板逐字一致 + 零手拼锚）、`shared-contract-response-types.test.ts` 6 例（`@ts-expect-error` 机制探针 + 3 条服务端漂移闸）、`api-layer-single-source.test.ts` 5 例；`client-401-replay-idempotency` 6→8 例（显式可重放→重放恰一次、带 operationId 未声明→不重放）；变异：`encodeURIComponent` 去掉 → 8 例红；`isReplayable` 一律可重放 → 6 例红；对齐探针加可选字段 → 根 tsc 红（首版仅双向可赋值对可选新键不敏感，补 keyof 键集相等后复验才红） |
| P3-20 | 切书链改「**提交前守卫**（`onBeforeRouteUpdate`）→ 预决断移交 → `watch` 只做状态转移」：取消即 `return false` 中止导航，原「先切后回滚」的 `clearEventStores` 善后 / `replace` 回退 / `resync` 补种在原地切书路径整段删除（取消时一条状态都没动过）；新增 `BookSession { name, signal, stillIn() }` 单例（进书 begin / 离书·切书 abort，`stillIn()` 以引用同一性判定，同名重进的回环也能区分新旧会话）；`useChapterTreeActions` 的 stillIn/failScoped 判定源换成书会话 + AbortError 静默吸收；`api/client.ts` 新增会话信号接驳（未传 signal 时按「本书 + 文档结构写」接驳，读面与 PUT 刻意不接——其错误面在各 store 既有代守卫） | 新增 `book-switch-precommit-guard.test.ts` 4 例（真路由驱动：取消→路由未提交、A 的 dirty 原封、无 resync、B 会话从未建立）、`book-session-lifecycle.test.ts` 8 例、`book-session-signal.test.ts` 8 例（真 apiJson + 桩 fetch 断言行为）、`book-session-abort-late.test.ts` 5 例（含 A→B→A 连切——AbortError 吸收不可被书名复检替代的面）；10 个既有切书链测试补 `onBeforeRouteUpdate` mock（零断言改动）；变异：守卫首行 `return true`（回旧形态）→ 3/4 红（`expected ['书B'] to deeply equal ['书A']`）；删 AbortError 吸收 → A→B→A 例红 |
| P3-9 | 先取证后决策：产出「恢复能力对照表」逐场景核验，选**路线 ②**（journal 只记 `opId/docId/baseRevision/ts/status`）：`pending.content` 与快照机制整组删除——头尾截断降级、惰性构造、256KB 闸、compact 尾段补追（`readByteRange`/`readCompactTail`）、降级写 inode 自校验、两个注入钩子；读侧按字段白名单重建（兼容读旧格式、写新格式）；crashedWrite 文案改指编辑器本地镜像（不再叫作者手读 JSONL）。依据：快照覆盖面与前端镜像同类且更窄（只覆盖「某一笔保存在途」，对「未落盘编辑」「保存成功即崩」两档零贡献），>256KB 档本就只剩 32KB+32KB 残片；唯一独有面是 AI 自动写章崩窗（可重跑），如实记档 | 新增 `journal-pending-metadata-only.test.ts` 5 例（旧格式行仍可检出/被 settled 抵消、新写入键集精确、compact 保留未结算行、锁超时降级裸写仍完整落盘）；改 `journal.test.ts`（含两条 N4 并发守卫）、`pm346-save-cluster.test.ts`（2 例改「journal 尺寸与正文规模解耦」契约）；删 3 个钉被删机制的文件（−9 例）；变异：停用 compact N4 复核 → 2 例红；恢复旧字段约束 → 8 例红 |

批 3 门实录（win）：tsc / vue-tsc / eslint 全绿；`vitest run`（全量）1320 文件通过 / 8 跳过（1328），8381 例通过 / 76 跳过，0 失败。根因定位并修复一条随批 1 ModalMask 引入的测试卫生缺陷：`r42-global-overlays` 反复 mount App 而 `beforeEach` 清空 body、实例从不 unmount，ModalMask 多出的组件层让陈旧 Teleport 锚点的重渲染真的落到 DOM（`insertBefore of null` → ErrorBoundary → 3 条未处理拒绝，单文件跑退出码 1）；用例收尾补 `unmount()` 后 exit 0。归因用基线 `cb483819` / 批 1 `74fd2e15` / 批 2 `ef0bdaec` 三个临时工作树单跑复现（基线干净、批 1 起复现），临时工作树与目录联接已全部清除。

**P3 累计**：27 条中已落地 20 条（波 A 5 + 批 1 4 + 批 2 6 + 批 3 5），余 P3-1 / P3-2 / P3-3 / P3-4 / P3-5 / P3-6 / P3-8 七条按批 4~6 续。（P3-16 拆两批落地：驱动能力留痕批 2、必需化接口随批 5 组装根注入。）

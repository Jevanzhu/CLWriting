# CLWriting 全量代码审计报告

- 审计日期：2026-10-19
- 审计基线：`HEAD 089112de`（版号 1.0.0，分支 `win`，工作树干净——`git status --porcelain` 仅 `?? audit-2026-10-19/`，已跟踪文件改动数 0）
- 证据口径：**只采源码、配置、测试、提交记录**；`docs/`、`知识层/`、`.agents/notes/`、README 的结论与数字一律不作为结论依据（README 仅在「声称 vs 实测」对账时出现，且以实测为准）
- 本阶段**未修复任何代码**；未跑全量测试与 coverage；未起真实 Electron/服务进程；未跑并发 vitest

## 0. 审计声明（域 / 深度 / 预算）

| 项 | 内容 |
|---|---|
| 域划分 | 域1 AI 链路与编排（`src/ai` + cache/metrics/diagnostics/learn/review）；域2 文档/格式/导入导出/文件版本（`src/document`、`format`、`export`、`fs`、`git`）；域3 HTTP 服务端/检查引擎/事件与状态/进程与驱动（`src/studio/server`、`check`、`events`、`state`、`process`、`driver`、`log`）；域4 桌面壳/安装更新/知识层与检索/共享层（`src/desktop`、`install`、`update`、`knowledge`、`rag`、`shared`）；域5 Web 前端（`src/studio/web-next`）；域6 工程质量与治理面（配置、门禁、测试可靠性、提交考古——Lead 亲审） |
| 深度 | 域内全量文件清单排序 → 热点档（>300 行）精读 → 结构性标记全量扫描 → 与测试/提交记录交叉验证 → 高危结论对抗性复核（第二波） |
| 执行方式 | 5 名域审员并行（单波 5，在途 ≤5）+ Lead 亲审域6 + 第二波 2 名复核员（6 条高危对抗复核 + 5 项跨域悬项闭合）；共 7 名成员、全部交付 |
| 预算实测 | 域审员工具调用 26–36 次/人（上限 40）；复核员 23 次、27–28 次（上限 25，两次超支已如实记档）；报告均 ≤ 上限 |
| 覆盖边界 | 各域均声明未通读面（见 §8）；结论只在已核面成立 |

## 1. 执行摘要

**一句话结论**：这是一个**工程成熟度罕见地高于同类桌面应用**的 1.0 代码库——静态类型与 lint 档位严、门禁自动化程度高、破坏性操作有留底、调试与审计充分；本次 61 条分域发现中 **P0 = 0**，唯一 P1 是前端「离书 + 保存失败」双条件下的**未保存内容丢失且零提示**。真正的短板不在功能，而在**边缘态的用户可见面**与**注释/测试台账承载的历史叙事**。

| 严重度 | 数量（复核后） | 说明 |
|---|---|---|
| P0（阻断/数据不可恢复/越权） | **0** | 未发现可越鉴权、可静默损坏书稿、可致进程崩溃的可达缺陷 |
| P1（高危，用户可见损失） | **1** | 域5 W-01：脏路由离书丢未落盘编辑（经复核**维持 P1** 且影响面被低估） |
| P2（中危，边界态/纵深/运维） | **13** | 原 17 条中 4 条经复核下调（原因逐条在 §4.3） |
| P3（低危/取舍/卫生） | **≈50** | 分域 42 条 + 复核新增 4 条 + 复核降级 4 条 |

三个最重要的判断：

1. **实现完成度与 1.0.0 发版相符**：全域未见桩实现、空壳模块、未接线分支或半成品导出链；`src/ai` 三协议适配与记账、`src/studio/server` 六道鉴权闸、`src/document` 保存协议、`src/desktop` 双状态机、前端 255 档全部为真实实现。
2. **风险集中在「非主路径的可见面」**：唯二会被用户感知的问题（P1 离书丢失、P2 关窗兜底/自动保存静默）都属于「一条数据在不同离开方式下保护强度不一致」，而不是主路径写坏数据。
3. **最大的技术债不是代码，是台账**：eslint 抑制台账 315/315 贴线（零余量）、test/ 批号叙事 9,675 处注释 + 4,072 处标题、src 注释占 28.4% 且大量承载修复沿革——与项目自身「修复史归 git」的注释纪律存在系统性张力（§6、§7）。

## 2. 事实基线（全部实测）

| 指标 | 实测值 | 取得方式 |
|---|---|---|
| 提交数 | 1,160 | `git rev-list --count HEAD` |
| 入库代码文件 | 2,097（src 675 / test 1,368 / scripts 49） | `git ls-files` |
| src 规模 | 145,070 行，其中注释 41,152 行（**28.4%**） | 逐档统计 |
| test 规模 | 240,526 行，注释 30,177 行（12.5%） | 同上 |
| 测试档 / 单测数 | **1,285 档 / 9,332 单测**（与 README 声称一致，实测通过） | `npm run check:counts` |
| e2e | 35 spec / 59 用例 | 同上 |
| 断言密度 | `expect(` 29,905 行 | `git grep` |
| 提交类型分布 | fix 372（32.1%）、feat 262（22.6%）、无前缀 136（11.7%）、docs 132、refactor 69 | `git log --format=%s` |
| 依赖 | 运行时 4 个（anthropic-sdk / openai / font-list / yauzl）；`npm audit --audit-level=high` **0 条 ≥high**（8 条 moderate 全在 dev 链 electron-builder 族） | 实测 |
| 返工热点（近 500 提交改动次数） | README.md 227、`src/desktop/main.ts` 91、`src/document/service.ts` 72、`src/studio/server/api/stream.ts` 55、`src/events/store.ts` 54、`src/ai/runner.ts` 51 | `git log --name-only` |

## 3. 实现完成度评估

| 域 | 判定 | 关键证据 |
|---|---|---|
| 域1 AI 链路 | **完成**（主体），缺口在边路径记录完整性 | 三协议适配器就位（`src/ai/provider/`）、`runTask` 三段式（`src/ai/runner.ts:574-582`）、重试/超时/预算/双块记账全链、self-heal 五终态出口（`src/ai/orchestrate/self-heal.ts:737-834`）；`cache/metrics/diagnostics/learn/review` 仅红标扫描，**未判定** |
| 域2 文档/格式/导出 | **完成**（5 模块群），缺口在验证面 | 保存协议全链（`src/document/service.ts:232-654`）、结构合并幂等收尾（`structure-merge.ts:306-397`）、平铺 YAML 受限子集完整（`format/yaml-spec.ts:219-775`）；未见桩或半成品 |
| 域3 服务端/检查/事件 | **高** | 六道鉴权闸（`src/studio/server/index.ts:621-781`）、错误信封单出口（`http.ts:152-171`，全目录 `reply(res,4xx)` 零命中）、事件库迁移墓碑+回滚（`events/store.ts:1074-1155`）、检查引擎 11+ 项聚合（`check/runner.ts:127-395`） |
| 域4 桌面/安装/更新/检索 | **高**：desktop ~95%、rag ~95%、shared ~92%、install ~90%、knowledge ~90%、**update ~85%（最年轻）** | 双显式状态机（`desktop/server-manager.ts:210-251,478-529`；`lifecycle.ts:86-117`）、SQLite WAL+版本阶梯（`rag/store.ts:131-145,240-264`）；update 仅 11 次提交、测试 4 档 719 行 |
| 域5 前端 | **完成**（255 档全为真实实现，未发现空壳） | 乐观锁+双代守卫（`stores/doc.ts`）、SSE 换票/退避/看门狗（`composables/useSse.ts`）、CodeMirror 外部替换守卫（`editor/CmHost.vue:247-434`）；缺口在「非切书冲刷路径」与薄测试面 |
| 域6 工程治理 | **高**（见 §6） | 8 道自建 check + 链面/决策记录门、CI 三平台×双 Node 矩阵、覆盖率 33 桶、tsconfig strict 全家桶 |

**整体判断**：功能面上「1.0.0 首发」名副其实；完成度缺口不是「没做完」，而是「边缘态没被验证面覆盖」。

## 4. 问题清单（P1 / P2）

### 4.1 P1（1 条，经对抗性复核维持）

**P1-01 脏路由离书：保存失败/冲突未决 → 内存与崩溃镜像双清，零界面提示**
- 证据：`src/studio/web-next/src/composables/useBookSwitchGuard.ts:301-322`（`if (!n)` 分支：`await doc.flushDirty()` 失败仅 `console.warn` `:308-312` → 无条件 `doc.setBook('')` `:314`）；`src/studio/web-next/src/stores/doc.ts:112-134`（`setBook` 内 `docs.value = new Map()` `:118` + `mirror.clearBookMirrors(prevBook)` `:127`）；`src/studio/web-next/src/shared/dirty-mirror.ts:164-187`（镜像按书全删）
- 影响：从 `/book/A` 离书到 `/shelf` 等无书路由时，若冲刷失败（离线/5xx）或存在冲突项，未落盘编辑随内存与 localStorage 镜像双双消失，**界面零提示**（仅控制台）。服务端 `.版本` 快照只覆盖已落盘历史，无 journal/后写回兜底 → 不可恢复
- **复核新增（影响面被原报告低估）**：`conflict` 项本就被 `flushDirty` 扫描面排除（`doc.ts:737` 的 `!e.conflict`），同一决断在 precommit（`:262-279`）与 committed（`:340-347`）路径会弹「永久丢弃」让作者选择（`:243-252`）——**同一应用三条离书路径、两套口径**，而冲突态可由后台 AI 改写落盘自然造出，触发比「保存失败」更日常
- 复核裁定：成立，维持 P1（依据：`useBookSwitchGuard.ts:296-322,337-338` + `doc.ts:112-134,717-752` + `dirty-mirror.ts:164-187`，均实读）
- 建议：脏路由分支改为可见决断（沿用 `askDrop` 口径）或把镜像清扫延后到冲刷成功；失败时保留镜像作最后兜底
- 置信度：高（代码路径确定）；未做的验证：`/book/A → /shelf` 真实导航时序未运行时实测

### 4.2 P2（13 条）

| ID | 域 | 结论 | 证据（file:line） | 建议 |
|---|---|---|---|---|
| C-01 | 2 | 跨卷重号章静默覆写：`chapters.find(章号)` 取遍历序首个、`exists:true` 不校验是否本次目标，`expectedRevision` 基线与被写对象同源故拦不住 | `src/document/draft-path.ts:41-49`；`src/document/service.ts:360-368`；`src/ai/tools/rewrite.ts:126-158,166` | 多命中即 fail-loud 或带 `ambiguous` 交上层确认（同族 `structure-merge.ts:133` 已有拒合先例） |
| C-02 | 3 | 事件库体积无界：仅三族观测事件有 30 天窗，其余族无时间/行数/体积上限，无阈值告警 | `src/events/store-retention.ts:63-67`；`src/events/store.ts:840-877` | 加库体积/行数阈值的只读观测（启动通告或健康项） |
| C-03 | 3 | 跨进程锁续期定时器 `utimesSync` 抛错即 `clearInterval`（无重试、无日志）→ 10 分钟后他进程可判 stale 接管 → 同书同 action 双跑 | `src/fs/cross-process-lock.ts:206-215`、`:73`、`:128-136`；`src/studio/server/api/task-gate.ts:106-109,176-184` | 计数+退避重试+超限告警；停表必须留痕 |
| C-04 | 3 | 摘要链在服务进程用同步跨进程锁（`Atomics.wait`），与全仓「服务进程走异步孪生」纪律冲突 → 争用时冻结该进程 HTTP/SSE | `src/process/summary.ts:217-226,587`；对照 `draft-pipeline.ts:242-244`、`state/health.ts:414-416` | 改 `acquireCrossProcessLockAsync`（孪生已存在） |
| C-05 | 4 | 更新链校验值与被校验对象同源、下载域名不校验：releases 响应同时给出 URL 与 digest，「校验通过」不提供来源独立性 | `src/update/asset.ts:45-64,77`；`src/update/download.ts:138-167`；`src/desktop/update-controller.ts:153-185` | 引入独立信任锚（内置公钥签名清单）或对 URL 做域名白名单 |
| C-06 | 4 | 解压无累计字节/条目数上限，空间预检仅 zip 体积 ×3 → 高压缩比包可写满盘 | `src/update/extract.ts:74-83`；`src/desktop/update-helper.ts:279-285` | 解压中累计上限 + 超限整体失败并清理 |
| C-07 | 4 | 更新助手 argv 无来源校验：`--target` 任意目录可被改名/递归删；`--sha256`/`--home` 缺省即跳过复核与实例检查 | `src/desktop/update-helper.ts:87-111,247-269,294-321` | target 必须等于 `dirname(process.execPath)`；payload 必须在 `updateCacheRoot` 下；sha256 缺失即拒 |
| C-08 | 4 | 安装链无 `compareSemver(to,from)>0` 的 fail-closed 防降级断言（检查链侧有，装配侧无） | `src/desktop/update-controller.ts:209-226`；对照 `src/update/check.ts:167` | 装配前与助手各加一道版本断言 |
| C-09 | 5 | 关窗兜底缺位：`__clwFlushBeforeClose` 只在 Book.vue 注册，钩子缺失时主进程**不等待**（仅 prefs 毫秒级冲刷）直接 `destroy()` | `composables/useUnloadFlush.ts:72-109`；`src/desktop/lifecycle.ts:428,441,452-453,464`、`:259-261`（复核闭合） | 钩子提为应用级注册，或在离书态保留至落净 |
| C-10 | 5 | autosave 失败在非编辑视图零可见面：失败只置 `entry.error` 不 toast，而节拍挂在 Book 层照跑、错误面只渲染在编辑器模板 | `stores/doc.ts:428-431`；`composables/useAutosave.ts:19-35`；`views/EditorView.vue:327-336` | 连续 N 拍失败升级为一次 toast，或提升为全局状态条 |
| C-11 | 5 | 超大档双兜底静默失效：镜像上限 2e6 字符（仅 `console.debug`）与保存上限 16MB 口径不一致 → 2M–5.3M 字符档「能保存但没有崩溃镜像」 | `shared/dirty-mirror.ts:34-35,102-105`；`shared/save-limits.ts:16,31-34`；`stores/doc.ts:362-367` | 两个上限对齐，或超限时显式提示「已无本地镜像兜底」 |
| C-12 | 1 | 自检锚失效：`AI_CALLS_MUTEX_SCOPE_NOTE` 文案声明锁文件为 `.cache/ai-calls.lock`，实际是 `.cache/ai-calls.json.lock` ——「防声明随实现漂移」的锚自身已漂移 | `src/ai/calls.ts:290,300` vs `:362` | 文案由 `budgetPath` 单源拼出，并纳入测试断言 |
| C-13 | 1 | 铁律①边路径缺口：备料失败 + 旧材料清理 `rmSync` 失败被**空 catch** 静默吞掉 → 盘上留上一章材料而 `promptFiles` 为空 = **模型可见却事件库零登记** | `src/ai/orchestrate/self-heal.ts:470-471,477-485` | 该 catch 补 `log.warn`；清理失败同步收口材料来源登记 |

### 4.3 复核导致的 4 处修正（原报告 → 修正后）

| 原条目 | 原判 | 复核裁定 | 修正与理由（均实读复核） |
|---|---|---|---|
| 域1 D1-01 记账口径分裂 | P2 | 部分成立 | **降 P3**：该口径在源码内**明示设计**（`turns-phases.ts:473-476`），且两类重发的首发失败多为建连期零增量（`:480`），账本按次不丢 → 影响面小，非「系统性低估成本」 |
| 域1 D1-02 拒清库内存已清 | P2 | 成立但影响收窄 | **降 P3**：前端 catch 后 `return` 不落本地清空（`useChatComposer.ts:236-241`），事件库未清故重放自愈（`api/chat-history.ts:1-23`）；残留仅「当前会话显示滞后」 |
| 域2 A-2 版本文件名无白名单 | P2 | **不可利用** | **降 P3**：读侧三重 ULID 白名单 + `safeDocId`（`version.ts:442-451,467-476,553-561,391,238`），且 `writeVersion` 全调用点无 id 入参（id 内部生成）→ 穿越面在数据层已堵死 |
| 域4 A-5 一次性信箱零测试 | P2 | 表述不实 | **降 P3**：端点级已有取后即删用例（`test/studio/server/app-info.test.ts:140-153,155-172`），应改为「仅 cache 层删除失败容错分支未测」 |

### 4.4 复核新增（4 条，均已并入上表或 P3）

1. **离书三条路径两套口径**（并入 P1-01）：conflict 项在脏路由被静默丢弃，另两条路径弹窗。
2. **重号解析面比原报告更广**（并入 C-01）：改写链新鲜度/复验三道闸（`rewrite.ts:126-152`）全部按章号定位，与写入同源。
3. **锁文件被删的免 stale 失效面**（新增 P3）：对手 `open 'wx'` 直接成功且无告警（`cross-process-lock.ts:1,216-232`），两侧均无用户面留痕。
4. **一次性信箱消费时序 + 同故障双文案 + 409 显示滞后**（新增 3 条 P3）：`app-info.ts:29` 被各页挂载即取、取走即删，若首个取走者未接提示面则提示静默丢失；`client.ts:359` 与 `stores/ui.ts:92` 同故障两套文案；`useChatComposer.ts:238-241` catch 后不重拉历史。

## 5. P3 清单（≈50 条，按域聚类；完整四节表见各分域报告）

| 域 | 条数 | 主题聚类（代表条目 → 证据） |
|---|---|---|
| 1 | 12 | 重放参数面缺 `toolChoice/stopSequences`（`runner.ts:599-637` vs `events/types.ts:141-157`）；失效行号锚 3 处（`runner.ts:954,1000`、`calls.ts:425`）；模块级 `inWriteSegment` 隐式全局前提（`calls.ts:287,369-371`）；API key 掩码保留前 4 后 4 且经 HTTP 下发（`provider/store.ts:918-922`）；同域 LRU 纪律相反（`turns.ts:70-71` vs `turns-phases.ts:564-569`）；缓存陈旧窗（`store.ts:350-363`）；注释与代码不符（`self-heal.ts:405-412`）；记账口径分裂（降级）；拒清库显示滞后（降级） |
| 2 | 6 | CRLF 快照元数据漂移且无测试（`version.ts:553-572` + `format/frontmatter.ts:194`）；`parseFlat` 行尾 `\r` 剥除未收口（3 处各自实现）；journal 锁超时降级裸写（`journal.ts:243-265`）；tmp 清扫年龄门（`fs/atomic.ts:428-495`）；回收站条目写回失败零留痕（`trash.ts:630-632`，空 catch）；版本文件名白名单（降级为纵深） |
| 3 | 7 | 400 信封回显 `JSON.parse` 原文（`http.ts:300-303`）；日志落盘含完整调用栈与绝对路径（`log/index.ts:304-321` vs `http.ts:79-91`）；超时文案硬编码「5 秒」（`draft-pipeline.ts:78-81,246-247`）；health 三表无上限（`health.ts:62-85` vs `store-retention.ts:92`）；SSE 只有每书 5 条无进程级上限（`stream-sse-writer.ts:39`）；注释占比 40–60% 且载批次号（`task-gate.ts:64`、`http.ts:42`、`events/store.ts:1-15`）；`/api/boot` 本机信任域为设计声明（`index.ts:290-305`） |
| 4 | 11 | 删库顺序先主库后 `-wal/-shm`（`rag/store.ts:185-186`）；同名 `rmDirQuietly` 跨文件语义不同（`update-helper.ts:114` vs `update-controller.ts:354`）；session-end 自愈窗口与停机预算紧贴（`lifecycle.ts:235,239,502-519`）；`SqliteSchemaTooNewError` 未归并为状态（`rag/build.ts:263-277`）；知识层运行期不读 manifest（`knowledge/catalog.ts:12-13`）；同步爬祖扫描残窗（`workdir-controller.ts:296-298,534`）；真机进程语义只靠假件（`test/desktop/server-manager-fixtures.ts:27-41`）；修复史措辞 156 处（`rag/build.ts:552-555`、`desktop/ipc.ts:341`）；一次性信箱删除失败分支未测；中断自愈依赖「下一次启动」（`update-helper.ts:16-21`） |
| 5 | 11 | 偏好 500ms 防抖窗内切书静默丢弃（`stores/workspace.ts:593,337-341`）；token 变化后 401 文案不统一（`api/client.ts:162-177,193`）；外部全量替换清 undo 栈无提示（`editor/CmHost.vue:363-398`）；浮层夹边不全（`ui/ContextMenu.vue:226-232`）；**开发者指令在生产文案中出现（复核证实，`api/client.ts:356-360`）**；SSE 非 JSON 静默丢弃（`useSse.ts:374-388`）；心跳释放 fire-and-forget（`useHeartbeat.ts:87-120`）；LRU 不驱逐脏档（`stores/doc.ts:143-150`）；**Beta 标签无任何代码判据、15+ 挂点含 1.0 主面（`ui/BetaBadge.vue:2`）**；测试守护面薄（`OverviewView.vue:253-345` 对应仅 1 档 180 行）；遗留死路径未证死（`useBookSwitchGuard.ts:334-346`） |

## 6. 工程质量与治理面（域6，Lead 亲审 + 门禁实测）

### 6.1 实测通过的门（本次真跑，非引用配置）

| 门 | 实测结果 |
|---|---|
| `check:counts` | **通过**：1285 档 / 9332 单测 / 35 spec / 59 用例，与 README 声称完全一致 |
| `check:suppressions` | **通过**：抑制总量 **315/315（贴线 100%，零余量）** |
| `check:comments` | **通过**：src + scripts + 根配置注释零批号标签（扫描 687 文件） |
| `check:docs` / `check:packaging` / `check:harness`（7 项）/ `check:harness-copy` / `check:notes`（3 项） | 全部**通过** |
| `npm audit --audit-level=high` | **通过**：0 条 ≥high；8 条 moderate 全在 dev 链（electron-builder 族） |
| `check:knowledge` | **本机失败（MODULE_NOT_FOUND）——环境问题，非仓库缺陷**：npm 在本机以 Git Bash 的 `sh` 执行 `node_modules/.bin/tsx`（POSIX 包装脚本），而宿主 PATH 无 `sed/dirname` 所致；CI 各腿用各自 shell shim，不受影响。记入 §8 环境限制 |

### 6.2 强项（有配置/代码证据）

- **CI**（`.github/workflows/ci.yml`）：三平台 × 双 Node 矩阵（excl. win×26）、10 分钟级 job 预算经过实测校准（45 分钟）、第三方 action **全量 SHA 钉版**、`permissions: contents: read`、并发组按 ref 取消、npm audit ≥high、tsc + vue-tsc + eslint（3GB 堆帽）+ prettier + 8 check + 覆盖率阈值 + asar 打包冒烟 + Electron 真实建窗冒烟 + 有界 soak 内存门（OK 行数 == 计划段数，fail-closed）。
- **类型与 lint 档位**：`tsconfig` 开 `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noImplicitReturns` + `noUnusedLocals/Parameters` + `noFallthroughCasesInSwitch` + `verbatimModuleSyntax`；生产面接类型感知规则（`no-floating-promises`、unsafe 家族、`no-base-to-string`…）+ 复杂度三规则；实测 src 中 `@ts-ignore` **0**、`: any` **0**、`eslint-disable` 直接指令 **1**，抑制集中入台账。
- **测试守护门（超出常规）**：`.only`/无条件 `.skip` 用 TS AST 检测拒收（`check-counts.mjs:284-314`）、零断言门下沉到**用例粒度**（`findAssertionFreeCases`）、e2e `pageerror` 接线门、e2e spec 顺序快照守卫、双包共享运行时版本对账、README 数字对账——**账实对账从自律升为门禁**，本次实测确实一致。
- **覆盖率**：33 个桶，主桶 `lines 92 / statements 89 / functions 95 / branches 83`，域级子桶更严（`src/events` lines 95、`src/check` statements 93），维护规则为「实测基线 −2pp 只紧不松」+ 守护测试双向核对。
- **破坏性操作留底**：原子写默认 fsync、快照 fail-open 不吞正文、跨进程锁覆盖「校验→落盘」窗口、清单/回收站 RMW 走 strict 读防「空表重写」、迁移墓碑+逆序回滚（域2/域3/域4 多轮证实）。

### 6.3 债与风险（治理面）

| ID | 级别 | 结论 | 证据 |
|---|---|---|---|
| G-01 | P3 | **抑制台账贴线 315/315（零余量）**，其中复杂度类抑制 62 条（complexity 49 + max-depth 7 + max-lines-per-function 6）→ 结构复杂度债被显式冻结，阈值本身偏宽（圈复杂度 25、函数 200 行、深度 5） | `scripts/check-suppressions.mjs:18`；`eslint.config.js:76-80` |
| G-02 | P3 | **test/ 批号叙事体量巨大**：注释 9,675 处 + 用例标题 4,072 处，机制为「上锚不追」（存量永久挂账，仅拦新增） | `scripts/check-counts.mjs:496-499` + 本次实测输出 |
| G-03 | P3 | **注释承载修复沿革**：src 注释占 28.4%（41,152/145,070 行）；门禁只拦批号/日期形态，拦不住「此前/原实现/修复前」式沿革（域4 单域 156 处、域3/域5 同型）→ 与「修复史归 git」纪律系统性张力 | `check-comments.mjs` 扫描面 + 各域 C 节 |
| G-04 | P3 | **CI 触发面窄**：仅 `push main` / `PR→main` / `tag v*`；非 main 分支（如当前 `win`）提交无 CI 背书，靠本地 L2 终门自律 | `.github/workflows/ci.yml:18-23` |
| G-05 | P3 | **win 腿存在已知 flaky 兜底**：「非零退出且零 FAIL 行」即同命令重跑一次——承认存在进程收尾竞态性不确定失败；ubuntu/macos 腿不加重试 | `.github/workflows/ci.yml:164-181` |
| G-06 | P3 | **覆盖率盲区**：`scripts/` 有意不入 coverage（自认接受项）；前端 `views/pages` 通用桶登记 0/0（「e2e 自管」） | `vitest.coverage-buckets.ts:16,71-76` |
| G-07 | P3 | **提交信息规范未机器化**：无前缀提交 136 条（11.7%）；fix 占比 32.1% 高于 feat 22.6%，反映迭代修复密度 | `git log --format=%s` 统计 |
| G-08 | P3 | **发行信任链薄弱（已披露）**：mac 用 ad-hoc 签名 `identity: '-'`、win 便携包 unsigned、无自动更新；与 §4.2 C-05 的「无独立校验锚」叠加，构成供应链面的系统性弱点（发版决策，非实现缺陷） | `electron-builder.yml:59-66,76-88` |

## 7. 简洁与优雅度总评

**好的一面（有代码证据）**：
- **单源化做得彻底**：错误信封、错误码清单、忙闸矩阵、锁原语、SQLite prepared 缓存、`testableConst` 注入工厂、`normalizeWinSeparators`、`retryOnTransientFsError`、`resolveWithinRoot` 等均在注释里点名「原各持一份 → 收编单源」，可验证为真。
- **最难的两处并发面用同一范式**：`src/desktop` 的状态容器 + 转移表 + 单一转移点 + 非法转移记 error（`server-manager.ts:210-251,478-529`；`lifecycle.ts:86-163`）——这是全库最优雅的一段设计。
- **前端纪律面零命中**：全 242 档 `as any`/`@ts-ignore`/`as unknown as`/`deep: true` 均 0；全 120 个 `.vue` 的 93/93 处 `v-for` 带 key、`add/removeEventListener` 与 `setInterval/rAF` 配对无一档失衡。

**负面（按可优化收益排序）**：
1. **注释体量压过代码体量**：`src/ai/runner.ts` 1,261 行中两段核心函数几乎逐句带 3–8 行注释；域3 多档注释占 40–60%（`task-gate.ts` 834 行约六成）；域4 `rag/store.ts` 42%。改一行要读上下三十行，**首读成本已成第一大头**。
2. **注释承载历史叙事**：域1/域3/域4 均发现「批次号、评审批次、被否决方案、修复前后对照」成段出现（`turns-tools.ts:29-38`、`events/store.ts:1-15`、`rag/build.ts:552-567`）——与项目注释纪律直接冲突。
3. **超长文件与函数**：`document/service.ts`(1,283)、`ai/runner.ts`(1,261)、`events/store.ts`(1,137/1,160)、`desktop/server-manager.ts`(1,132/1,187)、`studio/server/index.ts`(827)、`task-gate.ts`(834)；函数级：`runAttemptLoop` ≈250 行、`applySaveLocked` ≈197 行、`executeChatTool` 230 行。
4. **同名不同义**：`rmDirQuietly` 跨文件两套语义（C 表域4）；`manifest.ts` 两处同名不同物（已在头注警示）。
5. **失效锚点**：注释内行号锚有 3 处以上指向无关代码（域1），反向误导读者。

## 8. 无法判断项（合并，按「需要什么才能判」分类）

**A. 需要运行时/真机实测（静态不可判）**
1. P1-01 的 `/book/A → /shelf` 真实导航时序与 `markRaw`/卸载竞态（复核依据为 `watch(immediate)` 结构 + 自述，未启应用实测）。
2. 关窗丢最后一段键入是否**必丢**（`useUnloadFlush.ts:90-110` 的卸载冲刷落定时机未逐行 + 未实测）。
3. 真机平台语义：win `process.kill(pid,'SIGKILL')` 对 utilityProcess 效果、`EBUSY/EPERM` 在杀软占用下的分布、mac `app.relaunch` 时序、外置卷冻结残窗。
4. C-03 的触发概率（`utimes` 瞬态失败频度）与 C-04 实际阻塞时长（等待档常量未读）。
5. 前端超大档运行时性能（200ms 写回窗 CPU、大列表渲染）与 `stores/doc.ts:213/458/500/548/567/622` 六处全文 sha256 是否异步（`shared/revision.ts` 未读）。

**B. 需要网络/CI 历史（本机不可得）**
6. CI 实际绿/红状态与 flaky 频次统计（无 GitHub 侧数据）。
7. Responses 协议线在真机的终止事件形态与非标网关 usage 形态。

**C. 需多书库样本/用户数据**
8. 跨卷重号章（C-01）、`.版本` 目录外部文件、CRLF 档案的实际发生率——均需真实书库抽样。

**D. 覆盖边界（各域声明未通读，结论不可外推）**
9. 域3：`api/` 77 档逐端点只抽样；`process/summary.ts`、`check/run-single-doc.ts`、`leads.ts`、`events/projection.ts`、`chat-bridge` 未通读。
10. 域5：`api/`23 档、`components/ui` 50 档、`components/panels` 21 档、`composables` 22 档、`views` 6 档、`pages` 4 档未逐行。
11. 域4：约 30 档未读（`windows.ts`、`font-cache.ts`、`os-kek.ts`、`scaffold.ts`、`rag/embed.ts` 等）；`main.ts:856-892` 未读。
12. 域1：`src/cache`、`metrics`、`diagnostics`、`learn`、`review` 仅红标扫描；Responses 适配器未逐行。
13. 域2：`.版本` 被同步盘改写概率、前端 dirty 镜像兜底强度（跨域）。

**E. 环境限制（本次审计自身）**
14. `check:knowledge` 在本机因 shell shim 环境失败（§6.1），其**通过与否未实测**；`npm test`、coverage、e2e、soak 同类依赖 tsx/vitest shim，本次均未跑（内存风险 + 环境限制）→ **测试绿态与覆盖率数字本次未独立验证**，只验证了计数门与静态配置。

## 9. 优化路线建议（不改代码，仅排序）

| 优先级 | 建议 | 理由 |
|---|---|---|
| 1 | 修 P1-01：把脏路由离书纳入可见决断，或把镜像清扫延后到冲刷成功 | 唯一「用户数据不可恢复 + 零提示」形态，且三条离书路径口径不一 |
| 2 | 统一「非切书冲刷路径」的可见性（C-09/C-10/C-11 同源） | 关窗钩子、autosave 失败、镜像上限三处都属同一体验缺口，一次收口 |
| 3 | 更新链补三道闸：独立校验锚（或 URL 白名单）、解压资源上限、argv 来源校验 + 防降级断言 | `src/update` 是最年轻最薄模块，四道防线缺失集中在同一链路 |
| 4 | 给事件库加体积观测与阈值告警（C-02） | 「200 万字不崩」是产品承诺，事件库是唯一无上界的长期增长面 |
| 5 | 锁续期失败留痕+重试（C-03）、摘要链改异步孪生（C-04） | 两处都会造成「分钟级重复花钱/全局卡顿」，且都与既有纪律/先例对立 |
| 6 | 注释减重专项：先做 test/ 批号下锚与 src 沿革句压缩 | 收益是全库改读效率，且已有门禁机制可平滑下调锚值 |
| 7 | 补三处零守护面：`src/update/cache.ts` 删除失败分支、`health` 三表上限、A-2/A-3 边缘形态 | 测试架构已支持（锚面清单在案），补齐成本低 |

## 10. 附录

**分域报告**（本轮唯一写入物，均在 `audit-2026-10-19/`）：
- `d1-ai.md`（域1，14 条）、`d2-doc.md`（域2，7 条）、`d3-server.md`（域3，10 条 + 12 条已核健壮清单）、`d4-desktop.md`（域4，15 条）、`d5-web.md`（域5，15 条）
- 第二波复核：`v1-highrisk.md`（6 条高危逐条裁定 + 3 条新发现）、`v2-cross.md`（5 项跨域悬项闭合 + 4 条新发现）

**纪律与诚实边界**：
- 未修改任何源码/配置/测试（Lead 终门实测：`git status --porcelain` 仅 `?? audit-2026-10-19/`，已跟踪文件改动 0）
- 未跑全量测试、coverage、e2e；门禁只实测了 7 条不依赖 vitest shim 的（见 §6.1）
- 两个复核任务各超工具调用预算 2–3 次（因「报告+收口+回报」为必做动作），已由执行者如实记档
- 各域问题密度不可横向比较（域3 已过 ≥5 轮全项目评审，域4 `update` 仅 11 次提交），本报告按「已核健壮面 + 残留边界」口径呈现

---

## 11. 修复落地记录（同日执行）

**修复口径**（作者裁定）：P1 + P2 + P3 **实质缺陷**；报告中标注「维持现状 / 既定取舍 / 需产品拍板」的条目不擅自改动。交付方式：按域分批「改 → 测 → 提交」，由 Lead 统一验证并提交。

### 11.1 提交清单（16 个，均在 `win` 分支）

| # | 提交 | 范围 | 覆盖条目 |
|---|---|---|---|
| 1 | `81950afe` | `src/studio/web-next` | **P1-01** + W-02/W-03/W-04/W-05/W-06/W-07/W-08/W-09/W-10/W-11/W-14/W-15 + 复核新问题 1/2/3 |
| 2 | `3d297d9c` | 服务端/事件/锁/进程 | A1/A2/A3/A4/A5/A6/A7/A8/A9（本域）+ 复核新发现 3 |
| 3 | `cd53aea4` | 文档/格式/版本 | A-1/A-2/A-3/A-4/A-6/A-7 |
| 4 | `c9ced4d1` | AI 链路 | D1-01/D1-02/D1-03(D1-03=P2)/D1-04/D1-05/D1-06/D1-07/D1-09/D1-13/D1-14 + D1-08（掩码收窄） |
| 5 | `f843cf47` | 更新链 P2 | A-1（域名白名单 + 校验值独立获取）/A-2（解压上限）/A-3（argv 来源校验）/A-4（防降级断言） |
| 6 | `1189bcf3` | 更新/检索/知识 + 跨域接线 | A-5/A-6/A-7/A-9/A-10/A-11/A-13/A-14/A-15 + 端点 too-new 透出 + 主进程自愈分流 |
| 7 | `f8ec4249` | 格式/诊断 | A-4 行尾归一收口 + 内容门补 `version`/`knowledge-corpus` 分类 + D1-04/A-4 用例 |
| 8 | `4a0f5813` | README | 单测数 9332 → **9408**（对账门要求账实一致） |
| 9 | `3344aee3` | 服务端（错误码单源） | `RAG_SCHEMA_TOO_NEW` 登记进 `ERROR_CODES`（全量终门顶出后补齐） |
| 10 | `69881fd0` | 更新链 | **A-1 残余收口**：地址与校验清单改「规范 URL 派生」（删域名白名单保持判据单源）+ **D9** 落盘文件名拒路径分隔符 |
| 11 | `fc8a17b4` | 更新/桌面/README | **A-15 用户入口**：便携包根目录恢复脚本（GBK/936 保双击可用）+ README 故障排查一节 |
| 12 | `e1827ba5` | AI 链路 | **D1-04 收尾**：材料登记判据改与 `buildDraftPrompt` 同源（`readSafe`）+ **E1** spec 侧 `toolChoice` 端到端断言 |
| 13 | `340d9cf3` | 服务端/前端 | **D8**：事件库体积进设置页健康项（只 `stat` 库文件、阈值与超阈标记同出 store-retention 单源）+ D8③ URL 契约用例 |
| 14 | `0b7fe7ca` | 前端测试 | **D11**：Beta 挂点白名单守卫（13 档 + 合成样例 + 命中地板） |
| 15 | `d73855fa` | README | 单测数 9408 → **9432**（收尾批新增用例落账） |
| 16 | 本档 | `audit-2026-10-19/` | 审计报告与 7 份分域/复核档入库（E3） |

### 11.2 第一轮验收实测（Lead 独立复跑，非采信执行者报告）

| 面 | 结果 |
|---|---|
| 单测总数 | **9332 → 9408**（+76 条新用例；测试档 1285 未增，全部并入既有档） |
| 域级回归 | `test/studio/webnext` 299 档/2288 例；`test/events|state|process|log|fs|document|format|ai` 473 档/3636 例；`test/install|check`（除 scale）88 档；`test/rag|knowledge|update|desktop|diagnostics` 116 档；批1–3 触碰档 24 档/352 例；掩码+批5 8 档/78 例；批4-P2 7 档/118 例 —— **全部通过** |
| **全量终门** | `vitest run`（`--maxWorkers=2`，766s）：**1279 档通过 / 6 skipped / 0 failed；9823 用例通过 / 77 skipped**，exit 0 |
| 类型 | `tsc --noEmit` 全仓 **零错** |
| lint | `eslint . --max-warnings 0`（3GB 堆帽）**零违规** |
| 账实对账 | `check:counts` 通过（1285 档/9408 单测/35 spec/59 用例与 README 一致） |
| 其余门 | `check:docs`/`check:packaging`/`check:comments`/`check:suppressions`/`check:harness`/`check:harness-copy`/`check:notes` 通过 |
| 中途真实拦截 4 次 | ① 内容门顶出 `version` 未分类（批3 新增日志点）；② 内容门顶出 `knowledge-corpus` 未分类（批4-P3 新增日志点）；③ 账实门顶出 README 数字漂移（+76 用例）；④ 全量终门顶出 `RAG_SCHEMA_TOO_NEW` 未登记进 `ERROR_CODES`（跨域接线新增码）——四处均已按门禁要求收口 |

### 11.3 未修 / 维持 / 残留（诚实清单）

**按口径不动的「既定取舍」**：W-12（LRU 不驱逐脏档）、**W-13 已撤销**（作者口径：项目主体是写作功能，AI 为**辅助层**，辅助面标 Beta 是准确表达——审计「标签语义漂白」判断的前提「AI 是产品主体」不成立；补充核实：AI 辅助层已有成熟的可用性闸 `ui.aiAvailable`（`src/studio/web-next/src` 下 8 档 24 处：AI 不可达即统一置灰 + 透出 `ui.aiReasonText`），故「不能关 / 无回退路径」亦不成立；D11 另把该口径落成机器判据，见批10）、D1-10（LRU 逐出在途对话）、D1-11（预算闸锁外快照）、D1-12（provider store 同毫秒陈旧窗）、域2 A-5（journal 降级裸写）、域3 A10（`/api/boot` 本机信任域）、域4 A-12（同步爬祖残窗）、域4 A-11 契约测试归位（D10 拍板不做）、G-04/G-05/G-07/G-08（CI 触发面、win 腿重跑兜底、提交信息规范、发行签名——均属流程/发行决策）。

**第一轮残留项的最终去向**（原 6 条，5 条已在收尾批闭合）：

| 原残留 | 去向 |
|---|---|
| 1. 域3 A1 健康项/启动通告出口未接 | **已闭**（批8/D8）：体积走设置页健康项，只 `statSync` 库文件**不开只读连接**（避开「只读连接不得用来探路」纪律），阈值与超阈标记同出 `store-retention` 单源；条数仍只在维护路径日志可见（为显示条数另开连接正是该纪律禁止的形态） |
| 2. 域1 D1-04 `statSync` 复检段冗余 | **已闭**（批7/D7）：判据改与 `buildDraftPrompt` 同源（`readSafe`），「stat 成功但读失败」不再反向虚报登记；`log.warn` 留痕保留 |
| 3. 域4 A-1 残余（白名单只锁主机 + 文件名未拒分隔符） | **已闭**（批6）：地址与校验清单改为「编译期仓常量 + tag + 资产名」派生的规范 URL（判据单源，白名单删除）；D9 落盘文件名拒路径分隔符 |
| 4. 域4 A-15 恢复脚本未做 | **已闭**（批9）：`build/recover/恢复更新.bat` 进包根目录（`extraFiles`），双击即把 cwd 挪出应用目录再调 `--recover-interrupted-update`；mac 侧不放脚本（该平台不自我更新，依据见提交说明） |
| 5. 域1 D1-05 spec 端到端断言缺 | **已闭**（批7/E1）：真实 `runSpec` → `generateTool` → `llm/call` 全链，named 家族落 `'tool'`、required 家族落 `'any'`；**D1-07 仍无「回退即变红」用例**（结构不变量，无可观察面），如实保留 |
| 6. 域4 A-11 契约测试落点 | **维持**（D10 拍板不做） |

**本轮仍诚实登记的残留**：
1. 域4 A-1 的**发行体系升级**（内置公钥签名锚）未做——作者拍板「不购证 + 规范 URL 派生」，签名锚属发行体系变更，未排期。
2. **D7 未决①**：清理失败分支与 `buildDraftPrompt` 各读一次材料，两次读之间可读性翻转仍有极窄 TOCTOU（彻底消掉需把读结果沿 `src/process/**` 下传，收益不抵改动面，拍板不做）。
3. **D8 未决①**：体积面只报字节数不报条数（理由见上表第 1 行）；**D8 未决②**：存储卡改恒显（浏览器版也渲染体积，仅「书库目录」行保留桌面门）——已拍板接受。
4. **A-3 未决①**：白名单第 13 条是 `components/ui/CollapseSection.vue`（`BetaBadge` 的受控渲染器，`beta` 由调用方显式开启）；当前按「渲染器也登记 + 写明理由」处理，未做扫描排除特例。
5. 域1 D1-07 无「回退即变红」用例（同第 11.3 表第 5 行）。

**环境限制（未验证面）**：本机 `npm` 系 shim 不可用（`npx` 解析到 `G:\eslint\bin\eslint.js` 即失败），所有脚本门改用 `node <具体入口>` 直跑绕过；e2e/soak/coverage **本轮未跑**（发版批之外不按刀触发）；CI 三腿的真实绿态需在推送后确认。

### 11.4 收尾批验收实测（Lead 独立复跑，含 L2 终门）

| 面 | 结果 |
|---|---|
| 单测总数 | **9408 → 9432**（净 +24；各提交新增用例行数：批6 +11/−3、批9 +4、批7 +3、批8 +4、批10 +6）；测试档 1285 **未增**，全部并入既有档 |
| 三条新用例所在档 | `chat-tool-turn-usage-merge` / `api-endpoints-b` / `api-layer-single-source`：**3 档 37 例通过** |
| 批7/批8 触碰档 | `self-heal-batch-abort-progress`、`style-scan-ttl-cache`、`settings-book`×2、`panel-toast-switch-guard`、`book-rename-conflict-guard`：**6 档 39 例通过** |
| **L2 全量终门** | `vitest run --maxWorkers=2`（790s）：**1279 档通过 / 6 skipped / 0 failed；9845 用例通过 / 77 skipped**，exit 0 |
| 类型 | `tsc --noEmit` 零错；前端 `vue-tsc --noEmit` 零错 |
| lint | `eslint . --max-warnings 0`（4GB 堆帽）**零违规** |
| 九道门 | `check:counts`/`check:docs`/`check:comments`/`check:suppressions`/`check:packaging`/`check:knowledge`/`check:harness`（7 门）/`check:harness-copy`/`check:notes`（3 门）——**全部 exit 0** |
| 账实对账 | `check:counts` 通过（1285 档 / 9432 单测 / 35 spec / 59 用例与 README 一致） |
| 本批真实拦截 1 次 | 账实门顶出 README 单测数漂移（9408 → 9432）：先补批11 对账再提交，未绕过 |

**变异验证汇总（执行者实测，Lead 复核 diff 与还原声明）**：D7「登记判据回退成 stat 复检」→ 断言红；E1「删 `spec.ts` 的 `toolChoice: r.toolChoice` 回传」→ 2 例红（Received undefined）；D8③「URL 段改 `eventstore`」→ URL 断言红；D11「删白名单一条」→ 挂点断言红（失败信息带 `文件:行号（未在白名单）`）。全部还原后哈希/`git status` 自查一致。**D8 体积面未做变异验证**：其单源判据由测试内改测试钩子阈值后断言端点透出同值来覆盖（`__setEventStoreBytesWarnThresholdForTest`），未另做回退实验。

---

## 12. 作者拍板记录（同日）

| 项 | 拍板 | 落地形态 |
|---|---|---|
| 更新链信任锚（域4 A-1 残余） | **规范 URL 派生** | `asset.url` 与校验清单地址必须等于「编译期仓常量 + tag + 资产名」派生的规范 URL；不做内置公钥签名 |
| 发行签名（G-08） | **不购证** | 维持 mac ad-hoc（`identity: '-'`）+ win unsigned，README 已披露 |
| 中断自愈入口（域4 A-15） | **包内根目录放恢复脚本** | 便携包解压即可见 + README 故障排查一节；不做 UI 入口（该场景应用起不来，UI 方案不成立） |
| CI 触发面（G-04） | **维持现状** | 推 `win` 工作分支不需要 CI；合 main / 打 tag 时自然背书 |
| win 腿收尾竞态根因（G-05） | **不投根因** | 判据已保证「真失败首报」，兜底可见可累计 |
| 提交信息机器化（G-07） | **不引入** | 不新增 commitlint/hook |
| D7（D1-04 判据改同源读判据） | **做** | 消除「stat 成功但读失败」的反向虚报 |
| D8（事件库体积出口） | **做，选设置页健康项** | 体积走文件 stat（不为显示新开库），阈值复用观测单源 |
| D9（`download` 文件名拒路径分隔符） | **做** | 纵深防御小加固 |
| D10（A-11 契约测试归位 `test/cache`） | **不做** | 现落点 `test/rag/store-migration-race.test.ts` 更贴真实使用面，归位收益≈0 |
| D11（Beta 挂点白名单守卫） | **做** | 口径落成机器判据，防未来「非 AI 功能被标 Beta」漂移 |
| 其余维持项（W-12、D1-10/11/12、域2 A-5、域3 A10、域4 A-12） | **默认维持** | 报告判定为设计取舍/自陈维持，未翻案 |
| E1（D1-05 的 spec 侧端到端断言） | **补** | 落 `test/ai/chat-tool-turn-usage-merge.test.ts`（与 chat 侧 D1-05 断言同档）：named → `'tool'`、required → `'any'`，走真实 provider 路径读事件库 |
| E2（收尾批是否推 `origin/win`） | **推** | 收尾批 6 个提交 + 前批 9 个提交一并推 `origin/win`（分支为工作分支，按 G-04 拍板不触发 CI） |
| E3（`audit-2026-10-19/` 报告是否入库） | **入库** | 按仓内「不在 `.gitignore` 即入库」判据；报告 + 5 份分域档 + 2 份复核档一并入库（批12） |
| GBK 脚本入库 | **接受非 UTF-8** | 双击可用性硬约束（UTF-8 带/不带 BOM 在 936 控制台下 5/5 失败，GBK 5/5 通过）；仓内现有门不覆盖 `build/`，不红 |
| D8② 存储卡改恒显 | **接受** | 浏览器版连的也是本机 studio server，事件库同样存在；仅「书库目录」行保留桌面门 |
| D8③ 前端 URL 契约用例 | **补** | 并入 `test/studio/webnext/api-endpoints-b.test.ts`，断言 `getEventStoreFootprint` 的实际 URL |
| D7① 双读 TOCTOU 彻底消掉 | **不做** | 需把读结果沿 `src/process/**` 下传，窗口极窄、收益不抵改动面（已写入 11.3 残留） |
| 提交拆分 | **按域拆** | 批6 更新链 / 批7 AI / 批8 健康项 / 批9 恢复入口 / 批10 Beta 守卫 / 批11 README 对账 / 批12 报告入库（批11 必须在批9 之后：同改 `README.md`） |
| L2 终门 | **收口时再跑一次** | 全量 vitest + tsc/vue-tsc + eslint + 九 check（本轮实测见 11.4） |

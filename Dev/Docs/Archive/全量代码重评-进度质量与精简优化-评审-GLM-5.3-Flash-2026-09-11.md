# 全量代码重评-进度质量与精简优化-评审-GLM-5.3-Flash-2026-09-11

> **〔归档记 2026-09-12〕**：本报告已随 R0912 修复批收口归档（作者指令「全部修复，编排任务，并发做。」）——P2×17 全处置 + P3 随批收/维持（明细见下方 §九 收口记与 `Archive/README.md` R0912 修复批批记行）；L2 终门九件套修复后亲跑全绿。原正文（含「未收口」状态行）按「历史正文不改写」纪律保留原样，收口态以本记与 §九 为准。

- **日期**：2026-09-11。**执行模型**：GLM-5.3-Flash（主审 = 会话模型；九路域评审子代理同模型）。
- **作者指令**：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，还有代码的优化与精简可行性，结果形成一个文档给我。记得编排下任务。」
- **评审对象**：mac HEAD `7addf4da`（工作树净，本批文档操作前）；src ≈10.9 万行（.ts/.tsx/.vue 口径 109,233 行 = 代码 75,262 + 注释 27,747〔25.4%〕）+ test ≈16.7 万行（166,770 行）。
- **独立性声明（如实记档）**：本篇为同日第二轮独立重评（第一轮《全量代码重评-进度质量与精简优化-评审-GLM-5.3-2026-09-11》同日在库未收口，下称「重评-0911b」）。按指令全程未读任何既有评审报告与台账正文；九域子代理一律禁读 `Dev/Docs/**`。已知污染面两处如实披露：① 主审勘察阶段读总览作计划基线时见到 §1.3 既有评审摘要行（重评-0911b 的 P2×4 标题级信息，未读正文）；② 落盘同步阶段才读台账/Archive 格式（结论先于阅读成形）。交叉收敛（独立复现/未复现）如实记 §六。
- **结论速览**：进度 **≈96%**（§三）｜质量 **A−**：0 P1 / **P2×17（确认 15 + 疑似 2）归 7 簇**（§四）｜精简可行性：产品代码结构性冗余极低（≈1%），大水面在测试侧脚手架与注释冻结账（§五）。

## 一、任务编排与执行实录

1. **编排**：勘察盘点（结构/行数/脚本/计划基线）→ L2 终门后台实测 → 三波九域子代理评审（波 1：A 桌面壳与基础层 / B 服务端 / C1 前端状态层 / C2 前端视图层；波 2：D AI 编排与协议 / E 流水线与质量闸 / F 持久化·格式·导出 / G 检索·事件·观测+CI 工具链；波 3：H 全仓精简总账）→ 主审逐 P2 对码 → 汇总落盘。
2. **并发限额实录**：子代理派发上限纪律为 ≤4，本环境实测并发限额 = **2 在途**——首波 4 路即有 B/C1 两路即败（user concurrency limit exceeded），B 重派再败一次；改为「完成一个补派一个」流水节奏，全程在途 ≤2，九域全部完成、无一域降级主审代评。
3. **主审亲读**：`ai/runner.ts` 全文、`state/state.ts` 健康检查段、`electron-builder.yml` 全文、前端 WorkbenchView/doc/workspace 证据段；**L2 两条红线亲自查证**（§二）。
4. **主审对码复核清单（全部属实，子代理零虚报）**：A-P2-1 以 `electron-builder --dir` 真实出包 + `asar list` 实锤；A-P3×3（log 掩码/books 缓存 mutate/右键菜单 timer 单槽）；C1-P2-1 双端证据；C2-P2-1/2 前端侧；E-P2-2 引号剥离五消费点；F-P2-1 无消解闭环 grep 证实；F-P2-3 `readManifest` 容错/strict 口径分裂；G 两条 L2 线索定性。

## 二、代码盘点与 L2 终门实测

### 2.1 行数账（排除 node_modules/dist）

| 域 | 行数 | 域 | 行数 |
|---|---|---|---|
| studio/web-next（前端） | 40,664 | studio/server（服务端） | 12,465 |
| ai | 13,619 | document | 7,089 |
| format | 6,421 | desktop | 4,818 |
| process | 4,379 | check | 3,995 |
| events | 3,127 | install | 2,378 |
| rag | 2,109 | fs | 1,511 |
| state / metrics | 各 1,149 | cache | 1,007 |
| review / export / driver / git / knowledge / learn / log | 930/771/694/663/542/513/421 | | |

test 侧 1049 个 vitest 文件（studio 域 432 / ai 126 / document 91 / format 64 为大头）+ e2e 29 specs + soak/governance。

### 2.2 L2 终门八件套实测（mac 口径，2026-09-11）

| 门 | 结果 |
|---|---|
| vitest 全量 | 首跑 1 败（1048 文件过）→ 定位 `test/desktop/check-packaging.test.ts`「真实仓库脚本直跑」用例与**本地 dist 陈旧态耦合**（工作树 dist 存在但缺 fontlist → 直跑 `check-packaging.mjs` exit 1）；`npm run build` 后定向复跑 17/17 绿。**判定全绿：1049 文件 = 6795 过 + 5 跳**（与 README 声称一致） |
| tsc / vue-tsc | 0 错 / 0 错 |
| eslint（--max-warnings 0） | 0/0 |
| check:counts | 过（1049/6795 + 29 spec/45 用例对账一致） |
| check:packaging | 首跑红（同根因：跑序在 tsup build 之前 + dist 陈旧）→ build 后过 |
| check:knowledge | 过（13 条 manifest 一致） |
| build:web | 过 |
| e2e | 43 过 + 2 跳（release smoke 需 CLWRITING_E2E_RELEASE），30.0s |

由实测立两条发现：**G-P2（用例非密闭，升 P2）**与 **G-P3（门文案混叠：陈旧 dist 被报成「tsup onSuccess 拷贝失效回潮」，误导排障；CI 接线两处均安全无需改门序——G 域定性）**。

## 三、完成进度：**≈96%**

- **计划基线**（总览第三节）：阶段 1–23 全部收口；唯一开放任务 = 阶段 24「章节结构操作」（设计方案+执行方案已落盘 2026-09-04，实施待作者指令，代码零足迹）；真开放待拍板决策：无。
- **分域完成度**：九域全部「完成态为主、无烂尾桩」——
  - 前端视图（C2）：产品功能面 14 项（建书向导/设定表单/编辑器/全自动写章/三审/定稿防吃书/伏笔/字数曲线/文风系统/选区 AI/对话助手/设置/审计/导出）**逐项判定完成**，UI 证据齐；断头路专项 = 零真断头。
  - 服务端（B）：端点面覆盖完整（书架/文档协议/机检三审/分析/文风/RAG/双提供方/导出/对话编排全家/SSE+ticket），无纯桩端点。
  - AI 编排（D）：三协议适配器/runTask/self-heal 闭环/chat agent 15 工具全实装；无桩。
  - 持久化（F）：保存协议全链/崩溃恢复/版本档案/回收站/定稿闸/状态机/导出全部实装。
  - 检索事件（G）：events append-only 分库 + RAG 增量索引/损坏自愈 + 审计清理路径全部闭环。
- **登记态半成品清单（非烂尾，多为有意分阶段或待拍板）**：卷复盘 M4（state 5 桩——本轮发现前端把它接到写稿链，升 P2 见 §四）；check-false-positive 查询侧未接线；三审进度 SSE 未实现；writePieceList 生产零接线；switch-provider 决策无消费者；shrink-prompt 仅 chat 面接线；TOKEN_COEFFICIENTS 待语料校准；M3 语义桩（态 2 修复确认）；断连丢字仅水印闭环；文风景样范文回落待知识层数据；ai-track git 后端新书旁路（双后端之一）；`1.md` 形态章号口径分裂。
- **进度判定**：计划内功能全面闭环且生产可用，扣项 = 阶段 24 未开工（计划唯一开放项）+ 上述登记态（占计划面很小比例）→ **≈96%**。

## 四、完成质量：**A−**

**总评**：0 P1；L2 全绿；四条安全/数据红线专项核查全部通过（§4.1）。P2 缺陷集中在「中断语义覆盖面」「恢复面闭环」「门禁密闭性」三类结构性缝隙，主链路（保存协议/机检打回/预算闸/互斥闸矩阵）经查健全。扣分项：P2 确认 15 条中约 5 条有真实用户面影响（假成功烧钱/假警报/幽灵红/打包加固失效）；注释密度已到维护负担临界（25.4%，多处「注释的勘误」出现）；注释锚与代码行为互为证明使重构成本上升。

### 4.1 四专项绿灯（域评 + 主审交叉）

1. **安全三层对码全过**（B 域逐条 + 主审复核）：只绑 127.0.0.1 fail-fast / Host 精确匹配防 DNS rebinding / Origin 白名单 403 / 写+读全令牌闸（常量时间比较）/ SSE 票三凭据闸——与 README 声称逐条一致，路径穿越/未鉴权端点/烧票面全部闭合，**未发现可用绕过**。
2. **api_key 泄漏面闭环**（D 域专项）：vault 信封加密（HKDF→KEK→DEK→AES-GCM+AAD 绑 provider id）、0600 落盘、bak 残留收敛、全部错误出口过 redactSecret——闭环成立。
3. **预算闸不可绕过**（D/E 域 + 主审亲读 runner）：成功/中断/重试/终态失败四路同口径按次入账，Retry-After 封顶，中断不可白嫖重跑；打回重写循环每稿前过闸、重试上限 escalate 保留稿件——**无闷头烧钱路径**。
4. **保存协议与锁序纪律**（F 域）：锁序全仓统一（save→布线→清单）双向注释互指，journal/留底/原子写每步失败有专属信封；恢复面缺口见 P2 簇四。

### 4.2 P2 清单（17 条 = 确认 15 + 疑似 2，归 7 簇）

**簇一：中断语义族 ×4（本轮最大新发现，B/D 两域独立确认 + 前端侧同源）**
1. 【确认】`/interrupt` 对 task-gate 族**完全无效且假成功**——interrupt 只覆盖 abortSelfHeal+abortChat+driver.interrupt（`stream.ts:666-682`），而 outline（`outline.ts:45`）/lead-updates（`lead-updates.ts:46`）/三审逐 lens（`review.ts:346`）/analysis（`analysis.ts:348`）/onboard（`onboard.ts:42`）/relations-mine（`settings.ts:200`）/rewrite 端点（`rewrite.ts:55`）/定稿摘要钩子（`summary.ts:293,627`）的 runTask 均未传 ctrl/register（`runner.ts:515` 登记可选），且在途时 `anyRunning`（`stream.ts:674-679`）为 false → 返回 200 但什么都不停。后果：分钟级任务白烧 API 费，唯一出口重启。修法：端点统一造 ctrl 并 register（或 anyRunning 纳入 task-gate + 如实反馈）。
2. 【确认】self-heal pass 后的账本推进草稿后台任务失联——传 `state.ctrl.signal`（`self-heal.ts:727-728`）但编排收尾后 running Map 已删（:209）、ctrl 已 unregister（`stream.ts:824`）→ 只能跑到 10min 总超时。修法：后台任务持独立登记 ctrl。
3. 【确认】/spawn watchdog「等同作者中断」与 /interrupt 事件面分叉——abortLikeUser 只 abort ctrl 不推 interrupted 事件（`stream.ts:181-183`；对照 self-heal 走 driver.interrupt 会推，:771-775）→ 状态机语义靠 error 兜底。修法：补 driver.emit 或改走 driver.interrupt。
4. 【确认】watchdog 强释放注销 ctrl 后 /interrupt 对该请求永久失效（`stream.ts:781-791` forceRelease 只放闸+注销）——与 1/2 同根「注销即失联」。修法：保留 ctrl 至底层 settle 再注销。

**簇二：打包链 ×1**
5. 【确认·主审出包实锤】**asarUnpack 通配不命中真实产物路径**——`electron-builder.yml:21` 写 `desktop/fontlist`，asar 内实际路径为 `dist/desktop/fontlist`（minimatch 语义无 `**/` 前缀不命中；smartUnpack 只兜 node_modules 来源）；`electron-builder --dir` 实测：`app.asar.unpacked/` 仅 node_modules/font-list 自带二进制，`/dist/desktop/fontlist` 仍在 asar 内。后果链：打包态 `darwinFontListCommand` 改写出的 app.asar.unpacked 路径不存在 → spawn ENOENT → 恒回落 font-list 库（**字体功能不断**），但 R0911-A-P2-1「超时必杀」加固在打包态恒不生效、挂起命令每次白付 10s 熔断；门测试只锁模式字符串不验匹配语义（`check-packaging.test.ts:87-101`）。修法：pattern 改 `**/desktop/fontlist` + 门测试同步 + DMG 实包验证（与 PM-12 残留 DMG 实测并批销账）。

**簇三：功能缺口 ×1**
6. 【确认】**卷复盘两端共同缺口**——state 5 返回 action='volume-review'（`state.ts:875-882`，M4 未实装自认），服务端无任何卷复盘端点；前端 WbStateCard.vue:23-25 把该动作映射为 emit spawn → **点「卷复盘」实际走 writer 链生成下一章正文**（B 域定性：非前端误接线，两端共同缺口）。修法：先拍板卷复盘产品语义，再单立端点或暂改按钮文案。

**簇四：持久化恢复面 ×5**
7. 【确认·主审对码】**save 类崩溃 pending 无消解闭环（幽灵红永久化）**——healthCheck 对 save 类 pending 一律报 crashedWrite（`state.ts:350-370`），compact 恒保留未结算（`journal.ts:342-383`），无 baseRevision×盘上指纹复核、无 acknowledge 通道（grep 证实）→ settled 写失败（`service.ts:629-633` best-effort）后每次进门重复报「可能丢字」，应用内无法清账。修法：确定性复核（指纹不一致 ⇒ 已落盘自动补 settled）+ acknowledge 端点。
8. 【确认】**结构性操作不持 save 锁的双向复活窗**——doTrash 落位（`service.ts:1811`）/doMoveOrRename 落位（:1473）全程无 `<journal>.save.lock`：他进程 save 过守卫后、rename 前 atomicWriteFile 在旧路径复活已删文件（后续还原报 OCCUPIED、清单无条目）；R76-22 登记的只是「复核→写盘」单侧毫秒窗。修法：结构性操作 rename/rm 源前同取 save 锁（锁序先例现成）。
9. 【确认·主审对码】**保存守卫清单读容错口径分裂**——`lookupPathByDocIdAdoptAsync:1567` 用容错版 `readManifest`（瞬态 EBUSY/EACCES → 空表 → 守卫静默失效 → 同内容双文件身份分裂，不丢数据）；RMW 链 :1552/:1583 已 strict（R27-40），同函数回收站守卫 :337 亦 strict。修法：命中读改 strict。
10. 【确认】meta PATCH 双路径写回无 journal pending（`service.ts:1071-1078`/:1328-1334）——「每写必有 pending」协议在元数据链豁免且未登记。修法：补 pending/settled 或头注登记豁免理由。
11. 【疑似】版本列表 ULID 按 `id.localeCompare` 排序（`version.ts:377`）——locale 感知比较对 ASCII alnum 无跨环境字节序保证，时间序=列表序依赖此恒等。修法：改 `<` 比较，零成本。

**簇五：机检与重写 ×2**
12. 【确认·主审对码】**机检引号剥离口径分裂**——checkBodyParts（~`count.ts:879`）与 checkSimile（~:932）吃原文不剥对白 span，同文件禁词（:119）/意象（:483）/开头环境（:1061）均 `stripQuotedSpans`，且 R51-E-N5 注释自证家族约定存在（「同族均剥，唯本检查吃原文」）→ 对白密集章 body-parts/比喻密度系统性虚高，两项又属严格短篇升红族（`runner.ts:377-405`）可驱动打回白烧调用。修法：两处补剥或登记有意口径。
13. 【确认】**重写循环 draftPath 与最新稿脱节（窄触发）**——`loop.draftPath` 仅首稿设定、重写落盘不回写（`self-heal.ts:675-687`/:796 恒打首稿）；tool_use 未命中降级自由文本（:974-978）+ AI 自带异章号 fm 时 `resolveDraftPath` 按章号失配（`format/draft.ts:79-106`）→ 每次重写在 写作/正文 新建孤儿文件、机检恒打首稿旧文件 → 红项恒同烧满 maxAttempts 后 escalate，残留树红点失明的坏 fm 章。修法：rewriteOnce 落盘后以返回 relPath 刷新 `loop.draftPath`（或 saveDraft 内容章号≠入参章号时拒绝/告警）。

**簇六：前端交互 ×1**
14. 【确认·主审双端对码】**切文档假错 toast**——openTab 对 dirty 旧文档 fire `doc.save(id,'autosave')` 并约定 ok===false 即 notify（`workspace.ts:297-302`）；但 save 在 `e.saving`（在途保存正常进行中）与 `e.conflict`（autosave 跳过冲突为设计行为）两条路径**按设计返回 false**（`doc.ts:387-388`/:397）→「切换文档时自动保存失败」为假警报，conflict 文档每次切走必弹。系 2026-09-09 可见化清偿批引入的回归。修法：notify 前复查 dirty 或先 `waitInflightSave`（doDelete:463 有正确先例）。

**簇七：并发与门禁 ×3**
15. 【疑似·限双进程形态】spawn/auto-write/chat 互斥闸只查进程内闸（`stream.ts:593/720/882` 用 heldTaskGatesFor，未并 crossProcessHeldTaskGatesFor）——dev-api/CLI 与 GUI 双进程开同书时细纲覆盖写与写稿互踩（R67-13 要防形态）；`books.ts:243` busyGate 已并两侧。修法现成：换 `allHeldTaskGatesFor`（audit.ts:193）。
16. 【确认】**SessionRecorder.flush 失败路径 pending 无上限累积**（`chat-bridge.ts:183-206`）——持续落库失败（SQLITE_BUSY 耗尽/磁盘满）+ 长对话下无界增长；同文件 ChainRecorder 有 256 上限（chain-bridge.ts:148,197-208），recorder 无对应闸。修法：对齐加上限+留痕。
17. 【确认·主审 L2 实测复现】**check-packaging「真实仓库脚本直跑」用例非密闭**——`check-packaging.test.ts:46-49` 直跑真实脚本，工作树 dist 陈旧态（fontlist 缺）→ 全量单测单点红；CI 免疫（无 dist 跳过/mac 腿 build:all 先行），纯本地污染。修法：用例容忍「问题清单恰为 dist-fontlist 一条」或脚本门改可注入。

### 4.3 P3 清单（≈55 条，分域）

- **A 域 ×4**：log 裸 key 掩码正则缺 `\b` 且 {8,} 与 redact.ts {16,} 不齐（`log/index.ts:190-191`，过掩方向）；appendBookAsync 违反「永不 reject」契约（`init.ts:88` vs `books.ts:330`）；books.jsonl 指纹缓存数组被就地 push（`books.ts:311/330`）；右键菜单取消补发 timer 模块级单槽跨窗互清（`main.ts:1018/1768-1773`）。备案：server-manager 日志误标「已强杀」文案；rebuild.ts 旧 errors meta 键残留。
- **B 域 ×9**：outline/rewrite ABORTED→499 死分支（:91/:141）；/interrupt 判定与 ensureSession await 竞态窗假事件（stream.ts:679-682）；个别 4xx/5xx 泄内部绝对路径（overview.ts:146 等，与 index.ts:433 口径不一致）；providers.ts 并发写残窗（:121 兼容口）；chat.clear 断发起者自己 SSE（stream.ts:1068）；chat.send/regenerate 闸复检三段复制（漂移史 R32-7）；settings relations-mine 无 BOOK_MOVED 重验；defineRoute parse 迁移欠账（schema.ts:13 自记）；SSE 豁免表与凭据闸分居两文件正则耦合。
- **C1 域 ×7**：overwriteRemote 缺条目身份复检（doc.ts:515-531）；trace-stats 双拉（WorkbenchView:65 + WbUsageCard:46，佐证 C2 疑点）；store 模块级循环引用 ×3（惰性调用纪律维持）；discard 不清 inflightOpens（doc.ts:781-785）；regenerate 本地截断可丢 steer 排队消息显示（chat.ts:573-576 窄窗）；`?token=` URL 回退通道现行（R50-D2-2 已知，建议挂下线期限）；跨零点今日字数短时按昨日口径（自愈型）。
- **C2 域 ×8**：工作台两处 pending 文案死代码（WorkbenchView:415-433）；浏览器版「书库管理」静默无响应（Ribbon:42-47）；总览主请求失败后仍发 3 个子请求（OverviewView:63-80）；ErrorBoundary 重试无 key 重挂（:15-17）；AuditView 展开全量 JSON.stringify 大 payload（:283-288）；ChatDock 极窄窗宽度 ≤0（:161）；`display:contents` 叠 role=group 语义面（ChapterTreeItem:259）；ContextMenu 飞出层键盘不可达（既有挂账复核属实）。
- **D 域 ×6**：mock 快路 ctrl 与外部 register 脱钩（runner.ts:463/472）；chat 嵌套 write_chapter abort 桥接微窗口（turns.ts:243-249 疑似）；Anthropic `pause_turn` 半截产出按成功出场（anthropic-adapter.ts:436 疑似）；三线 stopReason 命名未归一（R30-13 维持）；checkAiCallBudget 锁外快照读（已裁定取舍）；llm/call 全量语义（PM-10 已核）。
- **E 域 ×6**：树红点聚合无中断通道（check/run.ts:450-461）；备料 RAG 召回不随编排中断（materials.ts:230-238）；learn 收割锁在全书扫描后（learn/index.ts:152-292）；近况段无界且免裁（assemble.ts:111-119 + prepare 刚需不砍）；learn 金句 UTF-16 口径（:243-244）；SIMILE_RE 前排他集注释-实现漂移（count.ts:912-924）。
- **F 域 ×7**：journal 双读翻倍（state.ts:644 vs :350）；doMoveOrRename settled 重复整读（service.ts:1526）；meta PATCH 2MB 章瞬时 8MB 字符串（:1065）；TrashEntry 缺 parentId 层级投影清零（trash.ts:28-47）；scanCloudCopies 跳过表缺工作区面（git/exec.ts:317）；words-diary 无 fsync + finalizedLost 逐条 statSync 无 TTL；manifest 同步重入快道声明边界（manifest.ts:372-405）。
- **G 域 ×6**：check:packaging 门文案混叠（check-packaging.mjs:169，主审 L2 线索②定性）；事件库删除无 VACUUM（删史后磁盘不归还）；SessionRecorder flushedSeqs 线性增长（疑似·登记观察）；soak 门 tsx 丢 `--expose-gc` 时假绿（CI 步未断言 OK）；短篇集索引章纲不递归匹配（short-index.ts:178-211 疑似）；log 双词表无交叉对账测试（maskKeys vs redactSecret 漂移无门）。
- **主审 L2 实测 ×2**：直跑用例 dist 耦合（已升 G-P2 条 17）；packaging 门跑序伪红（并入门文案 P3）。

### 4.4 与既有登记的交叉收敛

重评-0911b 四项 P2：**三项本轮独立复现**（openTab 切档假警报 = 本轮条 14；机检剥引号口径分裂 = 本轮条 12；ai→studio 反向依赖 = D 域自代码注释复核属实）——两轮独立评审同日执行、结论收敛，可信度互证；**一项未复现**（rag/rebuild 前端断头：G 域判 RAG 域完整、未核失配文案与前端接线指向）——该项维持重评-0911b 登记效力待修，本轮不推翻亦不背书。本轮 13 项新 P2 为重评-0911b 未覆盖面（中断族/打包链/恢复面为主），两轮盲区互补。

## 五、精简优化可行性：**产品代码本身高度精练，大水面在测试侧与注释账**

### 5.1 全仓精简总账（H 域跨域横向，AST 导出面全扫 + 滑窗重复检测）

| 档 | 内容 | 区间 |
|---|---|---|
| 一档·零风险死码 | useDebouncedSource 连测试 166 行 / events/types 16 个旧载荷接口 ~100 / 散点死类型 19 处 ~150 等（生产+测试全零引用，grep 证实） | **330–380 行** |
| 二档·低风险合并 | **前端三组双实现为最大点对**：ChatDock↔ChatPanel composer（滑窗 108 窗，150–250）/ ShelfHeroCard↔ShelfModalHero（180–220）/ Shelf↔ShelfModal（50–80）；driver cc↔mock 总线（60–90）/ Book.vue 切书取消分支三份（60–80）/ chat 闸复检族 / 仿树行样式三份 / style 面板家族；over-export 收紧 234 处（API 面卫生） | **550–860 行** |
| 三档·中风险拆分 | oversized 29 个（>600 行）纯移动拆分，净减 ≈0 但解锁维护：main.ts 2227→windows/bootstrap/ipc 三件、service.ts 1959→save-pipeline/meta-ops、stream.ts 1072 三拆、self-heal 1038 三拆等（前 10 拆分建议见 H 域账） | 净减 ≈0 |
| 四档·注释冻结剪枝（需作者拍板，按冻结纪律剪出归档非直删） | src 注释 27,747 行（25.4%），含 Rxx 轮次锚 ~4,006；理论回收纯沿革批注 60–80% = src 2.4k–4k + test 2k–3k；**不可剪** = 承载现行语义约束段（取消分支不变式/内存闸口径/防线语义等）；建议不做全仓专项，只在三档拆分时顺带判别迁移 | 理论 4.4k–7k 行 |
| 五档·测试侧 | `function req(` HTTP 帮手 46 份归一（800–1,100）/ 书架脚手架 mkdtemp 344 文件抽 makeBook() 工厂（1,500–3,000）/ 大段复制点对（desktop harness 109 窗等，500–900） | **2.8k–5.0k 行** |
| 观察项·迁移退役（需拍板，不计数） | 六族启动迁移 ~1,390 行 + token-calibration ~195 行——存量全迁移确认后可「版本门闩退役」 | 1.4k–1.6k 行 |

**总计**：产品侧结构性冗余 **≈0.9k–1.2k 行（约 src 的 1%）**——依赖面零闲置（根 deps 3 + devDeps 17 + web-next 12 全在用；esbuild 钉版有完整因由注记不动）、零导入孤儿文件仅 5 个且全为合法入口。**若拍板注释剪枝+迁移退役，产品侧理论回收可达 ~4.7k–6.8k；测试侧另有 2.8k–5k。**

### 5.2 可行性结论

- **值得立项**：① 前端三组双实现合并批（一档+二档主力，收益明确风险低-中）；② 测试侧脚手架归一批（最大水面，与回归锚纪律兼容——归一不改语义）；③ oversized 拆分随下次功能批顺带做（不立专项）。
- **需作者拍板**：注释冻结剪枝的口径（建议按「拆分顺带判别」推进而非全仓专项）；迁移退役时机；`useDebouncedSource` 等 19 处死类型删除批。
- **不建议动**：同步/异步孪生中有意保留的等价对照面、热点函数的逐轮锚定测试散布（format/yaml 被 82 个测试文件引）、锚注记中的现行语义约束段。

## 六、执行口径补充

- 子代理阅读口径：九域报告均附诚实全读/略读名单（B 域 50 文件 100% 逐行；F 域 document/format 全读；C1 stores/composables/api 全读；C2 视图全读 + 设置域模式扫描；D 三适配器/self-heal/chat 族全读；H 结构性扫描 + 抽样复核）。主审对码 10 项全部吻合，未发现子代理虚报；两条【疑似】维持疑似定级。
- L2 九件套中 soak 未入本轮实测（时间盒内以八件套为准；soak 门假绿风险见 G-P3）。
- 本批零代码改动（纯评审 + 文档链）。

## 七、处置建议（未收口，待修复批指令）

- **必修建议（P2）优先序**：① 中断族四条（结构性缝隙、假成功烧钱，一个批内统一收口：端点 register + anyRunning 纳闸 + watchdog 两处）→ ② asarUnpack 一行修 + DMG 实包验证（与 PM-12 残留单立项并批销账）→ ③ F 恢复面四件（幽灵红复核 + save 锁 + strict 读 + meta pending 登记）→ ④ openTab 假错 + 剥引号两处 + draftPath 回写（小修）→ ⑤ SessionRecorder 加闸 + check-packaging 用例密闭 → ⑥ volume-review 先拍板产品语义再立端点。疑似两条（双进程闸/ULID）修法现成、成本极低，建议随批。
- **P3**：≈55 条中建议随批收 ~30（死分支删除/文案口径/IO 小优化/对账测试），维持登记 ~25（与既有台账同类取舍）。
- **精简批**：建议与修复批分开编排——先「死码+死类型删除批」（零风险），再「前端双实现合并批」（需回归测试护航），测试侧脚手架归一批量力分批。
- **收口条件**：P1/P2 修复 + L2 终门回归通过后，本报告随下一轮收口批归档。

## 八、文档链同步记

本批落盘：`01-评审/` 新落本篇（01-评审 1→2）；主 README 计数与游离件注记同步；总览 §1.3 增行（第九篇）；台账 §一 增行 + §三 A/B/C/D/E/F/G/H 各域新登记/复现注记；Archive/README 批记行。零代码改动。

## 九、修复批收口记（2026-09-12，作者指令「全部修复，编排任务，并发做。」）

**编排**：环境子代理并发限额实测 2 在途——六路域修复代理按 3 波两两并发（波 1 SRV-A 中断族核心 ∥ CORE 持久化恢复面；波 2 SRV-B 端点接线 ∥ FE web-next；波 3 D/AI 后台中断与流水线 ∥ CHECK 机检与事件）+ 主审同批亲修（TOOL 打包链 + DESK 桌面壳/基础层）+ 三项主审集成（见下），全程文件互斥无撞车。改动锚记前缀 R0912-。

**P2×17 处置映射（7 簇全清）**：
- 簇一中断语义族×4：① 七端点统一 register-ctrl 接入 /interrupt 通道（SRV-B：outline/lead-updates/review/analysis〔按 action 分槽〕/onboard/settings relations-mine/rewrite，owner `<端点>:<书名>`；注册点=编排段起点覆盖全部 await 窗）+ /interrupt 返回如实附 `interrupted:true/false`（SRV-A）；② self-heal 后台账本草稿改独立登记 ctrl（`bg-lead-draft:<书名>`，D/AI 新 helper `runRegisteredBgTask`，settle 一律注销）+ 定稿摘要钩子 documents.ts 调用点惰性 ensureSession 接线（主审集成）；③ spawn watchdog 改走 driver.interrupt 完整动作集推 interrupted 事件（SRV-A）；④ 强释放删提前注销、ctrl 留册至底层 settle（spawn/self-heal 两处，SRV-A）。
- 簇二打包链：asarUnpack 模式改 `**/desktop/fontlist` + 门同步校验「可命中真实路径」、裸模式判红（主审）——`electron-builder --dir` 实包复验 `app.asar.unpacked/dist/desktop/fontlist` 在位（137KB 带执行位）。
- 簇三功能缺口：卷复盘按钮文案对齐实际行为（「继续写作（下一章）」+ 规划中注记，emit spawn 语义不变；产品语义仍【待拍板】登记台账，FE）。
- 簇四持久化恢复面×5：save 类 pending 确定性自动消解（盘上指纹 vs baseRevision 比对，含 null/ENOENT/EBUSY 边界）+ `POST /api/books/:name/journal/:opId/acknowledge` 人工半边（CORE）+ `/state` payload 透出 `crashedPendingOpIds`（主审集成，FE 忽略按钮接线贯通）；结构性操作落位段补 save 锁（doTrash/doMoveOrRename，锁序 save→journal→清单）；保存守卫清单读 strict 化（六调用面收口 WRITE_ERROR）；meta PATCH 双路径真补 pending/settled（选「真补」非豁免）；ULID 改字节序比较。
- 簇五机检与重写：body-parts/simile 补 `stripQuotedSpans`（含 R73-14 注释漂移修账）；重写循环 draftPath 以 save 返回 relPath 回写 + 异章号 warn 防线。
- 簇六前端交互：openTab 先 `waitInflightSave` 再查 dirty/conflict 分流，假警报消除。
- 簇七并发与门禁：spawn/auto-write/chat 互斥闸换 `allHeldTaskGatesFor`（含跨进程锁文件面）；SessionRecorder flush 失败路径 pending 256 上限 + 丢弃留痕 + 批内序号平移加固；check-packaging「真实仓库脚本直跑」用例密闭化（`CLW_CHECK_PACKAGING_SKIP_DIST_GATE=1`）+ 门文案两态区分（陈旧 dist vs 拷贝失效）。

**主审亲修（TOOL+DESK）**：log 掩码词首断言（lookbehind——`\b` 不足以修 `task-sk-` 形态）+ 双词表对账测试；books.jsonl 指纹缓存边界浅拷贝 + `appendBookAsync` 写段契约（darwin `chflags` 装置精确命中写段 catch）；右键菜单取消补发 per-sender 分槽（旧单槽语义测试改写为「同窗清旧+跨窗互不清」双锚）；ci.yml soak 门加 `[soak] OK` 断言（假绿拦截）。

**主审集成三项**：① task-gate 依赖倒置——ai 层新建 `orchestrate/task-gate-port.ts`，turns.ts 换端口取闸、stream.ts 注册真实闸（重评-0911b P2③ ai→studio 反向依赖同批收口；5 用例锚定含分层源锚）；② `/state` payload 透出 crashedPendingOpIds；③ documents.ts 定稿摘要钩子惰性 ensureSession 接线。

**P3 随批收 22 / 维持登记 21**：随批 = A 域×4（log 掩码/books 契约/缓存 mutate/菜单 timer）、B 域×4（interrupt 竞态窗/闸复检 helper/SSE 豁免单源/relations-mine 重验；路径泄漏项核实七文件无 `${绝对路径}` 直拼、按「无则不动」）、C1 域×3（overwriteRemote/discard/trace-stats store）、C2 域×5（pending 死文案/Ribbon/OverviewView/ErrorBoundary/AuditView 懒展开）、D 域×1（mock ctrl 契约）、E 域×4（learn 锁前移/近况 cap/RAG 召回 signal/UTF-16 码位）、F 域×3（journal 双读/settled 整读/scanCloudCopies 跳过表）、G 域×2（门文案/soak 断言）+ SIMILE_RE 注释漂移；维持登记 = B×5（providers RMW 兼容口/chat.clear SSE/defineRoute parse 债/SSE 免表外子族）、C1×4（循环引用纪律/regenerate 截断窄窗/`?token=` 通道/跨零点字数）、C2×3（极窄窗/display:contents/ContextMenu 飞出层）、D×5（write_chapter 桥接微窗/pause_turn〔登记待设计〕/stopReason 三线/预算锁外快照/llm 全量）、E×1（树红点聚合无中断通道〔随 batch 改动面让位，登记〕）、F×2（TrashEntry parentId/words-diary fsync）、G×2（flushedSeqs 观察/短篇章纲递归）等，逐条已在台账 §三 与代码注释档。

**重评-0911b 四项 P2 同批清账**：① rag/rebuild 前端断头 → FE 接 rebuild + RagStatus 补 indexState/indexModelMismatch（服务端字段已有零改动）；② openTab 假警报 → 簇六；③ ai→studio 反向依赖 → 集成①；④ 剥引号口径分裂 → 簇五。

**L2 终门修复后亲跑全绿**：vitest 1078 文件 = 6937 过 + 5 跳 0 败〔156.92s；净增 29 文件/142 用例，全部 R0912- 锚〕+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 1078/6937 + 29/45 对账一致；packaging 含新模式门；knowledge 13 条）+ build:web 过 + e2e 43 过 2 跳〔28.2s〕+ soak 两段 `[soak] OK`（CI 同款断言过）+ `electron-builder --dir` 出包复验 unpacked 落位。根 README 修账 1049/6795 → 1078/6937 四处（win 按差值预期 1078 文件 / 6862 过 + 80 跳，待 CI 实跑确认）。本报告随批归档 `Archive/`，台账 §一 双行冻结 `台账历史明细-归档-2026-09-08.md` §七。

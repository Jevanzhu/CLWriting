# 全项目源码完成度与简洁度评审（独立重审）

- **执行模型**：DeepSeek-Flash（new-provider/deepseek-flash）
- **日期**：2026-10-12
- **基线**：`mac` 分支 HEAD `6ad22cea`（工作区 clean，未做任何修改）
- **范围**：`src/` 全量（ts 约 105,571 行 + vue 约 29,096 行）、`test/`（约 229,909 行 / 1308 档）、`scripts/` 16 档、构建与 CI 配置（tsup / vitest / eslint / electron-builder / 两个 workflow）
- **独立声明**：本轮不读 `Dev/Docs/` 既有评审报告，按源码重新得出；结论与既有批次无关。**本轮不修复**，只出报告。
- **方法**：主控实跑客观门（vitest 全量、`check:counts`、抑制表统计、结构与规模统计）+ 六路分域读码审计（desktop/install/update；ai/process/knowledge/learn/rag；studio-server/document/format/check；web-next 前端；events/state/cache/metrics/fs/log/diagnostics/git/review/export/shared；工程门与测试体系），关键结论逐条回源复核，其中两处用一次性探针实证。

---

## 一、总体结论

**完成质量：高水位。** 这是 rc.4 阶段相当扎实的一份工程：核心链路（建书 → 大纲/设定 → 起草 → 机检 → 三审 → 定稿 → 导出）闭环，AI 三协议适配、多库多窗、RAG 索引、事件审计、版本快照、诊断包、txt 导出均已落地为可用实现，不是演示壳。全域 `src/` 零 `TODO/FIXME/HACK`、零 `@ts-ignore/as any`（唯一命中的 "TODO" 是知识层文案字面量），`tsc --noEmit` 与 `vue-tsc` 零错，这在国内同体量 Electron 项目里属于明显偏好的水平。

**但当前 HEAD 不是"全绿"状态**：macOS 上 `npm test` 实测 **1308 档中 1 档失败（1 用例）**，失败档为 `test/studio/server/books-delete-graveyard.test.ts`，两次运行（全量 + 单档）均确定性复现，且这门失败在 win 本机终门与 CI 里都被结构性掩盖（见 P1-1）。README 对外声称的"1308 个测试文件 / 8766 单测全绿是合入门槛"在当前提交上不成立。

**完成进度：约 90% 可发布。** 距离 1.0 的硬缺口不是功能，而是四类收口：① 当前红的测试；② 若干"半接线"功能（UI 已暴露、后端只写不读或只占位）；③ 口径类债（token 系数、估算入账、chat 成本）；④ 打包态路径错位（诊断包）。另有 1 项设计已出未实施（便携版自更新）、1 项明确未做（代码签名）。

**简洁优雅度：中上偏优，但有两处系统性负担。** 正面是真实的：单源收敛（`RENDER_CAP`、`STOP_REASONS`、`PROVIDERS_FILE`、`diagnosticsDirOf`、`raceWithTimeout`、`killProcAwaitEscalating` 等）、`defineRoute` 声明式路由（116 条零裸注册）、`createTtlProbeCache` + 机器门自登记等。负担是：**超长函数**（30+ 处 >120 行，最大 517 行）与**注释密度**（runner 32%、provider/store 42%、anthropic-adapter 43%，其中约 241 处是"此前/曾/勘误/作废"式沿革叙事，注释在替 changelog 打工），以及 `eslint-suppressions.json` 冻结的 **348 条抑制**（含 complexity 52 条、no-base-to-string 83 条）。

---

## 二、客观门实测数据（本轮实跑，可复现）

| 项 | 实测 | 说明 |
|---|---|---|
| `npm test` 全量 | **1308 档：1 failed / 1307 passed；9244 用例：1 failed / 9237 passed / 6 skipped；164s** | 失败档见 P1-1；运行期用例数 9244 与门禁静态口径 8766 不是同一算法（静态枚举 vs 运行期展开） |
| `npm run check:counts` | 通过（exit 0）：1308 档 / 8766 单测 / 35 spec / 59 用例 / Archive 4 篇 | 声称值与实测一致 |
| `src/` 死码扫描 | `TODO/FIXME/HACK/XXX`、`@ts-ignore/@ts-expect-error`、`as any` 均 **0 命中** | 唯一命中是 `knowledge/update.ts:138` 的文案字面量 |
| eslint 抑制表 | **348 条 / 143 档**：no-base-to-string 83、no-unnecessary-type-assertion 76、complexity 52、no-unsafe-assignment 29、require-await 16、max-depth 13、max-lines-per-function 11、no-misused-promises 10… | web-next 占 75 条 |
| 源码规模 | `src/` ts 105,571 行 / 690 档（含 vue 共 ~134,667 行） | 最大档：document/service.ts 1289、ai/runner.ts 1232、desktop/server-manager.ts 1146、events/store.ts 1116 |
| 测试规模 | 229,909 行 / 1381 档；测试:源码 ≈ 1.8:1 | 均值 6.6 用例/档，中位 4 |
| 提交史 | 1033 提交；近 5 提交均为评审收口批 | 工程节奏稳定 |

覆盖率未在本轮重测（默认门在 CI ubuntu 腿）。仓库 `vitest.config.ts:113,179` 载明：全局阈值门基线 statements/lines 84.43、branches 80.96、functions 95；主桶（除 web-next）基线 statements 91.19 / branches 85.10，逐域阈值即此基线 −2pp 向下取整。前端 `{pages,views}/**` 为 0/0 显式登记桶（详见 P2-23）。

---

## 三、P1（建议收口前处理，共 5 组）

### P1-1 当前 HEAD 在 macOS/Linux 上确定性失败：测试自身缺建目录

- **位置**：`test/studio/server/books-delete-graveyard.test.ts:205-216`（HEAD 新增用例）
- **现象**：`symlinkSync(outside, linkPath, 'dir')` 的目标父目录 `.删书墓地/` 从未创建 → `ENOENT`。本轮全量跑与单档跑各复现一次（`1 failed`）。根因是 HEAD 把原"三断言合一"的用例拆成两条时，新用例丢失了原用例通过 `mkdirSync(sweepable)` 递归创建的墓地目录（旧用例的副作用被拆走了）。
- **后果**：① 主开发平台（macOS）上 `npm test` 恒红，合入门槛实质失守；② 更值得注意的是漏网链路——`ci.yml` 触发面只有 `push main`、`tags v*`、`PR→main`（`ci.yml:20-26`），`mac` 分支本地领先 `origin/main` 12 个提交且从未触发 CI；HEAD 的终门是在 win 本机跑的，而 win 非开发者模式下 `canSymlink` 探测为 false → 该用例被 `skipIf` 跳过（`books-delete-graveyard.test.ts:44-60`）。即"能力探测跳过"把一处 mac 专属失败洗成了 win 绿。
- **建议**：用例内补 `mkdirSync(graveyard, { recursive: true })`；顺手把 `canSymlink` 探测口径改为"失败即跳过并打印原因"，避免跳过面静默扩大。流程侧建议把 `mac` 分支纳入 CI 触发（或收口前强制 `mac` 分支全量实跑留证）。

### P1-2 `PATCH documents/:docId` 的 `op:'fm'` 键名无校验 → front matter 键注入

- **位置**：`src/studio/server/api/documents-crud.ts:182-189` → `src/document/service-meta.ts:488-497` → `src/format/frontmatter.ts:305-312`
- **现象**：服务端只校验 fm 的**值**形状（`isFmWritableValue`，`frontmatter.ts:154`），**键名**经 `Object.entries` 逐字拼进补丁行，无任何白名单。本轮用探针直接实证（`patchFlatFm` 单函数调用）：

  ```
  输入键 'x\n字数目标'（值 999）→ 盘面多出两行：
      章号: 1 / 标题: 测试 / (空行) / x / 字数目标: 999
  输入键 '标题: 999'（值 'x'）→ 产出伪值行：
      章号: 1 / 标题: 测试 / (空行) / 标题: 999: x
  ```

- **后果**：一次合法请求即可在任意文档的 fm 里注入/改写其他顶层键，回读为脏值且无错误透出；写成字符串的 `章号` 会连带影响一切按章号派生的逻辑（排序、账本 join、版本归属）。
- **可达性判定（重要）**：前端 UI **不可达**——`updateDocMeta` 的键来自 `MetaFormPanel.vue` 的 `FIELD_DEFS`（60 个静态键）与 `AnalysisPanel.vue` 的 infer-meta 结果，而服务端 `infer-meta` 只产出「目标情绪/核心反转」两个键（`analysis.ts:570-575` 显式白名单）。但 HTTP 端点本身没有键名闸，**同机任意进程可直连本机端口**（有 token 门，但 token 对本机文件系统可读用户不构成边界）。属"边界缺口确定存在、当前 UI 不可达"。
- **建议**：键名 fail-loud 白名单，拒 `\n`、`\r`、`:`、空串与首尾空白（`patchFlatFm` 内统一收口，同时保护其余调用方）。

### P1-3 诊断包在打包态"日志/"段为空，且「打开诊断包目录」按钮无反应

- **位置**：`src/desktop/main.ts:95`（`homeDir = appDataHomeDir()`）＋ `:98`（`app.setPath('userData', instanceUserDataPath(instanceKey))`）＋ `:126`（`initLogging({ logsDir: join(app.getPath('userData'), 'logs') })` = 实例目录）对 `src/desktop/main.ts:427`（`userDataPath: homeDir` 传给 server）对 `src/diagnostics/index.ts:278`（`collectLogEntries(join(userDataPath, 'logs'))` = 共享根/logs）
- **现象**：日志实际写在 `<home>/instances/<key>/logs`，诊断包却去读 `<home>/logs`（不存在）→ 包内「日志/」段恒空（`src/log/index.ts:127` 对不存在目录返回 `[]`，不报错）。同一处错位还使 `src/desktop/ipc.ts:388-390` 的「打开诊断包目录」（`diagnosticsDirOf(app.getPath('userData'))` 指向实例目录）在包实际落于共享根时 `existsSync` 失败直接 return——**按钮点了没反应，且不留痕**。
- **后果**：rc.4 刚入库的诊断包（`8c3d84c0`）在最需要它的场景（打包态用户报障）里丢掉主证据；排查件只剩环境/配置两段。这是"功能落地了但打不通"的典型。
- **建议**：以共享根为单源——日志段按 `instances/*/logs` 枚举（多实例日志都要收），IPC 侧改用 `appDataHomeDir()` 推导包目录，并让 `existsSync` 失败走 warn 而非静默 return。

### P1-4 "半接线"三件：UI 已暴露的操作实际不生效

| 项 | 位置 | 现象 → 后果 |
|---|---|---|
| 机检误报标记只写不读 | `src/studio/server/api/check.ts:109-116`（注释自陈"查询侧尚未接线"） | 前端可标记误报、落 `check/false-positive` 事件，但 `src/` 全仓无读取方 → 用户标记完重查仍报同一条，事件库单向增长。功能不闭环。 |
| prefs 并发守卫已实现、客户端不带 `expectedRevision` | `src/studio/server/api/prefs.ts:15-20`（注释自陈"守卫契约先收口，前端接线后即生效"） | 当前恒放行 → 两个面板并发保存仍是后写覆盖先写，409/REVISION_CONFLICT 契约占位但未生效。 |
| `writePieceList` 抛错占位 | `src/format/manifest.ts:44-50` | 故意 fail-loud（防新链路误接，方向正确），但"章纲写入"这条路径至今无生产实现——需明确它是否属 1.0 范围。 |

- **共同建议**：三项各自二选一——接线，或在 UI/文档上显式标"未启用"，不要停留在"看起来能用"的中间态。

### P1-5 成本与预算口径：估算入账恒用兜底系数，chat 金额不入账

- **位置**：`src/shared/tokens.ts:24-31`（`TOKEN_COEFFICIENTS` 空表，自陈"尚未实测"）→ `src/ai/provider/usage-estimate.ts:31-40`（网关不回 usage 时按此估算**入账**）→ `src/ai/calls.ts:603-605`（`applyCall` 累计 `costAccum`）对 `:691-697`（`applyTaskUsage` 只累次数与 token，无 cost）
- **现象**：① 部分 OpenAI 兼容网关/中转不回 usage，此时按估算值记入预算与成本报表，而估算恒用 0.6 token/字，且**不含 tools schema 与消息包装**（15 个工具数千 token 量级）→ 系统性低估；② chat/摘要走 `task:'chat'` 且不传 `chapter`，因此 `tasks` 块永无金额，chat 成本只能事后按"当前价表"重算（调价即历史漂移，`cost-stats.ts` 头注已承认）。
- **后果**：预算闸（tokens/cost 两指标）对这类端点偏松，成本报表偏低——直接关系钱。
- **建议**：先跑一次 `scripts/calibrate-tokens.ts` 回填系数表（或在估算入口显式补 tools/包装增量并声明误差上界）；`tasks` 块补 `costAccum`（runner 已算过 cost，仅落点问题，改动面小）。

---

## 四、P2（质量债与应优化项）

**A. 运行时与数据面**
1. **事件库无界增长**：`src/events/store.ts:828-845` 全库无 `VACUUM`/`journal_size_limit`/`auto_vacuum`，events 表无保留策略；"清空对话"按书 DELETE 行但文件高水位不回落。长期写作 + 多轮对话下 `<userData>/clwriting/session/<hash>.db` 单向膨胀。建议加保留策略（N 天/条）与阈值 VACUUM。
2. **导出内核不可取消**：`src/export/run-async.ts:20-35`、`src/export/index.ts:511-630` 无 AbortSignal 透传，只有 120s 超时 terminate。大书导出中取消/切书/停服务时，worker 占满 task-gate 槽至多 120s，该书后续导出排队 503；部分产物仅靠 warnings 收口，无回滚。
3. **启动链同步 git 阻塞**：`src/git/exec.ts:39,232` 的 `spawnSync`（15s 帽）经 `src/install/layout-migrations.ts:86` 进入旧书布局迁移，在启动期同步执行。网盘挂载/杀软锁 `.git` 时窗口白屏至多 15s×N；异步孪生未接入此链。
4. **诊断包载荷越隐私红线**：`src/diagnostics/index.ts:52-61` 的脱敏名单未含 `check`/`metrics` 族，而这些载荷是章文件路径（含书名/章标题）与原样 `errMsg`（`src/check/run-tree-issues.ts:346`、`run-single-doc.ts:121,183`、`src/metrics/short-index.ts:202`）；对账用例只识别实参含 `slice(` 的调用点，模板串形态不在网内。与模块自述"不携带书库文本"相悖。
5. **事件库在线自检默认关**：`src/events/store.ts:797` 的 `CLWRITING_EVENTS_SELF_CHECK` 为 env 门控，`deriveMessages` 仅测试消费——compaction 遮蔽区间写坏时无任何在线告警，只能事后重放发现。
6. **共享根 tmp 无清扫**：`src/fs/atomic.ts:428` 的临时文件清扫唯一调用点在 `src/state/health.ts:121`（恒传书库根），providers.json/prefs/workdir.json/诊断包的 atomic 写发生在共享根与实例目录，写入期崩溃留下的 `.<name>.<pid>.<uuid>.tmp` 永久残留。建议启动时对两处各扫一次。
7. **主进程同步跨进程锁**：`src/desktop/workdir-controller.ts:130` 的 `acquireCrossProcessLockWithTimeout`（`Atomics.wait`）在 IPC 路径上最坏阻塞主进程 5s，与同域 `tryBooksLockAsync` 的异步化纪律不对称。
8. **RAG 开库同步退避**：`src/rag/store.ts:256-276,368-404` WAL 切换 8 次线性退避 + 回填事务 `Atomics.wait`，最长阻塞事件循环约 1.8s，召回每次开库两回。

**B. 前端与交互**
9. **短篇正文 `piece-body` 判定链整条不可达**：后端 `roleOf` 对 `写作/正文/` 恒返 `'chapter'`（`src/document/layout.ts:22-26,113-117`），`stores/doc.ts:39` 自陈"`piece-body` 是历史 wire 兼容位，后端从不产出"。于是 `MetaFormPanel.vue:36,127-129` 的短篇字段组（钩子类型/钩子强弱/情绪定位/场景）永不渲染、`SidebarRight.vue:53` 与 `useChapterTreeActions.ts:198` 的"短篇"文案永不生效、`shared/chapter-tree.ts:159` 的排除式成为永真无效过滤。而服务端短篇节奏分析确实读这些 fm 键（`src/studio/server/api/rhythm.ts:188-242`）。**待确认**：短篇正文的钩子字段是否本就设计为"仅 AI 判定只读"（长篇正文即如此）——若有意，应删死分支并改文案；若应可手编，则是功能缺口。
10. **保存 404 分支缺书名守卫**（分域审计指出，未实测复现）：`stores/doc.ts:380-387` 成功分支有 `bookName.value === book` 门，NOT_FOUND 分支无门即 `docs.value.delete(docId)`；legacy docId 由路径派生、跨书可同 id，A 书迟到 404 可能删掉 B 书同路径条目（若 B 条目 dirty，正文随条目消失，仅一条 toast）。
11. **7 处异步动作逐行同构**：`views/WorkbenchView.vue:184-389` 的 `onSpawn/onInterrupt/onAutoWrite/onOutline/onLeadUpdates/onSaveDraft/onAcknowledgeCrashed` 结构完全一致（`pending.enter()` → `stillIn` → `failScoped` → `finally exit`）。新增动作漏包一层不会有任何编译/测试反馈，直接变成跨书错误提示。
12. **5 组高重合组件**：ShelfHeroCard ↔ ShelfModalHero（去重后行重合 72%）、ChapterMetaDialog ↔ SplitChapterDialog（63%，两文件都带"同款焦点圈/IME 守卫"补丁注释）、RagProviderList ↔ AiProviderList（58%）等。焦点圈/IME 这类跨端行为修复必须双改，历史已出现同类返工。
13. **`useRelationGraph` 暴露 54 个裸 Ref 字段**（`composables/useRelationGraph.ts:73-126,612`），模板侧手工 `.value` 解包 30+ 处；新增派生值需同时改接口 + 三处模板。
14. **无障碍缺口**：行内错误条普遍缺 `role="alert"/aria-live`（`WorkbenchView.vue:490`、`AuditView.vue:255`、`MetaFormPanel.vue:346`、`OnboardStepPanel.vue:91`、`CreateBookModal.vue:76`）；4 个纯图标按钮无可访问名（`AuditEventList.vue:148`、`ChatComposer.vue:120`、`LearnView.vue:84`、`ModelPicker.vue:62`，同族正例是 `SettingsModal.vue:180` 的 `data-tip`+`aria-label` 双写）。
15. **15 个文件 >500 行**：`views/OverviewView.vue` 830、`stores/doc.ts` 785、`editor/CmHost.vue` 673、`views/WorkbenchView.vue` 628、`stores/workspace.ts` 627、`composables/useRelationGraph.ts` 615 等；`stores/workspace.ts` 以 46 项出口同时承担布局态/持久化调度/新建信号/插入通道/docId 校验，是明确的"store 万能桶"。

**C. 简洁度与注释**
16. **超长函数聚集**：`src/studio/server/api/stream.ts:237`（517 行，`registerStreamRoutes` 内含两套编排）、`providers.ts:62`（457 行）、`analysis.ts:353`（382 行）、`documents-crud.ts:31`（300 行）；`src/ai/provider/anthropic-adapter.ts:236`（圈复杂度 52）、`src/rag/build.ts:286,541`（48/49）、`src/desktop/main.ts:293`（225 行）、`src/desktop/lifecycle.ts:414`（162 行）。全域 >120 行函数 30 个，19 个是 `register*Routes`。
17. **注释沿革噪音**：`src/ai/` 注释占比 32-43%，其中约 241 处"此前/原实现/曾把/勘误/作废"式叙事，已出现同一段落内两版结论并存（`src/ai/orchestrate/chat/failure.ts:98-106`）与指针悬空（`src/ai/prompts/writer.ts:4` 指向的 `section.ts` 机制不存在）。建议按"不变量 + 触发条件"重述一轮。
18. **声明的机制不存在**：`src/ai/prompts/section.ts` 整档零生产引用（只有测试），头注承诺的"按 order 分层裁剪"未实现；`src/ai/orchestrate/chat.ts:5` 头注写"≤5 轮 / ≤30min"而实现为 `MAX_AGENT_TURNS = 20`（`turns-phases.ts:75`）。属"注释先行"，改读方会被误导。

**D. 门禁与测试（详见第六节）**
19. `check-comments` 扫描面不含 `scripts/`（实测该目录有 603 处标签形态命中）且 `collectFiles` 在 `src` 不可读时静默返回 → 可 fail-open 为绿。
20. `check-docs` 属弱门：只拦超限与字面禁语，13KB 无信息堆砌可过；面清单硬编码 4 件，新增治理文档默认不入面。
21. `check-packaging` 非 darwin 或 dist 未建时 `problemsForDistFontList` 恒返 `[]`（`scripts/check-packaging.mjs:312-313`）→ 该判据在 CI 的 ubuntu/win 腿静默跳过。
22. 测试分档纪律名存实亡：**308 档（23.5%）声明用例数 ≤2**（96 档仅 1 例；本轮独立脚本复核），其中多数档的目标模块已有其他同域测试档，即本可并档；README/CLAUDE.md 的"不为单例新开档"与实测不符。（本轮脚本按 `it(/test(` 声明数近似统计，与 `check:counts` 的运行期口径不同源，仅作规模判断。）
23. 前端视图层官方登记 **0% 覆盖率门**（`vitest.config.ts:274`），默认 e2e（chromium + mock driver）**不跑 Electron**——3 个 `_electron` spec 全部 `skip(!CLWRITING_E2E_RELEASE)`，桌面 IPC/Electron 壳在默认流水线零覆盖。
24. win 腿"首跑红且零 FAIL 行则重跑一次"的兜底（`.github/actions/win-vitest-retry/action.yml:30-58`）仍是洗白面（判据 fail-closed 且留痕，故不列 P1）。
25. 348 条 eslint 抑制中最值得注意的是 `no-base-to-string` 83 条：`src/format/leads.ts:308-332`、`src/process/settings-context.ts:86-90`、`src/events/projection.ts:82-107` 直接把 YAML/事件解析值 `String(...)`——映射/数组型值会静默变 `[object Object]` 写回账本或进 AI 上下文；`src/studio/web-next/src/components/ui/SettingsModal.vue:92-102` 的 10 条 "error typed value" 是 web-next 无 `.vue` shim 导致的类型盲区症状。

---

## 五、P3 与清理项（择要）

- **死码/僵尸导出**：`src/install/init.ts:74 doInit`、`src/install/books.ts:107 appendBook`、`:210 removeBookEntry`（自引用闭环 + 仅测试引用，`package.json` 无 bin，CLI 已不存在，注释仍称"CLI 建书共用"）；`src/update/check.ts:167 getUpdateCheckState`（无端点/前端消费）；`src/format/chapter-lookup.ts:136`、`src/format/realms.ts:30,39`、`src/format/style-entry.ts:41`（`src/` 内零调用）；`src/process/settings-context.ts:49`、`src/rag/index.ts:316-327`、`src/rag/store.ts:452`（已注明为存量测试保留）。
- **生产不可达链**：`src/desktop/main.ts:816-827` 的 activate 重建 + `windows.ts:276-290` + `bootstrap-runner.ts:53,64`——`window-all-closed` 无条件 `app.quit()`，不存在"无窗但进程存活"态，两处设计互斥；`src/desktop/os-kek.ts:81,108` 的 safeStorage 通道被 `OS_KEK_SHELVED=true` 整面搁置，约 90 行与 server 侧 vault 迁移在生产永不可达，v2 vault 用户在本版本无恢复路径（属已披露决策，但建议在发布说明显式确认）。
- **微瑕**：`OverviewView.vue:165-169` 的 `new Date(created_at).getTime()` 无 NaN 守卫 → 非 ISO 值时"创作天数"KPI 静默不渲染；`ChapterTreeItem.vue:403-409` 与 `styles/utilities.css` 分居的 dot-* 状态样式；`shared/chapter-tree.ts:155`、`router.ts:7`、`shared/relation-layout.ts:16-24` 导出面大于消费面；`server-manager.ts:730-747` 崩溃封顶 quit 臂把"正在退出"误记为"永久不可用"；`migrate-layout-v3.ts:126-133` 对非 .md 子目录静默忽略 → 退役目录 `rmdirSync` 恒失败而静默常驻。
- **负面清单已核实为"活代码"、勿误删**：`FontPicker.vue:300`（`.ffb-select` 由 `FocusFormatBar.vue` 提供）、`pages/Book.vue:82-88`（`<Transition name>` 生成类名）、`Toast.vue:17`（`:class="t.kind"`）等。

---

## 六、工程门与测试体系评估

**门禁真实度分级**（本轮实跑/读脚本体得出）：

- **真门**：`check-knowledge`（manifest 逐条 sha256 ↔ 磁盘 + 反向扫描未登记资产 + `知识层/` 与 `resources/knowledge/` 逐字节相等，反例难构造）；`check-packaging`（`dependencies ⊆ tsup noExternal` 把 rc.0 的"打包态裸包解析崩"机器化，是最有价值的一道）；`check-counts`（声称值 ↔ 实测对账 + `.only`/零断言扫描 + e2e spec 顺序快照）；`check-comments`（逐字符状态机，字符串/模板/正则不误判）。
- **弱门**：`check-docs`（只拦超限与字面禁语，量不了信息密度；面清单硬编码；`pathToFileURL(process.argv[1])` 缺 argv 守卫，argv[1] 缺席即 TypeError 崩——其余四门都有该守卫）。
- **名义面**：`check-packaging` 的 fontlist 判据在 CI 的 ubuntu/win 腿恒跳过；`check-comments` 不扫 `scripts/`。

**CI 与出包**：`ci.yml` 5 腿（ubuntu/macos/windows × Node 24/26，win 不带 26）+ e2e 腿，无 `continue-on-error`，lint 含 `--prune-suppressions` 后 `git diff --exit-code`，打包态冒烟只在 tag 触发；`desktop.yml` 出包 mac/win 双平台、三重 tag 门 + **真 SHA256SUMS**、release job 前置"同 commit CI 全绿"轮询门。缺口：`mac` 分支不触发 CI（P1-1 的直接成因）；`workflow_dispatch` 出的包无 CI 背书；mac 仅 ad-hoc 签名（`identity: '-'`）、win 未签名，完整性只靠 sha256（README 已如实披露）。

**测试有效性**：后端域是真行为测试（主桶行覆盖自述 91.19%，零快照断言、零 `@skip` 存量、35/35 spec 接 pageerror 基线），soak 的门是真门（CI 对 `[soak] OK` 行数 fail-closed）。虚胖集中在前端视图层 0%、Electron 壳默认不跑、23% 碎片档三处。元测试（断言源码文本）仅占 2.9% 用例，不构成主要风险。

---

## 七、优化路线建议（建议分三批）

**第 1 批 · 阻塞项（先红后绿）**
1. 修 `books-delete-graveyard.test.ts` 缺建目录（P1-1），并在 mac 本机跑一次全量留证；把 `mac` 分支纳入 CI 触发或收口前强制 mac 全量。
2. fm 键名白名单收口（P1-2）。
3. 诊断包日志段与目录入口改走共享根 + `instances/*/logs`（P1-3）。
4. 半接线三件各自定案：接线 or 显式标注未启用（P1-4）。

**第 2 批 · 口径与数据面（1.0 前）**
5. token 系数校准回填 + 估算补 tools/包装增量；`tasks` 块补 `costAccum`（P1-5）。
6. 事件库保留策略 + VACUUM/`journal_size_limit`；诊断包脱敏名单补 check/metrics 族；共享根 tmp 启动清扫。
7. 导出加 AbortSignal；启动迁移链改异步 git。

**第 3 批 · 简洁度专项（可与 1.0 并行）**
8. 收束超长函数：`stream.ts` / `providers.ts` / `analysis.ts` 的 `register*Routes` 把编排体下沉为同目录模块（`stream-sse-writer`/`stream-watchdog`/`stream-ticket` 已是正面先例）；`anthropic-adapter.ts:236` 按 openai 线粒度再拆一档。
9. 前端三件套：抽 `withBookGuard` 高阶包装收 7 处同构 handler；抽 `useModalDialog` 收模态焦点圈/IME 守卫；拆 5 组高重合组件。
10. 注释重述一轮（删沿革叙事、补不变量），清 `section.ts` 悬空指针与 `chat.ts` 轮数口径；补 `role="alert"` 与图标按钮 `aria-label`。
11. 测试分档清理：306 档碎片档按域并档（收益是可测的执行时间与 import 成本）；前端视图层覆盖率门从 0% 提到一个可执行地板（如 40%），避免"官方登记 0%"成为长期免检区。
12. 门禁补强：`check-comments` 纳入 `scripts/`、四门统一 argv 守卫、`check-docs` 增"信息密度"或至少把面清单改为目录枚举。

---

## 八、方法、局限与验证记录

**本轮实证（可复现）**

```bash
npm test                                   # 1308 档：1 failed / 1307 passed（P1-1）
npx vitest run test/studio/server/books-delete-graveyard.test.ts   # 单档复现 1 failed
npm run check:counts                       # 通过（exit 0）
node -e "…"                                # eslint-suppressions.json 统计：348 条 / 143 档
npx tsx /tmp/clw-fm-probe.ts               # patchFlatFm 键注入实证（P1-2，探针已删）
grep -rn "piece-body" src/ · grep -rn "prompts/section" src/ · grep -rn "VACUUM" src/events/
gh run list --branch mac · git log --oneline origin/main..HEAD   # 12 提交未入 main、mac 无 CI
```

**本轮未覆盖（结论边界，勿过度外推）**

- 未跑 e2e / soak / Playwright / electron 打包态冒烟（本轮为源码与单测层评审）。
- 未重跑覆盖率（引用仓库自述数字已标注来源）。
- 未真机运行应用做 UI 交互验收；前端结论来自代码与模板静态分析。
- 分域审计结论中标注"待确认/未实测复现"的条目（P2-10 保存 404 跨书、P2-9 短篇字段是否设计使然）需实测定论再决定修法。
- 未审 `src/studio/web-next/node_modules`、`dist*`、`Dev/参考项目`（忽略名单内）。

# 全项目源码完成度与简洁度评审（独立重审）

- 定位：**源码独立重审报告**——`src/`、`test/` 与工程门禁的完成度、质量与简洁度审计结论（只产报告，不含任何修复）。不属于本档：修复过程与落点展开（另立执行档）；上一轮同主题评审的复述与沿革（正本 = 同目录《全项目源码完成度与简洁度-评审-DeepSeek-Flash-2026-10-12.md》，本轮不读其结论、按源码重新得出）。- **执行模型**：DeepSeek-Flash（new-provider/deepseek-flash）- **日期**：2026-10-15- **基线**：`win` 分支 HEAD `a2909009`（工作区 clean，本轮未修改任何仓库文件）- **范围**：`src/` 全量（645 档 / 142,120 行 = ts 112,711 + vue 29,409）、`test/`（1,280 档 / 238,688 行）、工程门禁与构建配置（vitest / eslint / tsup / electron-builder / CI / `scripts/` 16 档）- **方法**：主控实跑客观门（vitest 全量、`--coverage` 全量、tsc、eslint、五条自建 check）＋ 六路分域读码审计（数据核 / AI 与检索 / 流水线与外围 / Studio 服务端 / 前端组件 / 前端状态 / 桌面壳与工具链 / 测试质量，其中两路为返工重派）＋ **主控对全部 P0 级候选逐条回源复核**（本轮有 2 条子域 P0 结论经复核降档，见 §四「复核更正」）。- 方法边界：本轮为**审阅式审计**，不追穷尽。清单按「影响 × 确定性」取高置信项；未确证的怀疑一律标「疑似」并写明还缺什么证据。覆盖率数字取自本轮 `npm run test:coverage` 产出的 `coverage/coverage-summary.json`（2026-10-15 20:0x 生成，本机 win 实测），不引用历史快照。

---

## 一、总体结论

**出口：有条件通过。** 条件 = §四「P1（建议 1.0 前处理）」九条逐一收口或明确降级豁免；P2 项不阻断 1.0，但应在首发后按批消化。

**完成质量：高水位，且明显高于 1.0-rc 阶段的常见水平。** 客观门全绿（tsc / eslint / 五条自建 check / 覆盖率门），全域零 `TODO`/`FIXME`/`HACK`、零 `@ts-ignore`、零 `: any` / `as any`、零 `eslint-disable`（仅 1 处），核心链路覆盖率厚（`ai/runner.ts` 99.2%、`process/draft-pipeline.ts` 99.0%、`events/store.ts` 96.8%、`ai/calls.ts` 95.3%、`studio/server/api/task-gate.ts` 95.4%）。数据安全面（原子写 + fsync、跨进程锁三序、journal 三态、快照 fail-closed、导出 sha256 锚定 + zip-slip 全拒）经复核无确证缺陷。

**完成进度：功能闭环完成，处于首发前收口期。** 建书 → 大纲/设定 → 起草 → 机检 → 三审 → 定稿 → 导出全链可用；1.0 前加固项、便携版自更新全批均已落地。**当前唯一硬缺口是测试面 1 例红**（`test/events/store.test.ts` 的 EPERM，属活账已登记的「win 腿间歇红」家族，本轮 win 实测复现），另有覆盖率四桶贴线、冷库精简批移交挂账两项在账。

**简洁优雅度：中上偏优，但有两类系统性负担在持续累积。** 正面是真实的——单源收敛已成习惯（`defineRoute` 声明式路由 116 条零裸注册、`RENDER_CAP`、`checker-generation`、`async.ts` 让出原语、`adapter-errors` 共享原语、`codePointLength`）。负担有二：其一，**规模失控的单点**（74 个函数 >120 行，最长 516 行；`export/index.ts` 913 行无任何子档拆分，而 `check/` 同域已拆 24 档）；其二，**注释承载了本该归 git 的修复史**（`此前` 867 处、`原为` 21 处，抽样确认多为「此前 X 会 Y，现 Z」式变革叙述），与 AGENTS.md 自定的注释纪律（「不写来历与出处，修复史归 git」）正面冲突，且 `vitest.config.ts` 单档 65% 是注释、`eslint.config.js` 41%——配置与门禁的可维护性已成新的复杂度来源。

---

## 二、客观门实测数据（本轮实跑，可复现）

| 门 | 结果 | 说明 |
|---|---|---|
| `npx vitest run`（全量） | **1280 档：1273 过 / 6 跳过 / 1 红**；9705 用例：9628 过 / 76 跳过 / 1 红；470s | 唯一红档 = `test/events/store.test.ts:40` `removeDirWhenFree` 抛 `EPERM`（win 临时目录清理竞态） |
| `npx tsc --noEmit` | **零错** | strict 全量 |
| `npx eslint . --max-warnings 0` | **零错** | 仅 10 条报错，全部落在评审过程中由 ZCode 会话生成的 `.zcode/workflow-runs/*.mjs`（非仓库源码、非入库面），移除后即零 |
| `npm run test:coverage` | **门全过（exit 0）** | 实测总门：lines **92.2%** / branches **81.4%** / functions **89.05%** / statements 89.58% |
| `check:counts` | 通过 | README 声称 9209 单测与实测一致；批号标签上锚与实测相符 |
| `check:docs` / `check:comments` / `check:knowledge` / `check:packaging` | 全部通过 | 扫描 666 档零批号标签；知识层 68 条 manifest 对账一致 |

**覆盖率分布（本轮实测，按域 lines% 升序）**

| 域 | lines% | branch% | fn% | 行数 |
|---|---|---|---|---|
| studio（含前端 web-next） | **88.0** | 74.1 | 81.9 | 15,058 |
| desktop | 91.8 | 83.7 | 90.1 | 2,369 |
| knowledge / install | 92.9 / 93.0 | 86.1 / 86.6 | 98.9 / 100 | 480 / 761 |
| process | 93.6 | 83.8 | 97.7 | 1,464 |
| document | 94.1 | 83.9 | 97.4 | 2,763 |
| state / check | 95.3 / 95.9 | 86.4 / 89.0 | 98.0 / 98.9 | 400 / 1,289 |
| ai | **96.1** | 88.8 | 95.8 | 3,651 |
| events / fs | 96.7 / 97.0 | 91.5 / 91.1 | 98.7 / 99.0 | 1,224 / 530 |
| format | 97.7 | 92.5 | 98.6 | 2,205 |
| driver / log / metrics | 99.2 / 99.3 / 98.9 | 94.4 / 93.7 / 83.0 | 100 / 92.3 / 97.3 | 240 / 134 / 361 |

结论：**覆盖面呈「后端厚、前端薄」的典型分布**。后端核心域普遍 94-99%，`studio` 域被前端拉低到 88%。低覆盖集中在组件层与编辑器：`AiProviderEditor.vue` 41.3%、`ShelfModal.vue` 47.7%、`AiServicePanel.vue` 53.1%、`shared/words.ts` 56.2%、`useRelationInteraction.ts` 61.0%、`pages/Shelf.vue` 61.5%、`CmHost.vue` 68.8%（CodeMirror 宿主，打字机/IME 主回路）。注意 `{pages,views}/**` 池化桶 78/59 与 `{pages,views}` 0/0 显影桶的分工是**有意设计**（e2e 自管边界，注释与 governance 门双向核对），不是疏漏——但代价是视图层质量只由 e2e 承担。

---

## 三、完成进度评估

**已闭环（可信）**：文档/格式核（front matter、YAML、结构合并、版本快照、回收站、伏笔、清单）、事件库与投影、机检链（8 类规则 + 代次缓存）、AI 三协议适配 + runTask 编排 + 预算记账 + 密钥保险库、RAG 索引、三审、导出（md/txt/投稿视图）、诊断包（路径占位符脱敏）、便携版自更新（含检查链代理）、多库多窗、静默更新检查。

**在账未了结（与 `00-活账.md` 一致）**：① win 腿间歇红（本轮实测复现 1 例，具体败例未定位到用例级——**建议把「EPERM 家族收口」从观察位升级为待办项**，理由见 §四 P2-6）；② 覆盖率四桶（`learn`/`document`/`studio/server`/`events`）贴线，改动即需本地自查；③ 冷库精简批移交挂账（打包态 `verify:responses` 实连一次）。

**首发判据差距**：无功能缺口；剩余全部为质量收口。**除 §四 P1 清单外，本轮未发现新的功能级未完成面**——六路审计一致确认「未接线功能、恒 fallback 分支、空实现」属个别现象而非系统状态（详见 §四 复核更正与 P2-「只写不读面」）。

---

## 四、发现清单

分档口径：**P0** = 数据丢失/安全/费用级正确性缺陷；**P1** = 明显质量缺陷或高影响可维护性缺口，建议 1.0 前处理；**P2** = 一致性/收敛债；**P3** = 抽样记录的吹毛求疵。

### 复核更正（本轮主控回源判定，与子域初判不同）

1. **「孤儿子进程必然导致下次启动 EADDRINUSE」不成立**——首次启动端口传 `'0'` 由 OS 分配（`src/desktop/server-manager.ts:955`），钉住端口只发生在重启轮（`:792`）。孤儿子进程的真实代价是：持有书库事件库 SQLite 连接与跨进程锁、占用一个随机端口，**不必然**引发端口冲突。该问题本身成立（见 P1-1），但严重度按实降档。
2. **`analysis-worker.ts`「零覆盖」不成立**——`test/studio/api/worker-async-shell.test.ts:244` 有直测，本轮实测该档 100%（12/12 行）。子域报告引用的 `tmp/cov/coverage-summary.json` 是 2026-09-20 的旧快照，本轮以新产出的 `coverage/coverage-summary.json` 为准。
3. **两项疑点经查不成立，不列入清单**：`eslint-suppressions.json` 无过期项（140 档逐条比对文件均存在，CI `lint:prune` diff 空门在跑）；CI 无 `continue-on-error` 或注释掉的步骤。

### P1（建议 1.0 前处理）

- **P1-1 主进程被硬杀后 studio 子进程成孤儿，无 parent 探活收口**：`src/desktop/main.ts:853-881` 的退出链只覆盖 JS 级路径（SIGINT/SIGBREAK/SIGTERM/uncaughtException）。`src/desktop/server-utility.ts:64` 的子进程只处理 `shutdown` 消息，全仓 grep `ppid` / `parentPort.on('close')` 零命中——任务管理器结束进程、原生崩溃、OOM kill 三种硬杀后，子进程续持事件库连接、跨进程锁与端口。代码自身在 `main.ts:860-863` 登记过该风险，但只对 JS 路径补了防线。收口成本低：子进程周期查 `process.ppid` 存活或等 parent 通道关闭即自杀。

- **P1-2 更新换名双向失败后无自动出路，且 `.old-` 备份会被启动维护清除**：`src/desktop/update-helper.ts:291-315`：`target→.old` 成功、新目录就位失败且回滚也失败时，只剩留痕——此刻 `<target>/CLWriting.exe` 已不存在，唯一还原函数 `recoverInterruptedSwap`（`:125`）只在助手进程启动时被调用（`:369`），而启动维护 `runUpdateMaintenance`（`src/desktop/update-controller.ts:385-395`）遍历父目录时**无条件删除** `-new-*` 与 `.old-*`（不检查 target 是否在位）。链路后果：用户重装到同目录并启动 → 启动维护先删掉 `.old-` → 回滚能力永久消失。损失面 = 应用目录回滚能力（书稿在书库目录，不受影响），故非 P0；但用户在失败现场没有任何自动出路或指引，属升级路径的无出口态。

- **P1-3 打包态可被宿主残留 `CLWRITING_DRIVER=mock` 整体切成假回复**：`src/driver/index.ts:22` 读该环境变量**无 `app.isPackaged` 门**；子进程 env 由宿主 `process.env` 全量展开（`src/desktop/server-manager.ts:611`），剥离名单七键（`:622-635`）不含它。同仓对 `CLW_DEV_UI`（`main.ts:124`）、`CLWRITING_INITIAL_BOOK`（`main.ts:462`）都加了打包态门，本条是口径漏网。触发条件：用户 shell 环境残留一次 `CLWRITING_DRIVER=mock`（e2e/调试留下的），此后打包版全链路假回复且难以自诊。

- **P1-4 HTTP 错误文案回传本机绝对路径，与诊断包脱敏口径不一致**：`src/format/yaml.ts:295` 把 fs 错误 message 原样装进 `ParseError`（Node 的 ENOENT message 含 `open '<绝对路径>'`），经 `src/studio/server/api/books.ts:214`、`api/config.ts:66` 直插 500 文案（同族还有 `api/session-store-guard.ts:27`、`api/outline.ts:136`、`api/providers-ops.ts:607/674`、`api/style.ts:351`）。统一脱敏 `src/log/redact.ts:29-39` 只覆盖凭据形态、不含路径；而诊断包已有专门的路径占位符链路（`src/diagnostics/index.ts:279`「路径已替换为占位符」）。两条口径并存：入包要脱敏、上屏不脱敏。持 token 者可逐点枚举盘上目录结构。

- **P1-5 claude + effort 档无条件禁用 thinking，依据自陈未验证**：`src/ai/provider/anthropic-adapter.ts:193-194` 对 claude 家族硬置 `thinking:{type:'disabled'}`，理由注释（`:183-192`）自陈「真机验证登记：400 实际频率待验证」。若该假设在部分上游/型号上不成立，claude 用户在 effort 档下纯损失思考能力，且无从察觉。建议真机取证后按型号/上游收窄，而非整族关闭。

- **P1-6 三适配器降级/收尾编排三份复制，语义靠三处各自维护**：`src/ai/provider/openai-adapter.ts:563-613` 与 `responses-adapter.ts:283-332` 结构逐段同构（`consumedAny` 判定、`isMidChain400`、`errorUsageOf` 上抛、`markStructuredDegrade`），`anthropic-adapter.ts:478-551` 为第三变体。共享原语已抽进 `adapter-errors.ts`，但约 50 行的编排层未抽——改一次降级语义须同步三处（`consumedAny` 的注释三处各自维护即是事实证据）。

- **P1-7 「模型可见 ⟺ 已记录」登记面纯人工，无机制兜底**：登记点形态各异：`src/ai/tools/rewrite.ts:189-190`（手工登记 bodyRel）、`src/ai/orchestrate/self-heal.ts:458-474`（材料+摘要拼接）、`src/ai/orchestrate/chat/restore.ts:209-212`（promptFiles/revisionPath）。唯一校验是 chat 线 opt-in 采样（`src/ai/orchestrate/chat/turns-visibility.ts:31` 需 `CLW_VERIFY_VISIBLE=1`），且 self-heal / rewrite 两条链不在抽样面内。新增注入点漏登记即静默破律，而这条铁律是本项目对 AI 链路的自定正确性判据。

- **P1-8 机检代次哈希覆盖缺口 → 改规则不失效缓存**：`src/check/checker-generation.ts:11-17` 自认「不覆盖未导出模块级量与函数闭包捕获量」，而 `src/check/count-style.ts:306` `DE_RUN_SPLIT_RE`、`:404` `POSSESSIVE_UNIT_RE` 恰是未导出实例；`src/check/tree-issues-cache.ts:34` 以 `CHECKER_GENERATION` 做整代表失效。后果：改这两条正则不换代次，旧缓存继续供旧判定——红黄项静默陈旧，属判定正确性问题（轻量但真实）。

- **P1-9 前端类型镜像漂移，服务端枚举演进无编译期约束**：`src/studio/web-next/src/types/tree.ts:3-13` 手写镜像 `src/document/tree.ts:28-46`：`role: string` / `status?: string` 无联合约束、缺 `order` 字段，消费侧裸字符串比较（`composables/useTreeMenu.ts:115,121` `node.status === 'draft'`）。同型镜像在 `api/{check,style,learn,rewrite,review,overview,foreshadows}.ts` 共 7 档（各档头注自认「镜像…不跨包 import」），只有 `api/documents.ts:1` 做了 re-export 单源。服务端改枚举 → 前端编译不红、运行期静默走偏。

### P2（首发后可消化，按批推进）

- **P2-1 巨型档与超大函数单点失控**：74 个函数超过 120 行（脚本启发式统计，取样复核无假阳）：最长 `useChapterTreeActions.ts:77` 516 行、`useRelationGraph.ts:177` 486 行、`desktop/ipc.ts:253` 321 行、`useSse.ts:131` 308 行。文件级：`export/index.ts` 913 行同档承载净化/文件名/markdown 剥离/投稿视图六阶段，而 `check/` 同域已拆 24 档——拆分范式仓内已有先例，此处未对齐。

- **P2-2 口径复制族（同一规则的 N 份手工同步）**：① 接线锁键三份：`document/doc-context.ts`、`document/lead-finalize.ts`、`studio/server/api/files.ts:346`（该处注释自陈「三侧仍逐位一致」并有「无痕丢更新」事故史）；② fm 解析双链：`document/tree.ts:357/377` 绕开 `format/frontmatter` 的 `parseFlat` 自持正则；③ `chapterNoFromEntryPath` 同体二份（`structure-merge.ts:404-407` / `outline-orphan.ts:35-38`）；④ docId 双名候选多处拼装（`analysis.ts:42-48`、`trash.ts:578`）。

- **P2-3 默认值与缓存指纹多源**：章/卷摘要上限 200/500 同时存在于 `format/yaml.ts:68-69`、`format/yaml-spec.ts:399`、`process/summary.ts:56-58`；`maxAttempts` 默认 3 在 `process/retry.ts:30` 与 `ai/orchestrate/self-heal.ts:200`（且生产唯一调用点恒显式传参，该默认值已是死值）。缓存指纹口径：`process/settings-context.ts:34-37,76` 用 mtimeMs+size（自认「撞车窗口…接受」），全仓其余缓存统一 mtimeNs（`check/run-tree-issues.ts:535-537`）。

- **P2-4 两处零留痕吞错**：`src/document/service.ts:557-561`（`appendWordsDelta` 空 catch）与 `:1166`（`dropManifestEntryAfterTrash` 空 catch）：同文件 journal settled 失败有 `log.warn` 先例（`:550-553`），这两处字数日记丢失 / 清单残留发生后无从观测。

- **P2-5 模块级可变状态未随实例化收口**：`sseConnections`（`api/stream-sse-writer.ts:38`）、`ragBuildTasks`（`api/rag.ts:45`）、`services`（`api/documents-core.ts:47`）、`spaIndexCache`（`static.ts:43`）均为模块级 Map/单例，而 `index.ts:822` 自述闸与票库已「按实例取用」。删书/改名路径的 `forgetSseCount` / `forgetRagBuildTask` / `forgetService` 是不带实例判定的全局清。实际影响面限于**同进程多实例**（测试与 e2e 起独立 server 的场景）——桌面与 `dev-api` 是两个进程，不共享模块态。最硬的一条：`getOrCreateService`（`documents-core.ts:53-60`）清表后重建，同 bookRoot 会出现两条 DocumentService 串行队列，「跨请求共享串行队列」的写安全前提失效。

- **P2-6 测试面：EPERM 家族三套实现并存，唯一红档无收口**：`test/events/store.test.ts:30-42` 自制 `removeDirWhenFree`（10s 预算，本轮实测仍红）、共享助手 `test/helpers/temp-dir.ts:41-47` 的 afterEach 是吞异常 best-effort（失败仅泄漏、不报警）、e2e 另有 `test/e2e/tmp-cleanup.ts:43`。建议合并为单一 rm-retry 工具（失败有限重试 + 超限留痕），同时把「隐性临时目录泄漏不报警」这条也收掉。

- **P2-7 测试面：零断言豁免与弱断言形态**：`test/git/kill-escalation.test.ts:47-54` 零断言（豁免理由「不炸即断言面」），且注释宣称的「升级定时器未再触 kill」未被验证（未查 signals）；全仓 `not.toThrow` 形态 97 处，其中 `test/fs/atomic-rm-quietly.test.ts:16-34` 注入抛错后仅断言不抛，断不出「吞掉后返回/状态」面。另有 `test/e2e/edit-save.spec.ts:29-52` 靠 afterAll 手工恢复派生态（失败仅打 `[e2e-restore]` 不阻断），下游 spec 可被前序污染而因果不可见。

- **P2-8 注释承载修复史，与自定纪律冲突**：`此前` 867 处、`原为` 21 处、`曾` 50 处（`src/` 全量 grep）。抽样确认多为变革叙述（如 `src/ai/gen.ts:21`「此前失败恒记 0，成本口径低估」、`:273`「此前截断即丢账」、`src/ai/calls.ts:152`「此前静默归 0」），而 AGENTS.md 明令「注释只写代码作用与需要说明的东西；不写来历与出处，修复史归 git」。**判据边界**：部分「此前」是在解释当前实现为何必须如此（负向约束），属合规；但比例与密度已使注释承担 changelog 职能，直接影响通读成本——`vitest.config.ts` 65% 注释 / 27 个阈值桶、`eslint.config.js` 41% 注释即是极端形态。

- **P2-9 抑制表与门表的结构性豁免**：`eslint-suppressions.json` 191 条抑制均为纯计数键（`{count:N}`，**无到期/复审字段**），其中 `complexity` 50 条（阈值 25）、`max-depth` 13 条（阈值 5）、`max-lines-per-function` 6 条（阈值 200）命中含 `desktop/main.ts`、`process/draft-pipeline.ts`、`rag/build.ts` 等核心链路——`lint:prune` 只删「不再命中」条目，是单向收缩，这 50 个函数上复杂度门等同不存在。另 `scripts/harness/run-gates.ts:5` 自称「MODES 是仓库声明检查的唯一点」，实际只执行 `text`/`agent-notes` 两模（`package.json:37-38`），其余模式为死声明。

- **P2-10 只写不读面（补线或删除，不留中间态）**：`ManifestEntry.status`（`document/manifest.ts:33` 定义、`:229` 解析，全仓零消费；真状态走 `deriveStatus`）、`caps.streaming`（`ai/provider/probe.ts:104` 唯一写点）、quirks 表 `verbosity` / `maxTokensIncludesReasoning`（`model-quirks.ts:110-113`，唯一消费是注释「留位不发」）、前端 `stores/style.ts:35` `loaded`、`stores/chat.ts:93` `historyTotal`、`ui/AiProviderList.vue:20` `testResults` prop（父层仍在传 `AiServicePanel.vue:383`）。同族：`ai/prompts/section.ts` 零 import（仅测试引用）、`ai/calls.ts:542` `recordAiCall` 无生产调用。

- **P2-11 长命/流式列表缺渲染上限（既有纪律的漏网面）**：全仓 `RENDER_CAP` 纪律已覆盖 13 处，但 `panels/chat/ChatMessages.vue:259`（对 `chat.messages` 全量 `v-for`，store 只 append 不裁剪）、`relations/RelationGraph.vue:133`（`visibleNodes` 无数量帽，每节点 `<g>`+每边 `<path>`）、`panels/HistoryPanel.vue`（快照列表）三处无帽。ChatDock 常驻 → 整个会话期 DOM 单调增长。

- **P2-12 模态与层内交互的机制双轨**：`composables/useModalDialog.ts` 仅 2 件采用，其余 7 件各写一份 `document.addEventListener('keydown', …, true)` + Esc 让渡 + 焦点圈（`ui/ConfirmPrompt.vue:26-27`、`ConfirmDeleteModal.vue:44-45`、`ModelPicker.vue:42-43`、`ExportDialog.vue:94-95`、`SettingsModal.vue:163-164`、`ShelfModal.vue:159-161`、`CreateBookModal.vue:26`），且只有 3 件检查 `e.defaultPrevented`。同一契约 7 份实现。

### P3（抽样记录，不逐条展开）

`fs/atomic.ts:70-71` 退避用 `Atomics.wait` 同步睡（重试最坏 350ms 整停事件循环，落保存 API 时会冻结 SSE 心跳，注释已自认）；`export/index.ts:76-79,426` 无清单即跳过定稿过滤（`skipped-no-manifest` 时全本含未定稿章，仅前端明示）；`api/io.ts:52` `acquireExportSlot` 以生产导出面承载测试钩子；`update/extract.ts:38-44` 未拒 Windows 保留名与 ADS 形态（包受 sha256 锚定，风险极低，疑似）；`return-await` / `prefer-promise-reject-errors` 类抑制合计 15 条；`studio/server/api/analysis-ops.ts:160` 只读面比消费面宽（4 个 kind 无 GET 消费者）；`error code` 词表漂移（`TOO_MANY_ITEMS` / `NO_SAMPLES` 未登记进 `http.ts:73-76` 词表）；`scripts/` 八档各写一遍仓根推导（`test-related.mjs:34` 独用 `process.cwd()`，仓外调用静默跑空）；`tsup.config.ts:82-84` 为单一依赖（font-list）给全部产物注入 `__dirname` 垫片。

---

## 五、简洁与优雅度评估

**做得好、建议保持的**：声明式路由（116 条零裸注册）；单源收敛文化（`async.ts` 让出原语、`codePointLength`、`RENDER_CAP`、`STOP_REASONS`、`killProcAwaitEscalating`、`adapter-errors` 共享原语）；结构化规则代次（`checker-generation` 把规则数据导出面哈希成代次，机制本身是好设计——缺口只在覆盖面）；测试辅助单源（`tempDirTracked` 463 档使用、`wait-for.ts` 收编 28 份 sleep、`__XForTest` 钩子 55 处单源）；分层边界清晰（`check/` 24 档、`events/` 三档拆分、`ai/orchestrate/` 已拆子档）。

**四类结构性负担**：

1. **单点规模**：除 P2-1 的函数/文件级问题外，`vitest.config.ts`（26KB / 27 桶 / 65% 注释）与 `eslint.config.js`（13.8KB）把大量数值决策（每桶阈值、命中原因、回收条件）压在注释里维护，且须与 `test/governance/coverage-threshold-globs.test.ts` 的 `EXPECTED_THRESHOLDS` 同批对齐——改一处阈值要同步两处人工面。建议：桶表抽成 JSON 数据文件（单一数据源 + 生成两侧）。2. **同一个口径的多份实现**（P2-2 / P2-3）：靠注释与回归测试锁定同步，属"能跑但脆"的形态；收敛成本小、消除的是静默失效。3. **注释的定位漂移**（P2-8）：注释从"说明约束"漂移到"记录变革"，与纪律文本冲突，且实际抬高了审阅门槛（通读一个 400 行函数要先读 260 行沿革）。建议：新注释只写不变量，存量随触碰归并。4. **豁免机制缺出口**（P2-9）：抑制表与 `max-depth` 类豁免无到期/复审字段，一旦计入就永久豁免。建议：给抑制表加"只减不增"上限门（每文件复杂度抑制数不得超现值），把单向收缩变成可审计的账。

**跨域对照结论**：后端域（`ai` / `document` / `events` / `check`）的抽象质量明显高于前端组件域。前端的核心逻辑层（`stores` / `composables`）质量不错（stale-guard、书名守卫、在途锁成体系），问题集中在 **SFC 组件层**（重复模式、超大档、机制双轨、覆盖薄）——这也正是覆盖率最低的同一片区域，两条证据互相印证。

---

## 六、建议的修复顺序（本轮不实施，供下一批拍板）

**批 A：小成本高收益，建议 1.0 前**——P1-3（driver env 加打包态门，约 3 行）、P1-4（错误出口路径脱敏或改白名单文案，约 1 个函数）、P1-1（子进程 parent 探活 + 退出链 `flushLogs()`）、P2-4（两处吞错补 `log.warn`，约 6 行）、P1-8（未导出判定常量导出或列入 `RULE_MODULES`，消除"改规则不失效缓存"）。

**批 B：正确性收口**——P1-2（更新失败态补自动出路或把助手副本路径写进结果条）、P2-6（EPERM 家族合并为单一 rm-retry 并让失败留痕，直接消掉唯一红档）、P1-7（给铁律登记面加 dev/CI 交叉核对兜底）、P1-5（claude thinking 真机取证后收窄）、P1-6（三适配器编排层收敛为一份共享实现）。

**批 C：结构调整（首发后）**——P2-1（拆 `export/index.ts` 与 self-heal 出口族，对齐 `check/` 拆分范式）、P2-9（抑制表数据化 + 只减不增门）、P1-9（前端类型镜像并入 `src/shared/contract` + 编译期 conformance 断言）、P2-11（三条长命列表补 `RENDER_CAP`）、P2-12（模态归一到 `useModalDialog`）、P2-10（只写不读面逐项二选一）、覆盖率补强（`CmHost.vue` / `useRelationGraph` / 组件层低覆盖档立窄桶或补直测）。

---

## 附：本轮不成立或证据不足的怀疑（避免下轮重复排查）

- 「同进程双实例互相污染」在**桌面真实运行形态下不成立**（桌面与 dev-api 是两个进程，模块态不共享）；仅在测试/e2e 同进程起多实例时成立 —— 已按实降为 P2-5。- 「孤儿进程必然 EADDRINUSE」不成立（首次启动端口为 OS 分配）—— 已按实降档。- `eslint-suppressions.json` 无过期项、CI 无被禁用的门 —— 经查不成立。- 「views/pages 覆盖门形同虚设」表述不准确 —— 0/0 显影桶是有意登记加 governance 门双向核对的设计，真实问题是视图层质量仅由 e2e 承担（无单测回流）。- 未发现确证的数据丢失路径（原子写 / journal / 快照 / 导出四条链均有实证防线）。

# RC 全项目重审评审报告

- 执行模型：GLM-5.3（6 路子代理分区只读审查 + 主控机器门实证与锚点复核）
- 基线：`2d43f3df`（main/win，工作树净）；tag `v1.0.0-rc.0` = `530d3625`（落后 main 4 提交）；远端 Release 已于 2026-09-20 由 github-actions 发布 Latest（6 资产）。
- 范围：src 全域 25 目录、test 全树、构建/打包/CI/发布链、治理文档链（CLAUDE.md → Docs/README → 总览 → Archive）、知识层、根 README 对外声称面。
- 门实录（本地实测，2026-09-20）：check:counts ✅（1272 文件/7880 单测、33 spec/54 用例，与 README 声称一致）｜check:docs ✅｜check:packaging ✅｜check:knowledge ✅｜typecheck ✅｜eslint --max-warnings 0 ✅｜vitest 全量 ✅ exit 0（运行态 7727 passed + 76 skipped 环境条件跳过（AST 门白名单内），收集 7803；7880 为 check:counts 静态枚举口径，差值即条件跳过族）。

## 一、总评与 RC 判定

**产品代码面 RC 就绪度高，唯一 P1 在发布面不在代码面。** 数据层三层锁序/原子写/崩溃恢复实装扎实，AI 链路两条铁律（模型可见⟺已记录、默认值显式 resolve）逐链核实无违约，Electron 安全面（contextIsolation/sandbox/IPC 白名单/CSP）配置正确，README 对外承诺的八条功能面全部找到实装锚。七轮历史评审沉淀的注记密度与机器门体系（计数/文档/打包/知识四 check + coverage 阈值 + 竞态守卫）真实在位、非纸面门。**阻塞项：已发布 Latest 的 rc.0 产物不含阶段 50 打包致命修复，用户按 README 指引下载到的是启动即挂的坏包**——代码已修好但从未进发布物，属发布流程收尾缺口而非代码缺口。

## 二、P1（1 条）

### P1-1 发布产物陈旧：Latest Release 为启动即挂形态

- 证据链（三锚互证）：① `git rev-parse v1.0.0-rc.0` = `530d3625`，阶段 50 修复 `0b5f97ef`（tsup noExternal 强制内联裸包三依赖，修「server 子进程 ERR_MODULE_NOT_FOUND 秒崩 → 服务异常框 → 无窗无服半死态」）在其后入库；② `0b5f97ef` commit 自述「tag v1.0.0-rc.0 产物在用户机（/Applications / dmg 挂载位）启动即挂」，且 tag 时点的 CI 冒烟绿系工作区内裸包向上解析摸到仓库 node_modules 的假绿；③ 远端 Releases 页实见 rc.0 已发布 Latest、6 资产齐全（arm64.dmg/x64.dmg/x64.zip/SHA256SUMS.txt 等），产物构建源为 tag 时点 CI（`9addab40` 记「草稿由作者侧以同轮 CI 产物等字节补齐」）。
- 影响：任何按根 README「下载与安装」指引获取 rc.0 的用户，三平台均为启动即挂形态；SHA256SUMS 校验的是坏包的完整性，不缓解。
- 处置建议（作者拍板）：下架现 Release 或转预发布 + 移 tag 至 `2d43f3df`（package.json 版本仍 rc.0，tag↔version 门自洽；desktop.yml 于该提交已含 `gh -R` 定位修）重跑发布链替换产物，或直接 bump rc.1 走新 tag。二者均需在总览 §三 落账 tag 去向（联动 P2-7）。

## 三、P2（7 条）

1. **钥匙串搁置与发布态错位，存量 v2 vault 锁死且文案死胡同**（AI 面）——`src/desktop/os-kek.ts:82`（`OS_KEK_SHELVED = true` 仅在 main；实测 tag 版 os-kek.ts 无此旗，即 rc.0 发布的是 OS 通道开启态，但 rc.0 启动即挂、key 入口不可达，终用户 v2 存量≈0）＋ `os-kek.ts:105-111` / `src/ai/provider/vault.ts:154-158` / `store.ts:349-352`：搁置守卫先于一切 → v2 vault 抛 `VaultOsKeyMissingError('……请从桌面应用启动')`，而桌面应用同样被搁置，文案成死胡同。存量 v2 面仅限 0918–0920 间跑过 main 开发构建的机器（KEK v2 于 0918 上线且 osKey 可用时自动重封、无 v2→v1 回迁）。修：搁置期文案改真实出路；恢复通道前盘点存量 v2 库归零。
2. **PR 级门禁对裸包外置回潮零拦截**（CI 面）——`.github/workflows/ci.yml:245-246,299-300` 对照 `tsup.config.ts:58`：release-smoke 在工作区内以 node 直跑，ESM 裸包解析沿路径向上摸到仓库 node_modules；asar 清单断言只查 node_modules 不混入，查不出「产物 js 残留裸 import」。未来新增第 4 个 dependency 漏加 noExternal 时分支 CI 照绿，直到 tag 发布冒烟才红。修：加静态门断言 package.json `dependencies` ⊆ tsup noExternal 清单（可挂 check:packaging）。
3. **竞态家族 known-red 台账脱节**（测试治理面）——commit `530d3625` 自述「tree-perf/cross-process-lock-renew/r0911-commit-yield，R0911/R0912 台账在册」，但 rg 全库（test/、Dev/Docs 含 Archive、代码注释）零实体台账；三件测试实体在（`test/document/tree-perf.test.ts`、`test/fs/cross-process-lock-renew.test.ts`、`test/learn/r0911-commit-yield.test.ts`），处置状态只能考古 commit 消息。修：Dev/Docs 落 flaky 台账实体（文件/根因/处置态/重跑定夺机制）。
4. **win 腿整跑重试可洗白间歇真失败**（测试/CI 面）——`.github/actions/win-vitest-retry/action.yml:36-44` 自认「重跑洗白一跑——当前 win 腿零用例红」前提已被 `530d3625` 实录打破（win 腿红三件计时敏感测试）；`tree-perf.test.ts:79` 首断言仍为绝对墙钟帽（1000ms/250 章），同文件已有 9 次中位相对断言先例可循。修：绝对帽相对化或加 CI 慢机系数，复核重跑洗白窗。
5. **views/pages 无域级覆盖子桶**（测试面）——`vitest.config.ts:212` 聚合桶 L80/B66 吞掉视图层：webnext 72 个测试文件 mock `views/` 路径，真实视图脚本仅 e2e 驱动而 e2e 不回流 v8 覆盖；仓内自己的拆桶论证（stores/composables 先例「域内腰斩对门不可见」）未覆盖 views（0% 份额出自本地 partial coverage，全量份额待核）。修：views 子桶或按「e2e 自管」点名排除。
6. **总览复原锚节号错位**（治理面）——`Dev/Docs/00-总览与实施路线-2026-08-15.md:36-37`「明细 = `git show 93e5df74:…` §四」，实测锚版标题序列无 §四、决策状态表在锚内为 §五。违反「内容移位后全链引用随批改指」。修：改指 §五或去节号。
7. **总览 §三 状态行滞后发布实况**（治理面，与 P1-1 联动）——总览:28 仍写「已入库待首跑绿／首跑验证随 push 后 dispatch 自考」，实际发布链已跑、Release 已发布且含 P1-1 问题；`9addab40` 的「tag 不移指」决定之后无批记衔接。修：随 P1-1 处置一并改状态行并记 tag 去向。

## 四、P3（23 条，按域）

| 域 | 发现 | 锚 |
|---|---|---|
| 数据层 | B004 strict 抛点「WRITE_ERROR 信封」注释宣称与实际 500 兜底路由不符 | `src/document/structure-core.ts:252` |
| 数据层 | 拆分「新章创建失败」文案指「可重试拆分」，实际重试必 PLAN_STALE/BAD_INPUT，唯一出路是版本面板 | `src/document/structure-split.ts:253` |
| 数据层 | 无事件库配置（仅 CLI/测试形态）下 undo 续跑承诺不可达且报文误导 | `src/document/structure-merge.ts:561`（待核形态） |
| 数据层 | 「仅测试消费」死代码两件待清理批定夺 | `src/events/store.ts:105`、`src/cache/sync.ts:76` |
| AI 链路 | 知识层注入读书根 manifest，仓库自带 `知识层/`（13 条）运行时不可达（唯一消费方 = CI 门）；建书不 seeding——分发口径待确认（可能刻意设计为每书自带） | `src/ai/prompts/chat.ts:172` |
| AI 链路 | llm/call 事件 usage 丢 `estimated`/`reasoningTokens` 两键，事件库与 ai-calls 账本口径不对齐 | `src/ai/trace.ts:61` |
| AI 链路 | `sanitizeHistory` 占位消息「可由同函数重建」不变量无机器锁（铁律显式例外，补直测即收口） | `src/ai/prompts/chat.ts:377` |
| AI 链路 | mock 快路不过 chat 预算闸，注释未声明例外（测试用 mock 验闸会静默空过） | `src/ai/runner.ts:488` |
| 发布链 | desktop.yml 缺 check:docs，四 check 只有三个进 tag 发布腿（与 ci.yml 门集合对齐宣称不符） | `.github/workflows/desktop.yml:123` |
| 发布链 | 打包态冒烟只杀主进程不杀树，utilityProcess server 子进程成孤儿（`electron-smoke.mjs` 有 killTree 先例未复用） | `desktop.yml:338` |
| 发布链 | banner 的 `var require` 可翻转内联包 dual-mode 探测（`typeof require` 分支）；真凭据链未在打包态跑过 | `tsup.config.ts:79`（待核，建议重发出包后 `verify:responses` 打包态实连一次） |
| 前端 | 树红点聚合 rebuild/预扫段仍是单段同步块，网络盘书库可冻结服务（代码自认「不在本批允许清单」） | `src/check/run-tree-issues.ts:63` |
| 前端 | 单章机检账本核对冷缓存时在请求 handler 内同步整读多章正文（稳态有缓存，慢盘面） | `src/check/leads.ts:118` |
| 前端 | 合审档视角覆盖判定宽松：单文件存在即记全部视角已回收（R73-26 在案，等 submit_issues schema 加 lens 后收紧） | `src/review/run.ts:371` |
| 前端 | 根/子包重复 devDependencies（vue/pinin/plugin-vue）手抄无同步门，typescript 声明区间已漂移（实测同落 5.9.3） | `package.json:57` ↔ 子包 |
| 前端 | `checkLeadsBookItems` 固定 SQL 未收编连接级 prepared 缓存（同款热路径已迁 `shared/sqlite-prepared.ts`，此处漏网） | `src/check/leads.ts:84` |
| 测试 | `test:related` 路径写错静默空跑仅文档警示，无 wrapper 防呆（CI 跑全量不受影响，风险限本地 L1） | `package.json:32` |
| 测试 | 命名纪律存量负债 531/1272（42%）文件名带批次号前缀；新文件合规良好（0916 后新增 103 件仅 1 件），渐进在案 | `test/` 全树实测 |
| 测试 | coverage 阈值「只防回退不追高」档在册（learn branches 71、studio/server 73 等 razor 档） | `vitest.config.ts:143,182` |
| 测试 | e2e 全 mock 驱动，无「真网→真 SDK→UI」端到端线（协议线有 wire 单测补强；成本取舍，随发布说明披露即可） | `test/e2e/global-setup.ts:8` |
| 测试 | worker 入口三件 in-process 覆盖归因 0%（fork 态功能测试在 + 发布腿 smoke 兜底，属归因盲区非功能盲区） | `src/export/export-worker.ts` 等 |
| 治理 | package.json description「AI 长篇创作系统」与 README 定稿「写作软件 + AI 辅助层」口径张力（private 包影响低） | `package.json:4` |
| 治理 | 总览 §1.3 历轮评审枚举 9 篇 vs Archive 实有评审 13 篇；致谢 3 项 vs 本地参考项目 6 仓+1 文档（参考仓 774M 全本地零入库、无版权风险，工程研读口径知会作者即可） | `00-总览…md:20`、`Dev/参考项目/` |

## 五、README 承诺对账（八条全实装）

| 承诺 | 实装锚 | 状态 |
|---|---|---|
| 全自动写章（起草→体检→打回→重试上限停下问人） | `src/ai/orchestrate/self-heal.ts:798`（runChapter 循环 + evaluateRetry 触顶 escalate + 预算闸，SSE 流至前端） | ✅ |
| 三审（长篇读者/编辑/设定校对；短篇钩子/情绪反转/收尾） | `src/review/contract.ts:12`（六 lens）+ `src/studio/server/api/review.ts:195` | ✅ |
| 定稿前账本核对拦截 | `src/document/finalize.ts:185`（两端闭合红 → LEAD_GATE；回写失败不落基线） | ✅ |
| 伏笔埋了没收提醒 | `src/studio/server/api/foreshadows.ts`（fm 状态 + 全书足迹扫描） | ✅ |
| 字数曲线与规划对照预警 | `src/studio/server/api/rhythm.ts:174,317`（wordCurve + planned 双轨 + 逐章偏差 join） | ✅ |
| 文风库驱动机检与 AI | `src/studio/server/api/style.ts` + `src/check/runner.ts:178`（禁词红闸与条目库同源） | ✅ |
| 选中改写/分析 | `src/studio/server/api/rewrite.ts:74` + `analysis.ts:393` + `RewritePanel.vue:59` | ✅ |
| 工作台助手风险先问 + Key 本机加密 | `src/ai/orchestrate/chat/turns.ts:604`（waitConfirm）+ vault 信封链（HKDF→KEK→DEK→AES-GCM，明文仅内存） | ✅ |

## 六、审过无恙面摘要（六路核查结论）

- 数据层：B004 六入口全前置章号闸且 fm 缺失不入闸；F1 逐条合规（sqlite 仅索引/按书分库/手动编辑不事件化/format_version 留门/四通道合流单写口）；LF+无 BOM 四写面收口；留洞制崩溃不变量与幂等续跑实读未见违约；原子写/跨进程锁/回收站/版本留底全链在位；无绕过 atomic/store 的裸写旁路。200 万字兜底（增量重建、指纹缓存、流式导出、尾窗投影）为实装非口号。
- AI 链路：三协议流式失败出口逐行核实（refusal/content_filter 判错、截断可重试、半截产出不落稿、usage 折算估计入账）；三闸（deadline/确认/预算）为真闸；key 全生命周期（加密、0600 原子写、env 双向阻断、五层词表脱敏、错误文案不回显）无泄漏面；A006/MAX_AGENT_TURNS=20/switch-provider 恰一次全部落实；rag 空库早退、维度失配 fail-closed、毒向量剔除。
- 桌面/发布链：三依赖内联静态闭死（裸 import 全域扫描仅 font-list 一处在射程内）；冒烟出工作区实装；bash 3.2 花括号纪律全量扫描零违例；Electron 安全面配置正确（spread 后置不可放宽、IPC handleTrusted 白名单、双层 resolveWithinRoot、载荷净化三上限）；打包 files 白名单不含源码/密钥；机器门脚本无「锚失效静默通过」洞。
- 前端：17 个 Pinia store 边界纪律好、无千行巨件；doc store LRU 上限 20 + 崩溃脏镜像兜底；复读双多项式滚动哈希 + 全书扫描下沉 worker；CodeMirror 单点封装、undo 栈两步真重置、IME 守卫、listener 成对清理；双 package.json 边界实测干净（vue/pinia 双侧同版）。
- 测试：断言质量抽样 12 文件全真（无恒真/只跑不断，全库 0 个无 expect 测试文件）；e2e 基建稳健（陈旧产物 fail-closed、顺序快照双守卫、retries:0 论证成立）；`.only`/无条件 `.skip` AST 门封死盲区；1272 文件/33 spec 本机独立复核一致；src 20 个域测试对位齐全（views 层例外见 P2-5）。
- 治理：Docs 计数 0/1/1/0/15 逐目录核对全对；根 README 全部对外声称（Node ≥24、四计数、SHA256SUMS、无自动更新全仓零命中、MIT、致谢三链）机器门 + rg 实核相符；密钥零入库（全为测试假件）；.gitignore 无倒挂；CLAUDE.md 规则自洽无现行冲突实例。

## 七、披露（本次未覆盖面）

- Playwright e2e 未本地跑（需 build:web；CI 独立 e2e job 背书，33 spec/54 用例计数由 check:counts 静态口径核对）。
- 打包态真凭据链（`verify:responses`）未实连——关联 P3「banner require 探测待核」。
- rc.0 坏包结论基于 tag 锚点 + 阶段 50 根因自述 + Release 页资产实况三锚互证，未实际下载安装复现。
- win 腿三件计时敏感测试未本地复现重跑（台账脱节见 P2-3）。

## 八、收口条件

按 CLAUDE.md 评审条：**P1-1 处置（作者拍板：下架/移 tag 重发/bump rc.1，并在总览落账）+ P2×7 修复 + L2 回归通过** 后收口；收口后归档上一轮入 Archive。P3 随 RC 后常规批处置，不阻塞。

## 九、收口记录（阶段 51 修复批，2026-09-20）

**P1/P2 全修，P3 已修 14 / 立项登记 4 / 维持既有登记 5，随批全量回归绿——仓库面收口。** P1 终局处置 = 同版本重发（作者 2026-09-20 拍板：版本不 bump、tag 移指修复批提交重跑发布链、release job 删旧建新并复位已发布态），执行态见总览 §三。

- **P1-1**：处置两步——首拍 bump `1.0.0-rc.1`（package.json）+ tag 停 `530d3625`；作者终局指令改**同版本重发**（重发批版本回 `1.0.0-rc.0`，tag `v1.0.0-rc.0` 移指修复批提交、desktop.yml release job 增删旧建新 + 复位已发布路径）；总览 §三 落账。
- **P2-1**：`vault.ts` VaultOsKeyMissingError 文案补两态真实出路（暂缓期指引 + providers.json 重配）；直测钉死（vault-os-channel ② 追加 /暂缓期/ 与 /providers\.json/ 断言）。
- **P2-2**：check:packaging 新门 `problemsForDepsNoExternal`——package.json dependencies ⊆ tsup noExternal 并集（fail-closed：deps 非空而解析不到清单即红）；直测 5 例。
- **P2-3**：台账实体落档 `03-设计/win腿间歇红台账-现行规范-2026-09-20.md`（三件在册 + 吸收/甄别机制 + 维护规则），commit 消息不再作 known-red 载体。
- **P2-4**：tree-perf 首断言改相对口径（buildTree 5 次中位 < 同书裸读全部章文件基线中位 × 20，机器快慢同向缩放）；win-vitest-retry 首跑输出落盘 + 重跑洗白面 `::warning` 上浮（首跑红文件清单，供对台账甄别）。
- **P2-5**：vitest coverage views/pages 自聚合桶拆出单列显影桶（0/0 = e2e 自管边界显式登记），聚合桶 glob 收窄、80/66 门不放松。
- **P2-6/7**：总览复原锚节号 §四→§五（锚 `93e5df74` 实况亲核：一/二/三/五/六）；§三 状态行按发布实况重写。
- **P3 已修**（14）：structure-core 注释按实况改写；structure-split 撤「可重试拆分」死指引；structure-merge 无事件库形态分支指引；trace.ts 补 estimated/reasoningTokens 透传；sanitizeHistory 确定性直测 3 例（R69-12 重放不变量机器锁）；runner mock 不过预算闸注释声明；desktop.yml 补 check:docs（四 check 对齐）；mac/win 冒烟杀树（pkill -P 两段 + taskkill /T）；leads.ts 固定 SQL 收编 prepared；根/子包依赖同步门 + typescript 对齐 ^5.5.0；test:related wrapper 三闸防呆（零参数/坏路径/No test files found 兜底）；package.json description 对齐 README 定位；总览 §1.3 枚举补全（13 篇）。
- **P3 立项/登记**（4）：知识层分发口径 + 致谢补列 → 总览 §四 待拍板（各一）；慢盘面加固（树红点 rebuild/预扫同步块 + leads 冷 miss 切片让出）→ 总览 §三 阶段 52 候选首项；banner require 探测 → 静态核实销账（三包全树仅 `@anthropic-ai/sdk/bin/cli` 含 typeof-require 形态、bin 不入 SDK import 图，内联面零探测；重发出包后 `verify:responses` 打包态实连仍列操作项）。
- **P3 维持既有登记**（5）：死代码两件（哨兵注释已在位，删除留清理批）；lens 覆盖宽松（R73-26 登记裁定，解锁条件在案）；命名存量 42% 渐进；coverage razor 档（只防回退）；e2e 无真模型线 + worker 覆盖归因（披露项）。
- **门实录（修复批全量）**：typecheck ✅ + typecheck:web-next ✅ + eslint --max-warnings 0 ✅ + check:packaging ✅（含两新门）+ check:docs ✅ + check:knowledge ✅ + desktop.yml/ci.yml/win-vitest-retry action 三件 js-yaml 解析 ✅ + 定向回归 10 文件 71 例 ✅ + wrapper 三闸直验 ✅ + vitest 全量 ✅（计数随 README 同步，见 check:counts）。

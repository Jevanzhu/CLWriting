# 全库源码重评三轮——进度与质量评审

- 日期：2026-09-14。基线：`0d18f801`（win 分支 HEAD，工作树净，零代码改动纯评审批）。
- 执行模型：GLM-5.3（主审）。子代理七路同模型（R1–R7），主审与子代理无模型差异，不另列。
- 评审性质：独立全库重评（作者指令「忽略现有的评审文档，重新评审一遍项目源代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」）——既有评审报告正文（`01-评审/` 与 `Archive/`）零读取；进度口径仅取计划类正本（总览/台账/根 README），质量结论全部由本轮源码亲读与质量门实跑独立得出。
- 处置：2026-09-15 处置批全量处置（作者指令「全部修复」→「检查子代理是否卡死！」→「看到这次之前就超时失败了一次，是否是测试工程修复有问题，你仔细检查下，然后重试。」）——P2×3 全修 / P3 修 13〔P3-6 改道〕+ 维持 1〔P3-13〕/ nano 修 14 + 维持 3；L2 九门 win 一次全绿（1144 文件 = 7285 过 + 70 跳 0 败）；明细 = §十一处置记；随作者指令「提交改动」（2026-09-15）与落盘批同树入库。
- 编排：两波七路文件互斥只读评审子代理（波 1 = R1 服务端 53 文件 / R2 桌面壳·进程·脚本·构建 CI 59 件 / R3 AI·RAG·机检·知识 105 文件 / R4 核心数据域 94 文件；波 2 = R5 前端逻辑层 95 文件 / R6 前端视图层 111 文件 / R7 测试工程全景+分层抽样；单波 ≤4，在途 ≤4 全回收零阵亡）+ 主审亲读（r42 败因链全环 / service.ts rename 分支 / safe-path 折叠键族 / leads 三检 / setting-rule 抄本面 / state.ts 透出面）+ 主审亲验 P2×3 逐条对码与衔接疑点×3 处置。
- 覆盖账：src 497 个 .ts/.vue（含 web-next/src，不含 node_modules；另有 .mjs/.css 等合计 503 源文件）约 11.39 万行，test 1195 文件。子代理覆盖 = R1 53/53 逐文件、R2 46/46 逐文件（desktop 20 + process 18 + scripts 12 + 构建/CI 9，另 4 件交叉核验）、R3 105/105 逐行（唯 catalog.gen.ts 生成物按头注豁免细读）、R4 94/94 逐文件（service.ts/store.ts 等超长件分段）、R5 95/95 逐文件、R6 111/111 逐文件、R7 全景机器盘点 + helpers 10 逐读 + 抽读 21 文件 + 平台门四域 grep 面。主审亲验关键发现与全部疑点闭环。

## 一、判定总账

**P1×0 / P2×3 / P3×14 / nano×17**（P2 含 1 件测试门破口 + 1 件新发现功能缺陷 + 1 件台账在册重证；P3 含 1 件由子代理 P2 经主审降档）。

## 二、质量门实跑（评审时点，win 本机）

| 门 | 结果 |
|---|---|
| vitest 全量 | **1142 文件 / 7346 用例 = 7258 过 + 87 跳 + 1 败**（348.33s；败项 = `test/check/r42-join-fold.test.ts` R42-5 posix 腿，孤立复跑 9 过 1 败**确定性复现**，根因见 P2-1） |
| tsc --noEmit | 0 错 |
| vue-tsc --noEmit | 0 错 |
| eslint --max-warnings 0 | 0 error / 0 warning |
| check:counts | 过（win 口径对账 1142 文件 / 7259 单测与 README 一致——即预期 7259 过 vs 实跑 7258 过 + 1 败，缺口恰为 P2-1 败项） |
| check:packaging / check:knowledge | 过 / 过 |
| e2e（Playwright 31 specs / 51 用例） | **49 过 + 2 跳**（1.2m，常规命令口径；2 个发布 smoke 需 CLWRITING_E2E_RELEASE 未跑） |
| soak 两段 | **两段 OK**：有界往返 100000 迭代 8.34→8.32MB（−0.02）/ RAG 召回 20000 迭代 8.85→8.91MB（+0.06），上界 24MB |

> 首次 win 侧全量实锤注记：本 win 合并树（`8f970b7e` 起，win←mac 并树）此前从未在 win 宿主实跑过全量——README「本树按差值预期 win 1142 文件 / 7259 过 + 87 跳」系推算值（最近 win 实录停在合并前 `cc38ee98` 1130 文件批）。本轮实跑 = 合并树 win 首跑，败项为推算无法捕获的平台钉定语义破口（用例计数对得上、语义对不上），如实记档。

## 三、P2 发现明细（3 件，主审逐条亲验）

### P2-1 r42-join-fold R42-5 posix 腿在 win 宿主确定性失败——win 合并树全量门破口（测试面，产品面三平台语义正确）

- 位置：`test/check/r42-join-fold.test.ts:111-120`（败于 :116 断言 `expected undefined to be true`）；根因链产品侧锚点 `src/fs/safe-path.ts:156`（normalizeWinSeparators win32-only 收窄，复审-0913-mac适配 P3-2）+ `src/check/run.ts:226-235`（maxWrittenChapterOf 磁盘侧 `relative()`+`normalizeWinSeparators`）。
- 根因（主审 tsx 最小证明 + 逐环对码）：测试用 `Object.defineProperty(process,'platform','linux')` 钉平台后，win 宿主上 `path.relative()` 仍产**反斜杠**路径（宿主 OS 行为，钉 platform 不改变），而 P3-2 收窄后 `normalizeWinSeparators` 在非 win32 判定下 no-op → 盘侧键 `docJoinKey('写作\正文\001-第1章.md')` 与清单侧键 `docJoinKey('写作/正文/001-第1章.md')` **全量失配（连完全同名的 ch1 都 join 不上）** → 定稿集空 → maxWritten 走 R69-17 回退 = 全书最高现存章号 3 → 基准抬高 → 「履历第 2 章」不再判未来章 → 红项消失 → 断言败。mac/linux 宿主不受影响（relative() 本产正斜杠，归一化关闭无副作用——fc9283bb 批 mac 侧 1134 文件全绿互证）。
- 判定依据：产品在三个真实平台语义均正确（win32 真跑归一化开启；posix 真跑无反斜杠可归一）；缺陷在**测试钉定技术在收窄后于 win 宿主失真**（构造了「linux 平台标志 + win 路径行为」的现实不存在组合）。但后果实在：win 侧「npm test 全绿是合入门槛」破口，CI win 腿必红，故 P2。
- 建议修法（测试侧，最小）：R42-5 posix 腿加 `test.skipIf(process.platform === 'win32')`（win 宿主无法忠实模拟 posix 语义——posix 折叠语义已由 CI ubuntu/macos 腿真实宿主覆盖；同文件 learn/metrics/book-search 三族 posix 腿不经过 relative()+归一化链、win 宿主可忠实模拟，维持不动）。
- 关联：P3-11（win 口径覆盖缺口的又一实例面）。

### P2-2 根级文档 rename 产出 `./` 前缀清单键——docId 身份分裂、保存恒 REVISION_CONFLICT（R4 发现，主审逐环亲验成立）

- 位置：`src/document/service.ts:1585`（rename 分支 `newPath = ${dirname(oldPath)}/${sanitizeCreateSegment(op.newName)}`）；后果链 `:1782`（updateManifestPath 原样写清单）、`:394`（保存守卫 `docJoinKey(registered) !== docJoinKey(relPath)`）、`src/document/tree.ts:225`（树 join 键）。
- 触发面（亲验）：根级文档真实存在且可 rename——GUI 建书脚手架必落根级 `简介.md`（`src/install/scaffold.ts:97`，role=introduction `layout.ts:119`）；根级自由 .md 经 roleOf 兜底 note（`layout.ts:100` 注释「未匹配 → note（自由文档，全开）」，rename+move 能力全开）。`dirname('简介.md')` 返回 `'.'` → 拼出 `'./新名.md'`；`basename` 守卫（:1550）只查 `op.newName` 不查拼接产物；`resolveWithinRoot` 词法消解 `.` 后放行，磁盘物理落位正确——**登记与盘面分裂**。
- 后果（亲验）：`docJoinKey` 不剥 `./`（relPathKey = normalizeWinSeparators + platformCaseFold，主审最小证明两键恒不等）→ ①树扫描键 `新名.md` 与清单键 `./新名.md` join 失配 → docId 退化 legacyId（`.版本/`、`.journal/` 关联断裂，数据在盘不丢）；②前端按树路径保存 → `docJoinKey('./新名.md') !== docJoinKey('新名.md')` → **恒 REVISION_CONFLICT「现路径 ./新名.md」，刷新不解决**；③ legacy adopt 兜底可按新路径重登记 → 同一文件双条目 + 原条目幽灵化。
- 同族对照（坐实为漏网而非设计）：move 分支 `normalizeMoveToDir` 拒 `.`/`..` 段（R0912-3）；doCopy 拒 `..`/`.` 段（全库重评-0914 P2-2，:1826-1830 注释明书同后果为已修缺陷）；`layout.ts:93` `norm()` 剥前导 `./`。唯 rename 分支的 `dirname()==='.'` 形态漏网。
- 建议修法：rename 分支特判 `const dir = dirname(oldPath); newPath = dir === '.' ? sanitizeCreateSegment(op.newName) : ...`（一行级；不动 docJoinKey 全局口径，不牵已落盘清单数据）。

### P2-3 setting-rule 名册判重抄本与 check 域口径分裂——两种机检对同名册两种结论（R3 发现，主审逐字对码；台账 §三 D 域在册重证成立）

- 位置：`src/ai/rules/setting-rule.ts:129`（`PURE_HANZI_RE = /^[一-鿿㐀-䶿]{2,4}$/`，BMP-only）与 `:299`（`name.length` UTF-16 码元窗）vs `src/check/count.ts:331`（`ROSTER_NAME_RE` 含增补平面 `\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}` + `u` 标志）与 `:472-473`（`codePointLength(name)` 码点窗）——两处均系 R0912-3（2026-09-12 修复批）只修 check 侧、ai 域「只读参照」抄本未同步。
- 触发链：名册登记含 CJK 扩展 B+ 生僻字人名 → checkNewNames 经 ROSTER_NAME_RE 收入 registeredSet、正文提及不报；settingConsistencyRule 的 parseRosterNamesLocal 经 PURE_HANZI_RE 拒收 → 正文引号提及 + UTF-16 窗过 → 报黄「疑似未登记专名」→ 经 collectRuleViolations 流入 self-heal 重写反馈，对合法登记的生僻字人名反复产「请补建设定卡」误导指令——R48-3 曾消灭的「同一对白两种口径、经 self-heal 自我放大」场景复发面。触发面窄（生僻字人名罕见、黄级不卡流程），维持 P2 不升。
- 台账对照：§三 D 域已有 R0912-3 修复批代理上抛的「登记·待择收」行（「Ext-B 名 setting 域判重不可见，与 check 域 #32 修复后家族漂移，需后续批在 ai 域收敛」）——本轮独立重证成立，处置建议随本报告升级为「建议收」（结构修法见 P3-3）。
- 建议修法：短期最小 = setting-rule.ts:129 区段对齐 ROSTER_NAME_RE + :299 改 `codePointLength`；结构性 = count.ts 导出 ROSTER_NAME_RE / DIALOGUE_GUIDE_RE / ATTRIBUTION_RE / SPEECH_ATTRIBUTION_RE / parseRosterNames（含码点窗 helper），setting-rule 删抄本改 import（ai→check 单向，quotes.ts import 先例已在，不成环）。

## 四、P3 发现明细（14 件）

| # | 域 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| P3-1 | 服务端 | `api/rag.ts:140` | 后台 buildIndex fire-and-forget 未包 `trackInFlightWork`（同族 io/style-scan/detectState 均已接线；close 后 rmSync win ENOTEMPTY 面，索引可重建不丢数据） | `void trackInFlightWork(buildIndex(...))` 一行 |
| P3-2 | 服务端 | `api/rhythm.ts:130,109,69,140-142` | rhythm 唯一残留同步全书扫描（MISS 时双 readChapterDir 冷路径秒级冻结事件循环；progress/learn/tree-issues/foreshadows/search/analysis/health 全族已 async 化） | 照 foreshadows PM-1 双轨收口先例 |
| P3-3 | AI/机检 | `setting-rule.ts:129/147/151/155-156/161-174` | 守卫族五处逐字移植 count.ts 的抄面——防漂移靠注释纪律，已被证明失效两次（R48-3 前 + R0912-3，P2-3 即现行实例） | 导出共享单源（P2-3 结构修法） |
| P3-4 | 核心数据 | `cache/sync.ts:20-71` | syncLead 主表 INSERT 在 SAVEPOINT `sync_lead_history` 之外——独立调用且 history 段失败时 leads/lead_history 半不一致（派生缓存可重建；rebuild 主链有整体事务兜底；`loadLeadFromCache` 标注仅测试消费） | leads 写挪进 SAVEPOINT（一行移动） |
| P3-5 | 工具链 | `desktop.yml:212-247` | win 打包腿缺关窗链冒烟（mac 腿 :194-200 已接 CLW_SMOKE_APP_BIN；electron-smoke.mjs win 支持 :130-146 在位未接线）——win 首发平台的打包态关窗链零 CI 覆盖 | win 腿复刻 mac 两行形态 |
| P3-6 | 桌面壳 | `desktop/main.ts:127-141` | second-instance --book 直达：probeDirReachable 预探通过后仍同步扫书库（resolveInitialBook 内 readBooks）——网络卷「可达但慢/预探后瞬断」窗主进程秒级冻结 | 书名解析挪出主进程（server 子进程/utilityProcess 回执）或加有界超时降级留痕 |
| P3-7 | 进程域 | `process/spill.ts:85-86,96` | spill 正文写成功、meta sidecar 失败 → 返 null 降级但正文成无 sidecar 孤儿（不可达、仅节流 GC 1h/30d 收口） | sidecar 失败分支对刚写正文 best-effort unlink（内容寻址幂等） |
| P3-8 | 前端逻辑 | `stores/prefs.ts:458-471` | flushPendingPersist 缺「无待写不空写」守卫（对照 workspace.ts flushPendingBookPrefs 有守卫且注释明写口径）——每次关窗（含书架/书库独立窗）无条件同值 PUT，服务端 revision 无条件 bump → 存活窗陈旧 revision 伪 409 + 「已在其他窗口被修改」误导 toast（无数据丢失） | 对齐 workspace 口径加 `if (!persistTimer) return` 一行守卫 |
| P3-9 | 前端视图 | `WorkspaceShell.vue:313`、`StyleBaselineCard.vue:316` | 两处引用未定义 CSS token 恒走 fallback：`--font-size-sm`（刻度实名 `--font-size-s`，字号档不随全局缩放）/ `--font-mono`（实名 `--font-mono-space` 族 `--font-monospace`，win Consolas 档失守） | 改实名并删自定义 fallback |
| P3-10 | 前端视图 | `FontPicker.vue:211-228` 及 4 使用点 | win 自绘按钮/原生 select 均无可访问名称（域内同列 select 均有 aria-label） | 加 ariaLabel prop 或透传 |
| P3-11 | 测试工程 | test/ 全树约 20+ 用例 | EACCES/读失败注入族全依赖 `chmodSync`（posix-only，skipIf(win32)）——win 生产高发形态（杀毒/索引器/句柄占用）零注入覆盖、win 本地无反馈；CI ubuntu/macos 腿兜底（R7 报 P2，主审降档：覆盖缺口非功能缺陷，CI 三腿常开 + README 差值账透明） | makeUnreadable 平台分派助手（posix chmod / win spy）或 vi.spyOn 读函数注入 |
| P3-12 | 测试工程 | `r1010b:116,140,159,176` 等 | 真 sleep 残留三族：悬持窗族（sleep(50) 假定 handler 到达时点，慢 CI 假红向）+ mtime 垫片族（r36-12 ×8）+ 负向观察窗（server-manager，假红方向安全）——同文件 B 面已有 `__foreshadowSaveChainKeysForTest` seen 轮询的正确形态 | 悬持窗族改就绪探针轮询 |
| P3-13 | 测试工程 | main.test.ts 2755 行等 4 件 | >1000 行巨件四件（adapter 1475 / server-manager 1430 / chat 1011）——vi.resetModules 跨模块实例管理复杂（文件内注记自证曾出「旧窗锚定」假绿） | 按 describe 域拆文件，mock 工厂抽 fixtures |
| P3-14 | 测试工程 | src 全树 | 生产码 85 个 `__xxxForTest` 导出钩子无集中清单（对账零死引用，但导出面/误用面持续增长无门） | grep 守卫钉数量防无意识增长，或高频族收敛统一注入接口（与台账 G 域 testableConst 待拍板行联动） |

## 五、nano 汇总（17 件，不占处置带宽）

R1×2：`server/index.ts:352` host 变量跨作用域遮蔽（建议改名 reqHost）/ `api/check.ts:146` 观测层孤儿事件（无读取方，可 family bookMovedFailure 一行重验）。R2×5：`server-manager.ts:745-748` settle.by 三态并轨失真文案 / `font-cache.ts:299-301` 非严格弱序比较器（等价名内部次序不稳，登记备查）/ `dev-api.ts:33-34` --dir 取参宽松（严格口径基准在 verify-responses-relay）/ `windows.ts:245,321` 模块级可变导出 / ci.yml win 腿重跑兜底洗白窗（已登记上游跟进，维持）。R3×4：`self-heal.ts:417` 附近 `?? ''` 死防御 / `rag/index.ts:543-548` C5 缓存 body 后重算哈希白付 / `tree-issues-cache.ts:270-313` 每章重编译 SQL（prepared 缓存先例未收编 check 域，引入须配对关库纪律）/ `style-remedy.ts:44-54` 去包含单向与注释意图不对称。R4×2：`metrics/style.ts:147` import 位置 / `export/index.ts:499-529` 缩进排版。R6×2：`AiProviderEditor.vue:170` 编辑卡非法 key 无就地反馈（域内 RagProviderEditor 口径不对称，行为闭环）/ `ExportDialog.vue:60-63` IME 检查次序（无实害）。R7×2：mock client 内本地复刻 ApiError 类 / 临时目录双卫生体系并存。

## 六、衔接疑点处置（主审亲验，三件全销案）

1. R6 疑点「crashedPendingOpIds 服务端未透出、UI 永不出现」→ **证伪**：`api/state.ts:121` 透出 + `WbStateCard.vue:67-68` 消费 + `api/workbench.ts:34` 类型声明三面在位（子代理引注释口径与实现不符）。
2. R1 疑点「stream.ts auto-write 二次闸检与 self-heal 置闸间双跑窗」→ **销案**：`self-heal.ts:204-209` 并发守卫（闸被绕过即抛「self-heal 并发守卫失效」），双 self-heal 不可达。
3. R2 疑点「materials.ts UTF-16 偏移与 RAG chunk 口径」→ **销案**：两侧同用 `format/frontmatter.ts` readFile 的 body（materials.ts:19 与 rag/index.ts:22 同 import），UTF-16 slice 同基同源；索引与渲染间的文件变更由 RAG 指纹失效兜底。

## 七、进度结论

- **功能完成度：24/24 阶段全量收口（100%）**——总览第三节开放任务看板空，阶段 24（章节结构操作）全三批 A/B/C 于 2026-09-13 收口；三件 02-执行 方案均已实施完成；版本 1.0.0-rc.1，**RC 打磨期**（当前批不改该判定）。
- 残留挂账（非功能缺口，均为拍板/择收/备案态）：阶段 24 三项待拍板（inline 章号盲区 / 树显示序跨卷分组 / undo 回收站反查歧义）+ 台账 §三 A–G 域按域看板（本轮 P2-3/P3-14 等与在册行互证，无失时效项）+ §三 H 精简总账余量（产品侧登记性 ~610 行 + 测试侧负窗轮询化）。
- 平台三线状态：win/mac 适配专项均已收口（复审-0913-win / 复审-0913-mac适配）；本轮新实锤的 win 侧事项为 P2-1（测试面）与 P3-5/P3-11（CI 覆盖面），产品面 win 适配成熟度维持高位。

## 八、质量结论

**质量评级：高（A− 量级）。** 依据：

1. 七路独立评审 504 件全覆盖（源码逐文件 + 测试全景/分层抽样），**P1×0**——未发现数据丢失/损坏/安全/费用失控级缺陷；数据面防线（原子写、锁序、排水链、bookMoved 重验族、崩溃自愈三链）经 R1/R4 独立复核全部在位。
2. 本轮质量门：tsc / vue-tsc / eslint / 三 check 全过 + e2e 49 过 2 跳 + soak 两段 OK；vitest 唯一败项为测试钉定技术面（产品三平台语义正确，P2-1 已根因闭环）。
3. 新发现集中在：合并树 win 侧验证缺口（P2-1 + P3-5/P3-11，均测试/CI 面）、边角功能缺陷（P2-2，一行级修复）、在册重证（P2-3）——无架构级/系统性回退。
4. 正向密度（R1–R7 交叉印证）：三层防线（Host/Origin/token）+ SSE ticket 通道无洞；错误信封单出口；任务闸体系（进程内+跨进程+治理静态对账门）完整；删书排水五连 + bookMovedFailure 单源重验家族全接线；注释即台账（修复留痕 + 主动勘误文化）罕见地好；单源收敛成体系；fail-closed/fail-open 分界清晰且降级必留痕；三协议适配器 wire/计费/降级链一致；RAG 生命周期（ephemeron 断链、busy_timeout 前置、损坏窄判定）完备；机检正则面无灾难回溯（adjStack 守卫 469ms→0.1ms 实测在档）；码点口径全域统一；测试 helpers 单源化 + e2e 顺序契约全链设防 + 假绿防御纵深成体系。

## 九、处置建议

- **建议收（P2 三件）**：P2-1 测试 skipIf 一行（合入门槛破口，先修）；P2-2 rename 一行特判；P2-3 setting-rule 对齐两处（或径直取 P3-3 单源收敛档）。
- **择收（P3）**：P3-1/P3-8/P3-9 一行级低成本高确定性；P3-5 两行 CI 接线；P3-3 与 P2-3 并批；P3-2/P3-6/P3-7/P3-4/P3-10/P3-11/P3-12/P3-13/P3-14 按域登记待择收。
- **维持**：nano×17 全部维持登记；R7 拍板建议（win e2e 缺位等交界盲区）归 G 域既有行口径。

> **2026-09-15 处置批注记**：上表已执行且超量——P2×3 全修；P3 修 13〔P3-6 系改道最小路径〕/ 维持 1〔P3-13〕；nano 原判「全部维持登记」实际修 14 / 维持 3（维持面窄于本表建议，系逐项亲验后择优，明细见 §十一）。

## 十、已知债务复核（台账 §三 对照）

- 本轮独立重证成立且在册：P2-3（D 域 setting-rule 行）、P3-12（G 域 sleep 脆弱面行）、P3-13（G 域巨件行）、P3-14（G 域 testableConst 行联动）、R2 nano win 重跑洗白窗（G 域上游评估行）、P3-6（A 域 second-instance 同族扫描面——注：darwin focus 已修，本条为 --book 直达路径的同步扫库面，登记口径较在册行更细）。
- 本轮新立（不在册）：P2-1、P2-2、P3-1、P3-2、P3-4、P3-5、P3-7、P3-8、P3-9、P3-10、P3-11。
- 在册项无一件失时效（抽验 locateMergeByDisk / trash.delete 竞窗 / rag rebuild 闸 / platformCaseFold 卷级敏感性等均在案维持）。

## 十一、处置记（2026-09-15 处置批）

指令链：「全部修复」→（波 2 测试工程子代理两度超时阵亡）「检查子代理是否卡死！」→「看到这次之前就超时失败了一次，是否是测试工程修复有问题，你仔细检查下，然后重试。」

**处置总账：P2×3 全修 / P3×14 = 修 13〔含 P3-6 改道〕+ 维持 1〔P3-13〕/ nano×17 = 修 14 + 维持 3。**

### P2（3/3 全修，主审亲修）

1. **P2-1 修**：`test/check/r42-join-fold.test.ts` R42-5 posix 腿包 `test.skipIf(process.platform === 'win32')`——win 宿主上钉 `platform='linux'` 依赖「`relative()` 产正斜杠」的前提已被 normalizeWinSeparators win32-only 收窄破坏；产品三平台语义正确，修测试钉定面一行，口径注记随用例头。
2. **P2-2 修**：`src/document/service.ts` rename 分支 `dirname(oldPath) === '.'` 时改 `sanitizeCreateSegment(op.newName)` 直拼——根级文档（如脚手架必落的 简介.md）不再产 `./` 前缀清单键；新增 `test/document/r0914c-rename-root-doc.test.ts` 2 例（根级 rename 后清单键 = `新名.md`、登记与保存全链成功；非根 `笔记/乙.md` 行为不变对照）。
3. **P2-3 修**：`src/ai/rules/setting-rule.ts` 守卫族五处逐字抄本（PURE_HANZI_RE / ATTRIBUTION_RE / SPEECH_ATTRIBUTION_RE / DIALOGUE_GUIDE_RE / parseRosterNamesLocal）全删，改 import `check/count.ts` 单源导出（count.ts 侧新导出 ATTRIBUTION_RE / SPEECH_ATTRIBUTION_RE / DIALOGUE_GUIDE_RE / parseRosterNames，ai→check 单向 import，quotes.ts/self-heal 先例同向）+ 名册候选窗 UTF-16 length → `codePointLength`（shared/text 单源）——Ext-B 生僻字名两检同判；`re2-p3-setting-rule-check-parity.test.ts` 对拍 +2 用例（在册名两检均不报 / 未在册名两检均报，双向断言）。台账 §三 D 域在册行随批销账（销账注已落）。

### P3（修 13 + 维持 1）

- **P3-1 修**：`api/rag.ts` buildIndex 改 `void trackInFlightWork(...)` 接线（同族 io/style-scan/detectState 形态）。
- **P3-2 修**：`api/rhythm.ts` 照 foreshadows PM-1 双轨收口——同步孪生保留为回归直测面、生产路由挂 async 孪生（`getRhythmCachedAsync`：同壳共 Map 同 TTL 同签名，MISS 走 `rhythmComputeAsync` 扫描段前后 setImmediate 让出 + in-flight 去重并发只扫一次）；边界如实注：内核 `readChapterDir` 双目录整读仍单段同步块（chapters.ts 不在本批允许清单；热路径有 CC-P1-3 stat 级元数据缓存兜底）。`r44-rhythm-cache.test.ts` +2 例。
- **P3-3 修**：随 P2-3 单源收编销案（抄本删除即本项闭环）。
- **P3-4 修**：`cache/sync.ts` leads 主表 INSERT 挪进 SAVEPOINT `sync_lead_history`（一行移动）+ `sync-transaction.test.ts` +1 例（history 段失败时 leads 同回滚）。
- **P3-5 修**：`desktop.yml` win 打包腿接线关窗链冒烟（glob + test -x 守卫 + CLW_SMOKE_APP_BIN 注入，mac 腿同形态两行）。
- **P3-6 改道修**：报告两案（书名解析挪 server 子进程/utilityProcess 回执）经评估均非最小路径——改第三路径：对真实读面 `<workDir>/.clwriting/books.jsonl` 补一道 `probeDirReachable` 有界二探，'unreachable'（挂死）即降级忽略直达 + warn 留痕；'invalid'（ENOENT 快速失败）不拦（readBooks 对缺文件本就降级空表、走既有「无此登记书」留痕）；TOCTOU 残窗（预探后瞬断）按同族 R54-A-2 防线既定取舍如实记档——冻结面从恒现路径收窄为预探后瞬断窗。
- **P3-7 修**：`process/spill.ts` sidecar 失败分支对刚写正文 best-effort `rmQuietly` unlink（内容寻址幂等，不再留无 sidecar 孤儿）+ `spill.test.ts` +1 例。
- **P3-8 修**：`stores/prefs.ts` flushPendingPersist 加 `if (!persistTimer) return` 守卫（对齐 workspace.ts flushPendingBookPrefs 口径——关窗不再无条件同值 PUT）。
- **P3-9 修**：`WorkspaceShell.vue` `--font-size-sm` → 实名 `--font-size-s`；`StyleBaselineCard.vue` `--font-mono` → 实名 `--font-monospace`（删自定义 fallback）。
- **P3-10 修**：`FontPicker.vue` 加 ariaLabel prop + 6 使用点接线（SettingsAppearance / SettingsEditor / FocusFormatBar 等）。
- **P3-11 修**：新立 `test/helpers/fs-deny.ts` 平台分派 EACCES 助手（posix 臂物理 chmod〔createRequire 运行时取真 fs，绕开 mock 注册表〕/ win 臂 armFsNamespace 模块命名空间包装注入 Node 原生形态 EACCES 信封——code/errno/syscall/path 四字段对齐；消费文件缺 vi.mock 包装即拒注入报错，绝不静默假绿）+ EACCES 族 11 文件摘 `skipIf(win32)` 迁移（r31b-machine-correctness / r51-en1-en2-rebuild-advisory-strict / tree-issues-leads-book / manifest / words-diary-read-fail / books-guard / settings-injection / spill / summary-volume / summary / static N-3）——win 生产高发形态（杀毒/索引器/句柄占用拒读）win 本机真跑；`skipIf(win32)` 声明面 80→63、win 运行跳 84→70。事故面见下「测试工程事故记档」。
- **P3-12 修（按本报告建议口径）**：悬持窗族 4 文件轮询化——`r0911-srv-write-bookmoved`（×7 sleep 点）/ `r0913-srv-prefs-bookmoved` / `r1010b-srv-documents-bookmoved` 经 fake-reqres 新助手 `waitForBodyArmed`（readJson 数据监听计数就绪探针）替代 sleep(50)；`r0910-w-shutdown-teardown` SSE 连接登记改 `waitFor` 探针。r55:129 亲验 = 断言后收口等待（实质断言在其上方）、非悬持窗族，维持；mtime 垫片族（r36-12 ×8）/ 负向观察窗（server-manager）按报告判定维持。台账 §三 G 域行处置注已落。
- **P3-13 维持**：>1000 行巨件 4 件（main 2755 / adapter 1475 / server-manager 1430 / chat 1011）——按 describe 域拆文件 + mock 工厂抽 fixtures 系重设计体量非一线修；台账 §三 G 域在册维持（处置注同步）。
- **P3-14 修**：新立 `test/check/r0914c-fortest-hooks-guard.test.ts` grep 数量守卫——src 全树 *.ts/*.vue 递归统计行首 `export (async )?function|const __…ForTest` 形态，在锚 **71**、超限即红须有意抬锚留因（单向守卫：只拦增长不拦收编）；口径注记：评审面宽口径 85 系含非行首/间接形态，守卫取可 grep 稳定子集（71），两者非矛盾口径。台账 G 域 testableConst 拍板行处置注已落（全量换装仍待作者拍板）。

### nano（修 14 + 维持 3）

- **修 14**：R1 `server/index.ts` host 变量改名 reqHost（遮蔽消除）/ `api/check.ts` 观测层孤儿事件收编 bookMovedFailure 单源重验；R2 `server-manager.ts` settle.by 三态文案记正 / `font-cache.ts` 比较器等价名 tie-break（严格弱序补全）/ `dev-api.ts` --dir 严格取参 / `windows.ts` 模块级可变导出改 `getDevProxyApplied`/`setDevProxyApplied` 访问器；R3 `self-heal.ts` 4 处 `?? ''` 死防御删 / `rag/index.ts` C5 staleHashes 前置（缓存 body 后重算哈希白付消除）/ `tree-issues-cache.ts` 每连接 prepared-statement WeakMap 缓存 / `style-remedy.ts` 注释意图与单向包含对称化（零行为）；R4 `metrics/style.ts` import 归头 / `export/index.ts` 缩进排版；R6 `AiProviderEditor.vue` 编辑卡非法 key 就地反馈；R7 mock client 本地复刻 ApiError 类 44 文件收编（importOriginal 展开式工厂保真导出 + 逐文件 overrides 保留，grep `ApiError: class ApiError` 零残留；另 4 文件异形本地声明经复核非同族形态域外维持）。
- **维持 3**：ci.yml win 重跑兜底洗白窗（G 域上游评估在册，本批不动 CI 测试步配置）/ `ExportDialog.vue` IME 检查次序（处置亲验证伪可伤性前提，维持现状）/ temp-dir 双卫生体系并存（mkdtempTracked 251 文件 vs ad-hoc 307 文件——强制迁移非一线收益，记档维持，台账 G 域注）。

### 测试工程事故记档（作者指令专项闭环）

波 2 测试工程子代理两次超时阵亡（首派 + 重试）。根因（主审二分定位：settings-injection.test.ts 单文件收集期挂起 90s 不出；最小化 spike v1/v2 挂、v3 过）= fs-deny.ts 初版静态 `import { chmodSync } from 'node:fs'` 与消费测试文件 `vi.mock('node:fs')` 工厂的**循环 await 死锁**——mock 工厂执行期动态 import fs-deny → fs-deny 顶层静态 import node:fs → 命中同一未完成的 mock 注册表 → 收集期互等；vitest 收集期无超时护栏、静默挂起（testTimeout 不覆盖收集期），代理反复执行挂起命令耗尽时限阵亡。manifest.test.ts 仅因 import 次序侥幸通过（未先触发 mock 注册）。修复 = posix 臂改 `createRequire(import.meta.url)('node:fs')` 运行时取真模块（绕开 mock 注册表——物理 chmod 本就要作用于真文件系统）+ 头注立「本文件永不得静态 import node:fs / node:fs/promises」纪律 + 全消费文件 mock 工厂改 armFsNamespace 分层形态；修复后各变体全绿，重派 ApiError 专项代理 44/44 零阵亡全绿复验。两代理阵亡系工程事故如实记档，其半成品磁盘件经验绿后收编（非静默丢弃）。

### 编排

处置编排 = 波 1 四路文件互斥修复代理（A 服务端+RAG+进程搜索 8 件 / B 桌面壳+前端逻辑 4 件 / C CI+前端视图 6 件 / D AI+导出+工具链 4 修 + 1 证伪；在途 ≤4 全回收零阵亡）+ 波 2 测试工程专项（fs-deny 助手 + EACCES 全族迁移；首派代理两度收集期挂起阵亡，根因修复后主审亲收余量〔static.test.ts N-3 摘 skip + r0910-w SSE 探针〕并重派 ApiError 收编代理）+ 主审亲修 P2×3 + 台账/文档链收口。

### 门禁与记账（处置批 L2 终门，win 本机亲跑全绿）

| 门 | 结果 |
|---|---|
| vitest 全量 | **1144 文件 = 7285 过 + 70 跳 0 败**（370.02s 一次全绿；上批实录 1130 文件 = 7194 过 + 84 跳——本批净 +14 文件〔含 2 新〕/+91 过/−14 跳，P2-1 败项销案） |
| tsc --noEmit / vue-tsc --noEmit | 0 错 / 0 错 |
| eslint --max-warnings 0 | 0 error / 0 warning |
| check:counts / check:packaging / check:knowledge | 过（修账后复跑）/ 过 / 过 |
| e2e（Playwright 31 specs / 51 用例） | **49 过 + 2 跳**（1.1m，常规命令口径；2 发布 smoke 需 CLWRITING_E2E_RELEASE 未跑） |
| soak 两段 | **两段 OK**：有界往返 100000 迭代 8.35→8.33MB（−0.02）/ RAG 召回 20000 迭代 8.86→8.92MB（+0.06），上界 24MB |

记账算术（逐位闭合）：单测门槛声称（mac/linux 口径）7339 → **7365** = 新测试文件 2 个 3 例（r0914c-rename-root-doc 2 + r0914c-fortest-hooks-guard 1）+ 既有文件净增 23 例声明；测试文件 1142 → **1144**；win 实测收集（vitest list）**7285** = 7365 − 差值锚 **80（锚维持）**——EACCES 族摘 skipIf(win32)（声明面 80→63）与 posix 臂拆分/r42 门腿回加对冲净 0；win 运行跳 84→70（摘 skip 真跑所致）。stash 探针实测处置前树 win 收集 7262 = 预期 7259 + 新文件 3 例，与终态 7285 之差 = 既有文件净增 23——全链闭合。根 README 修账六处（徽章 / npm test 行 / 门槛行 1144·7365 / 差值锚组成注 / win 实录链换新 / 技术栈行）后 check:counts 复跑过。

### 改动面

src 27 文件（非 web-next 19：ai/orchestrate/self-heal、ai/rules/setting-rule、ai/rules/style-remedy、cache/sync、check/count、check/tree-issues-cache、desktop/font-cache、desktop/main、desktop/server-manager、desktop/windows、document/service、export/index、metrics/style、process/spill、rag/index、studio/server/api/check、api/rag、api/rhythm、studio/server/index；web-next 8：WorkspaceShell、StyleBaselineCard、FocusFormatBar、AiProviderEditor、FontPicker、SettingsAppearance、SettingsEditor、stores/prefs）+ scripts/dev-api.ts + .github/workflows/desktop.yml；test 改 65（含 webnext 44 ApiError 收编）+ 新 2（r0914c-rename-root-doc / r0914c-fortest-hooks-guard）+ 新助手 test/helpers/fs-deny.ts + 助手改 2（fake-reqres 增 waitForBodyArmed / temp-dir 记档注）；文档链 6（本报告、台账、总览、Dev/Docs README、Archive/README 批记行、根 README）。

### 文档链同步与状态

本报告头部处置行 + §九处置批注记 + 本节；台账 §一 首行收口改写（处置完毕待归档）+ §三 D 域销账注 + G 域两行处置注；总览 §1.3 行收口改写；Dev/Docs README 三轮行改写；Archive/README 处置批批记行（本目录 ±0，报告未归档仍活跃）。——落盘批 + 处置批两批同树随作者指令「提交改动」（2026-09-15）入库；归档移位（01-评审 → Archive）待后续批。

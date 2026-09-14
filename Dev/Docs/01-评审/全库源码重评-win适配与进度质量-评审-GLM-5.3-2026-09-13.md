# 全库源码重评：win 适配专项 + 进度与质量（2026-09-13）

- 日期：2026-09-13。性质：纯评审落盘（零产品码改动，L0 文档面）；**修复批已随作者指令实施完成，处置记 = §八**（P2×3 全修 + P3 13 修 2 维持，L2 终门九件套全绿）。
- 基线：`2510a1ec`（win 分支，工作树净）。
- 执行模型：GLM-5.3（主审）；子代理三路只读（Explore，同模型）。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目源代码，这次注意win系统适配问题，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。该模型只有RPM10。」
- 编排注记（RPM 10 约束）：读取大批量合并、子代理单波 3 路（≤4 上限内）文件互斥分域后台并行，主审同时亲读 fs 域——请求洪峰受控。

## 一、评审口径与方法

**忽略既有评审文档**：本报告不以 `Dev/Docs/`（含 Archive）历轮评审结论为前提，全部发现来自本轮对源码的直接核查（file:line 以基线工作树为准）。总览/台账/根 README 仅用作**进度事实**的记账来源（阶段状态、测试计数、coverage 历史值），引用处均已标注——记账非评审结论，不违作者指令口径。

覆盖面：

| 域 | 覆盖方式 |
|---|---|
| src/fs 全部 11 文件 | 主审逐文件亲读 |
| document / install / studio/server / state / format / check | 子代理 A 彻查（very thorough） |
| desktop / git / process / events / scripts / 构建与 CI 配置 | 子代理 B 彻查（very thorough） |
| ai / rag / cache / knowledge / learn / review / metrics / log / shared / export / driver / web-next 前端 | 子代理 C 彻查（very thorough） |
| 质量门 | 主审 win 本机实测（§二） |
| P2 级发现 | 主审逐条亲验对码（§三标注「主审亲验」） |

## 二、实测质量门（win 本机，2026-09-13）

| 门 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | **0 错误** |
| `npm run lint`（eslint --max-warnings 0） | **0 错误 0 警告** |
| `npm run check:counts` | **过**（README 计数与实际一致） |
| `npm test`（vitest 全量） | 两轮：**首轮撞已知收尾竞态阵亡于汇总前**（vitest×tinypool forks 池 `ERR_IPC_CHANNEL_CLOSED`，台账 §三 G 域在案登记的 win 专属家族，CI 有重跑兜底）；重跑完整出汇总 **1122 文件 / 7243 用例 = 7158 过 + 84 跳 + 1 败 0 弃**——总用例数与根 README win 预期口径（7159 + 84）逐位吻合。唯一失败 = `test/document/re2-manifest-lock-reentry-async.test.ts`「外层持锁、首个 fn await 在途时发起的重入 async 调用排队…」：sleep(100) 定位窗口型时序用例在满负载全量并行下窗口失守（**孤立复跑 5/5 全绿**，806ms），属台账 §三 G 域已登记「sleep 竞态窗系统性脆弱面（慢环境闪红为主）」家族的偶发假红，非真缺陷 |
| `npm run test:e2e`（Playwright） | **49 过 + 2 跳（1.2m）**——2 跳 = 发布 smoke 需 `CLWRITING_E2E_RELEASE` 环境变量，与根 README 口径一致 |

本轮未跑 coverage（L2 重门）；最近一次记录值 = 91.71 / 87.27 / 96.23 / 91.71（2026-09-13 源码重评修复批 L2 终门，出处台账 §一），如实标注引用非本轮实测。

## 三、win 适配专项发现（P1×0 / P2×3 / P3×15）

分级沿用项目口径：P1 = 丢数据/功能破坏；P2 = 边界场景出错/需用户干预；P3 = 健壮性缺口/备注。

### P2（3 件，均主审亲验对码属实）

**P2-1｜style.ts `insideDir` 守卫被反斜杠 `..` 段绕过——「限 文风/条目/ 内」的端点契约在 win 上失守（子代理 A 发现，主审亲验）**
- 证据：`src/studio/server/api/style.ts:70-81`——`insideDir` 只按 `split('/')` 判独立 `..` 段，不归一反斜杠。消费点 `style.ts:164`（entries.delete 范围检查）→ `:173-188`（`resolveWithinRoot` 后 `rmSync(safe.abs, { force, recursive })`）；同型 `:223-227`（candidates.confirm）/`:252-256`（candidates.ignore）。
- 风险：请求 `path = "文风/条目/..\..\设定\角色.md"` 时 `split('/')` 无独立 `..` 段 → insideDir 放行；`resolveWithinRoot` 的 `resolve` 在 win 把 `\` 当分隔符折叠后仍在 bookRoot 内 → 也放行 → **可删/搬/写条目目录以外的书内任意文件**。不会越出书根（防穿越闸有效），且触发需持会话令牌的本地客户端发恶意构造路径（本机进程本属同信任域，README 安全节自认）——故 P2 不升 P1。全仓同类守卫均先归一反斜杠（`service.ts:229` normalizeMoveToDir、`layout.ts:89-91`、`service.ts:2173` isSanitizedCreatePath 双分隔符切分），唯独此处漏。
- 修法：一行——`rel.split(/[\\/]/).includes('..')` 或入口先 `replace(/\\/g,'/')`（对齐全仓口径）。

**P2-2｜AI 章节工具 docId join 未折叠——case-only 改名/NFD 文件名后 AI 工具链硬败（子代理 C 发现，主审亲验）**
- 证据：`src/ai/tools/shared.ts:34`——`if (e.path === relPath) return e.id` 精确字符串比较；同仓 `fs/safe-path.ts:174-182` 的 `docJoinKey`（分隔符归一 + win/darwin 大小写折叠 + NFC）正是为这类「清单登记路径 vs 请求路径」join 点立的单源，export/learn/metrics 均已接入，唯此点漏网。
- 风险：win 上外部 case-only 改名（或 mac 拷来的 NFD 文件名）后真 docId 查不到、回落 `legacyId(relPath)`（新 case 的哈希）→ AI 章节结构工具（move/rename/copy/delete）拿到的 docId 服务层解析失败，操作硬败。主 UI 侧同场景已被 docJoinKey 修好。
- 修法：一行——`e.path` 比较前两侧过 `docJoinKey`。

**P2-3｜win 字体枚举唯一通道 PowerShell，受限环境无回落——字体下拉整会话静默空（子代理 B 发现，主审亲验）**
- 证据：`src/desktop/win-fonts.ts`（spawn powershell.exe + `Add-Type PresentationCore`，经 `SystemRoot` 拼绝对路径、Buffer 整流解码、10s 超时 kill、进程级熔断）；`src/desktop/main.ts:1677-1690`——win 分支唯一走 `listWindowsFonts()`，`catch → return []` 静默空表，无 registry（`HKLM\...\Fonts`）或 DirectWrite 类回落，无用户可见提示。
- 风险：企业受限环境（PowerShell Constrained Language Mode、AppLocker、杀软拦 PS）下脚本必败，连败熔断后字体下拉整会话返空，仅 JSONL 日志有痕。边界环境功能退化，非数据面。
- 修法建议：登记 registry 回落（或至少字体下拉空态文案提示「系统字体枚举受限」）。注：mac 侧 font-list 有自带回落链（system_profiler），win 侧不对称。

### P3（15 件，按族归并）

**折叠键纪律漏网族（4，与 P2-2 同族的小尾巴）**
1. `src/cache/sync.ts:121`——`prev.path !== ch._path` 绝对路径精确比较（重复章号告警判定），盘符/路径 case 漂移时误报「重复章号」warn（仅文案，无功能影响）。
2. `src/cache/rebuild.ts:128`——缓存失效前缀 `bookRoot + sep` 无折叠，同书不同 case 寻址时 `forgetChapterParseCacheForBook` 清不净（FIFO 2048 兜底，内存卫生态）。
3. `src/ai/provider/store.ts:134,335-348`——providers.json 写链以原始 `userDataPath` 字符串为键，两种 case 寻址拆两条进程内串行链（跨进程文件锁仍在，实害极小）。
4. `src/fs/md-text-cache.ts:115-124`——`forgetMdTextCacheForBook` 前缀 `bookRoot + sep` 同上无折叠（主审亲读发现；键由同源 walk 路径派生，现实触发需 case 漂移的注册面，理论级）。

**瞬时锁退避漏网族（3，rmWithRetry/renameWithRetry 口径之外的裸调用）**
5. `src/studio/server/api/style.ts:188`——删条目裸 `rmSync`（win 杀软/索引器瞬时锁下 500；同族删源点 trash/service/foreshadow/version 均已收编退避）。
6. `src/format/style-migrate.ts:268,313,332`——迁移删源三处裸 `rmSync`（迁移幂等可下轮自愈，仅迁移期报错 + 旧目录滞留一轮）。
7. `src/state/state.ts:366`——孤儿 journal 归档裸 `renameSync`（瞬时锁下归档失败 → 维持 crashedWrite 假红，下次进门自愈；同函数 `healMovePending` 删旧已用 rmWithRetry）。

**win 特有形态边角族（4）**
8. `src/document/service.ts:1287-1296`——章纲同步改名 fallback 对「仅大小写变化」产 `X-旧稿-<时间戳>.md` 错名（linkOrRenameExclusive 对同物理文件恒 EEXIST 走时间戳双份分支；内容无损需手工改名；窄边界：章纲未入清单命中 + case-only）。
9. `src/git/exec.ts`（scanCloudCopies 模式表）——缺 Windows 资源管理器首份副本 `xxx - Copy.md`（无数字后缀母本）漏报，仅进门提醒功能，README 只披露了 OneDrive 形态。
10. `src/desktop/main.ts`——SIGTERM handler 在 win 对外部 kill（TerminateProcess）事实性失效（该行只对 POSIX 生效；Ctrl+Break 已由 SIGBREAK 覆盖、硬杀由 backstop 兜底）——备注级事实，无害。
11. `src/desktop/main.ts`（open-library-dir / open-book-dir）——`shell.openPath` 返回 promise 被丢弃，打开失败零反馈（路径已 realpath，无注入面，纯 UX）。

**环境边界族（2）**
12. `src/events/store.ts:49-90`（trueCasePath）——对书根逐段同步 `readdirSync`；书库在失联网络卷时 server 子进程事件循环被同步冻住（主进程侧 probeDirReachable 防线不覆盖 server child 内首调；memo 512 限频，实测风险低）。
13. `src/desktop/main.ts:227`——单实例锁在提权差异（管理员/普通用户双开）时 Electron 锁机制失效可双开（Electron 已知限制，workdir.json 语义层无二级守卫；极边缘）。

**预算与测试面（2）**
14. `src/document/service.ts:889-946`（doCreate）——relPath 逐段 120B 消毒但不限段数与总长：深层多段路径超 MAX_PATH 时 ENAMETOOLONG 收编为 WRITE_ERROR 信封（不丢数据、可见可重试），但错误文案是裸 errno（对照 doInit 有「换更浅位置」人话）；可选补总长预算或人话文案。
15. win 测试面两备注：CI win 腿「首跑红→重跑」兜底会掩盖真实间歇失败（注释自认、上游修复后撤——台账 §三 G 在案维持项，本轮首轮实测即撞该家族）；win 腿不跑 e2e/release-smoke（D5 拍板，tag 时 25s 存活冒烟兜底）——覆盖面备注非缺陷。

### 已核实安全的检查面（摘）

正斜杠 relPath 约定在磁盘边界无系统性泄漏：全部 `relative()` 消费点均带 `replace(/\\/g,'/')` 归一（slashRelative 族）；树扫描 Dirent.name 不含分隔符；`split('/').pop()` 类位点输入均为系统构造正斜杠路径、被篡改时 fail-safe 退化。用户输入建名防线全覆盖：书名 `isInvalidBookName`（非法字符/保留设备名含扩展名形态/尾点尾空格/120B/NFC，三入口齐）+ 文件名 `sanitizeFileNamePart`（NFC→控制字符→非法字符→保留名→码位/字节双封顶，全部建名入口含 create/rename/move/copy/软删/草稿/伏笔迁移均收编）。大小写不敏感三面（判重 dev+ino 物理身份 / case-only 改名原位 rename / 身份键 relPathKey·docJoinKey 单源）成立，case-probe 探测挂选库/切库。MAX_PATH 书名层三入口预算全覆盖。EPERM/EBUSY 退避主链（原子写/移动/软删/回收站/版本/伏笔/迁移/删书）全覆盖。git spawn 数组参数免注入 + windowsHide + quotepath=false 中文路径 + ENOENT 人话 + TERM→KILL 升级。SQLite 双库 WAL + busy_timeout 先序 + 侧车清扫 + 损坏窄判定 + unlink 退避。事件库 trueCasePath 防盘符漂移双库。桌面壳 session-end/SIGBREAK 的 win 退出链、fork env 大小写不敏感清理（R1W-6）、IPC `\0`+resolveWithinRoot 校验、isTrustedSender 白名单。前端 mod-key/IME 让渡/WCO 避让/中英双字体名归一。scripts 无 POSIX 残留（cross-env 统一）。CI win 腿全门禁 + 打包冒烟。

## 四、win 适配成熟度分层结论

| 层 | 成熟度 | 依据 |
|---|---|---|
| fs 基建（主审亲读 11 文件） | **很高** | 原子写族（fsync 策略感知 win 目录 fsync EPERM、link 独占 + 非 NTFS 降级 rename 带退避、崩溃 tmp 清扫带 pid 存活探测）、跨进程锁（O_EXCL 原子性论证、DELETE_PENDING 瞬态重试、stale 接管二次复核 + jitter、续期定时器）、折叠/NFC 单源、大小写探测、长路径冒烟 |
| 文档/服务端 | **高** | 上述已核实安全面 + 历轮 win 专项（R1W/R2W/J 批）落进源码的消毒/分诊/退避；本轮 P2-1 为唯一守卫漏网点 |
| 桌面壳/进程/CI | **高** | 退出链/单实例/env 大小写/字体链/打包门齐备；P2-3 与两条 P3 为边界环境缺口 |
| AI/RAG/前端 | **高** | 键派生/SQLite/导出净化/前端平台面成体系；P2-2 为唯一 join 漏网点 |
| 整体 | **高（9/10 量级）** | 主流 win 陷阱（闪窗/大小写/编码/杀软瞬时锁/env 双键/长路径/保留名/非 NTFS 卷）均在源码层收口且有测试与 CI 门锚定；剩余为折叠纪律漏网点与边界环境回落缺口 |

## 五、完成进度评估

**结论：功能开发全量收口，版本 1.0.0-rc.1，处于发布候选（RC）打磨期。**

- 阶段进度：总览第三节开放任务看板**当前空**——阶段 24（章节结构操作，最后一项）2026-09-13 全三批 A/B/C 实施 + 各批独立 L2 终门收口；此前阶段 1-23 均已收口（已完成阶段行冻结于总览历史明细 §六）。
- 功能面（根 README 流程 × 源码核实）：建书（长篇/短篇集）/设定表单/正文编辑（自动保存 + 版本校验 + 快照留底）/全自动写章（机检打回重试到上限）/三审裁决/定稿（防吃书检查）/导出 + 配套（伏笔全程记录、字数曲线、文风系统、选中改写分析、对话助手）全部在库；31 specs e2e 覆盖主链（本轮 win 实跑 49 过）。
- 平台面：win NSIS x64 与 mac dmg 双平台出包路径落地（electron-builder 配置 + 打包静态门 + CI tag 门 + win unpacked 冒烟）；两平台使用须知（SmartScreen/公证/同步盘/长路径）已在根 README 披露。
- 规模：src 约 481 个 TS/Vue 文件；1122 测试文件 / 7243 用例（win 实跑口径）；文档链（总览/台账/Archive 批记）自洽，check:counts 对账一致。
- 残余开放面（台账 §二/§三 记账口径）：**四项待拍板**（inline 裸标题建章章号盲区 / 树显示序跨卷分组语义 / undo 回收站同章号反查歧义 / export displayNum 单调性，另有 MAX_AGENT_TURNS、switch-provider 决策消费等older待拍板）；按域 A-G 挂账看板以 P3 维持/待择收为主（本轮零 P1 与该状态一致）；《专项精简优化》在库报告归档时点待作者定。

## 六、完成质量评估

**结论：高。工程纪律罕见地严，风险集中在长尾边界。**

- 门禁实测（本轮 win 本机，§二）：静态门全绿；全量动态门在两族**已登记**的 win flake 家族外零真失败；e2e 全绿。
- 测试文化（台账 G 域 2026-09-12 实测登记，本轮引用）：0 快照断言、≈3.09 断言/用例、0 真 `.only`；镜像度经多轮审计。
- 代码质量（本轮亲读印象）：单源纪律贯彻（折叠/消毒/退避/锁/身份键全部单源化并配防回归锚）；fail-closed 倾向全场一致（可篡改数据面 manifest/books.jsonl 设防、IPC \0+防穿越、锁谱系闭环）；注释带批次编号与成因溯源，可追溯性极强。
- 已知弱点（如实）：两族 win 偶发（tinypool 收尾竞态杀汇总 + sleep 时序窗假红）本轮各实测撞到一次——均有登记与 CI 兜底，但「win 全量一次全绿」尚不可稳定复现；注释考古税（台账 H 自登记 ~1.3-1.5k 行冻结候选）；测试巨件 main.test.ts 2731 行；记账同步 IO 等维持项。
- 与历轮对照（仅作记账核对）：本轮 P1×0 与台账「服务端连续两轮零二级发现」「核心域零 P1」的收敛趋势一致；P2×3 均为边界场景漏网点，无系统性架构问题。

## 七、总结论与建议

1. **进度**：功能全量收口、RC 阶段（1.0.0-rc.1），距离 1.0 的剩余面 = 四项待拍板 + 本轮 P2×3 + P3 择收，无结构性缺口。
2. **质量**：高——门全绿（flake 隔离复验后）、win 适配整体成熟度 9/10 量级、零 P1。
3. **建议修复优先序**：P2-1（一行，安全契约面）→ P2-2（一行，换 docJoinKey）→ P2-3（登记或实现回落）；P3 按族择收（折叠族 4 件可一并收口）。上述均不阻塞 RC。
4. 测试面建议沿用既有登记：sleep 时序族换可控闸门终态断言（台账 G 域择收项），本轮 `re2-manifest-lock-reentry-async` 假红即此族。

## 八、修复批处置记（2026-09-13，作者指令「全部修复，开始吧。」主审亲修零代理）

L2 终门九件套亲跑全绿：**vitest 全量 1126 文件 = 7176 过 + 84 跳 0 败（win 口径，一次全绿）** + tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过（counts/packaging/knowledge）+ e2e 49 过 2 跳 + soak 两段 OK。净增 +4 测试文件/+17 用例（全部无平台门，差值锚 79 不变），根 README 修账五处（7238→7255 / 1122→1126 / win 预期链 + 本批实跑实录）。

**P2×3 全修**：
- **P2-1** insideDir（`studio/server/api/style.ts`）先归一反斜杠再切段（`split('/')`→归一后段级 `..` 判定），实际 FS 操作仍走原 rel（posix 字面语义不变）——delete/confirm/ignore 三端点同函数覆盖；回归 = r71-style +2 用例（反斜杠 `..` 段 400 且目录外文件无恙 / ignore 同型）。
- **P2-2** chapterToDocId（`ai/tools/shared.ts`）清单 join 改 docJoinKey（两侧折叠+NFC，want 键外提）——与 export/learn/metrics 消费面同口径；回归 = r0913-docid-join-fold 3 用例（NFD×NFC 全平台 / case-only 按平台分支 / 无登记回落 legacy 不回归）。
- **P2-3** win 字体枚举（`desktop/win-fonts.ts`）补 reg.exe 注册表回落（HKLM/HKCU Fonts 键值名，`parseRegFontsQueryOutput` 纯函数剥注册后缀/(默认)行跳过；reg.exe 不经 PS，不受 CLM/AppLocker/杀软拦 PS 影响；SystemRoot 绝对路径解析同 PS 口径）——PS 失败/空表均触发回落、**PS 首因错误在回落也无结果时保留**（诊断归因不丢）、熔断包裹整体（PS+回落为一个尝试单元）；warn 留痕。回归 = win-fonts 新 describe 3 用例 + 既有 2 用例改按 cmd 分流自动结算假件（原假件只结算首个子进程）。

**P3 逐项（13 修 + 2 维持/备注）**：
- 折叠键族 4 件全修：`cache/sync.ts` 重复章号告警比较收编 samePath / `cache/rebuild.ts` `forgetChapterParseCacheForBook` 前缀收编 platformCaseFold / `fs/md-text-cache.ts` `forgetMdTextCacheForBook` 同款 / `ai/provider/store.ts` 写链键收编 `writeChainKey`（platformCaseFold 单源，仅 Map 键、磁盘路径派生不动，`__seedProvidersWriteChainForTest` 同步折叠）。回归 = r0913-casefold-forget 3 用例（按平台分支断言折叠/不折叠两臂）+ r29 +1 用例（变体寻址共享同链）。
- 退避族 3 件全修：`style.ts:188` 删条目 rmWithRetry（recursive 档）/ `style-migrate.ts` 三处删源 rmWithRetry / `state.ts:366` 孤儿 journal 归档 renameWithRetry——原语级语义由 fs/atomic 既有测试覆盖，接线均为一行换装。
- 边角族 4 件：**P3-8** 章纲同步改名 fallback 补「同物理文件（dev+ino）→ 原位 renameWithRetry 落大小写变体」分支（R2W-1 主路径同判，时间戳双份分支仅真冲突时走；回归 = 既有 r37-piece-list 全绿保底 + 场景需深装置，如实记档）；**P3-9** scanCloudCopies 补资源管理器 ` - Copy.md`/中文 Windows ` - 副本.md` 形态（母本验证同 X-P2-20 收紧；回归 = exec.test +1 用例）；**P3-10** SIGTERM win 事实失效备注级收口（注释记档）；**P3-11** open-book-dir/open-library-dir 的 openPath 结果留痕（.then warn ×2）。
- 环境族 2 件：**P3-12** trueCasePath 失联网络卷同步冻——**维持** + 注记现实防线（memo 512 每路径仅首次真探 + 主进程 probeDirReachable 覆盖 GUI 入口；同步 IO 无超时手段，彻底闭合需 bookHash 全链异步化超维持项范畴）；**P3-13** 单实例提权差异双开——已修：新增 `desktop/app-instance-guard.ts`（userData 下 `app-instance.lock` 文件锁，复用跨进程锁底座：O_EXCL 原子 + pid 跨提权可见 + 60s 续期 + fail-open 放行 + 同进程重获取视为同一实例）；main.ts 在 requestSingleInstanceLock 旁接线。回归 = r0913-app-instance-guard 3 用例。如实记档：will-quit 注册与 main.test.ts 假件环境交互致 worker OOM（二分定位），释放钩子改 `process.once('exit')`（对 Electron 假件零可见；崩溃路径由陈锁接管自愈，语义不变）。
- 预算面 1 件：doCreate 的 ENAMETOOLONG 分诊 BAD_INPUT 人话（客户端可修；`CreateResult` 失败臂放宽 BAD_INPUT，documents.ts structStatus 既有 400 映射直达）；回归 = r0913-win-adapt 1 用例（同深度运行时探测分支断言，长路径开/关宿主均确定）。
- 测试面 2 件维持既有登记：CI win 腿重跑兜底（上游 vitest/tinypool 修复后撤，台账 §三 G 在案）/ win 腿不跑 e2e（D5 拍板，tag 冒烟兜底）——本轮全量首跑即撞两族已登记 win flake（tinypool 收尾竞态 + sleep 时序窗假红），孤立复跑均绿后全量复跑一次全绿，维持登记效力。

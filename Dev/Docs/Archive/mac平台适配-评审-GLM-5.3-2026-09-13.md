# mac 平台适配专项重评——进度与质量

- 日期：2026-09-13（纯评审落盘批，未收口）
- 执行模型：GLM-5.3（主审 = 会话模型）；两波六路只读复核子代理（R1–R6）同会话派发，关键发现主审逐条亲验。
- 评审对象：mac 分支 HEAD `2510a1ec` 工作树（评审期零代码改动）。
- 作者指令：「忽略现有的评审文档，评审一遍项目源代码，本次重点在mac平台适配！最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」
- 方法与独立性：**既有评审文档全部忽略**——未读取任何 `01-评审/` 与 `Archive/` 评审报告正文（进度对账仅读总览/台账索引行）；主审亲读 `src/desktop/main.ts` 全文（2256 行）+ 平台条件文件集中面（`src/fs/user-data-path.ts`、`safe-path.ts`、`install/init.ts`、`events/store.ts`、`git/exec.ts`、前端热键/关系图等）；两波文件互斥只读复核子代理——波 1 四路（R1 desktop+fs+install+log / R2 web-next 前端 / R3 server+process+events+git+cache+state+driver / R4 打包链+脚本+全库 win 假设扫掠），波 2 两路（R5 ai 层 78 文件 / R6 format+document+export+review+learn+knowledge+metrics+check+rag），全程在途 ≤4。P2 与关键 P3 主审亲验成立后收录；其余子代理呈报项标注「代理呈报」。
- 规模底账：src 实际 481 个 TS/Vue 文件 / 112,078 行（不含 node_modules）；test 1175 个 TS 文件（vitest 1122 + e2e 31 spec + helper/soak）；平台条件分支集中 15 个文件（`process.platform`/`darwin` 引用全库 21 处）。

## 一、总判定

**mac 平台适配：主链闭环、成熟度高——P1×0 / P2×1 / P3×14**（另有通用质量顺带发现 3 条，不计 mac 专项）。P2 唯一项为**发布披露缺口**（arm64-only 未在 README 披露），非功能缺陷；P3 全部为受限触发边角（外部建名/异形路径/文案/注释/测试口径漂移）。**完成进度：功能 24/24 阶段全收口、版本 1.0.0-rc.1（发布候选态），综合完成度 ≈98%；mac 适配专项完成度 ≈95%。完成质量：A−（高）**——客观门禁本批 mac 实机亲测全绿，mac 文件系统语义处理成体系（正面证据 §三）。

## 二、mac 适配专项发现明细

### P2-1 mac DMG 仅 arm64，README 未披露（主审亲验）

- 证据链：`electron-builder.yml:34-35` mac.target 仅 `dmg` 未配 arch；CI `desktop.yml:31-33` 注释自记「macos-latest 为 arm64 runner，产物仅 arm64 DMG；Intel mac 无可用产物」；本机 `dist-electron/mac-arm64/` 实证产物形态；`README.md`「macOS 版使用须知」段披露了签名/Gatekeeper、自动更新、大小写敏感卷三项，**无 arm64-only 一项**。
- 影响：Intel Mac 用户下载 DMG 后无法打开且无任何指引——用户面死胡同。CI 注释已声明双 arch 属发行决策「暂记档不代拍」，但**披露缺口本身不依赖该决策**：无论是否恢复 x64，README 都应告知当前包仅适用 Apple Silicon。
- 建议：README「macOS 版使用须知」补一行披露（最小修法）；如决定支持 Intel，改 `mac.target` 为 `[{target: dmg, arch: [arm64, x64]}]` 并跑一次 tag 门（CI 注释既有指引）。

### P3（14 项，按域分组；〔亲验〕= 主审对码成立）

**A. 文件系统 / 安装层**

1. **AppleDouble/点文件过滤缺口**〔亲验〕：`src/install/init.ts:256-271`（countMarkdownFiles）与 `src/install/migrate-layout-v2.ts:165-199`（moveTree）对目录项无 `.`/`._` 前缀过滤——从外置盘/网络卷/zip 拷入的 `._0001-x.md`（AppleDouble）会计入正文数使 `isResumableHalfScaffold` 误判（半成品恢复被拒）、v2 迁移把 `.DS_Store` 搬进新目录且计数虚增。对照正确口径：`src/fs/walk-md.ts:85`（`._` 过滤）与 `migrate-layout-v3.ts:113`（`.` 过滤）已收口，v2/init 漏网。修法：两处补 `name.startsWith('.')` 跳过，与 walk-md/v3 统一。
2. **反斜杠一律按路径分隔归一（win 假设泄漏族）**〔亲验 safe-path 两处〕：`src/fs/safe-path.ts:51`、`:88`（`rel.replace(/\\/g, '/')`）与 `:169-172`（relPathKey）+ 同族 `src/document/service.ts:229/834/852`、`src/document/layout.ts:90`、`src/check/run.ts:162`。POSIX 层 `\` 是合法文件名字符——mac 上外部创建的 `a\b.md` 其 rel/身份键被扭曲为 `a/b.md`，与磁盘名失配（白名单前缀匹配、manifest join、锁键漂移）。`abs` 不受影响故读写不坏；应用自建名经 sanitize 无 `\`，触发需外部建名——受限触发。修法：仅 win32 做归一（与 platformCaseFold 同款单源分支）。
3. **samePath 只折叠大小写、不折叠 Unicode 形态（NFD/NFC）**〔亲验〕：`src/fs/user-data-path.ts:45-49`（`toLowerCase()` 折叠）+ `src/desktop/initial-book.ts:35`（书名 `===` 全等）。mac Finder 重命名惯产 NFD 形态，与 NFC 登记名（init 建书已 NFC 归一但**路径**来源多样）不等且 toLowerCase 无法折叠——同一书库在 recent 劈成两条、`--book` 直达静默失配。`toNfcName`（text-canonical.ts:33-35）原语在库未接入。修法：samePath 折叠前两侧 `normalize('NFC')`；initial-book 书名匹配同收口。中文全角字符 NFC/NFD 无差异，实际影响面窄（拉丁扩展/注音），故 P3。
4. **events/store.ts bookHash 大小写归一不含 darwin**〔亲验〕：`src/events/store.ts:39` 仅 win32 走 trueCasePath；注释自认「mac 折叠语义与卷敏感性脱钩属 R40-23 登记」。mac 默认不敏感 APFS 上同一书库两种大小写写法开出两只事件库（对话史/审计「丢史」假象）。文档身份键侧已由 platformCaseFold（safe-path.ts:159-162，含 darwin）单源覆盖，事件库键口径分叉。触发面窄（books.jsonl 单源 + case-only 改名走 books.ts:717 原位分支 + Finder 手改大小写时 existsSync 仍命中），维持 P3——与既有登记同处置（探测卷敏感性后折叠，避免 blanket 重键存量库）。

**B. 服务端**

5. **git 缺失引导文案 win-only**〔亲验〕：`src/git/exec.ts:130`、`:243` ENOENT 文案「请安装 Git（Windows 推荐 Git for Windows）」无平台分支。mac 上 `/usr/bin/git`（CLT shim）常驻、ENOENT 几乎不可达，但触发时 mac 用户收到 Windows 指引。修法：darwin 分支换「安装 Xcode Command Line Tools（xcode-select --install）」。
6. **书名/目录名按 win 非法字符全集跨平台硬拒**：`src/install/books.ts:72` isInvalidBookName（`[\\/:*?"<>|]` + win 保留名族）全平台生效——mac 上仅 `/` 非法，含 `:`/`?` 的合法 mac 名被误拒。注释明示「跨平台统一拒绝（mac 也拦住，行为一致更简单）」系**有意设计**（win 书库可被 mac 打开的数据面对称约束），非疏漏——列为可披露的产品限制，处置归作者拍板（维持或分层放宽）。

**C. 前端**

7. **⌘F 无全局查找**〔亲验〕：`composables/useHotkeys.ts:30-39` 全局键只挂 s/p；主进程「编辑」菜单（main.ts:1913-1922）无 Find 项；`views/EditorView.vue:185` 右键菜单却宣告 `CmdOrCtrl+F` 加速键——焦点不在编辑器时按 ⌘F 完全无响应，与菜单栏/右键宣告的暗示不符。mac 用户肌肉记忆从「编辑 → 查找」找入口。修法：主菜单编辑组补 Find 转发（或前端全局 ⌘F 调 cmHost.openSearch）。
8. **关系图滚轮缩放未适配 mac 触控板粒度**〔亲验〕：`composables/useRelationGraph.ts:560`（`deltaY > 0 ? 1.15 : 1/1.15` 固定步进）+ `components/relations/RelationGraph.vue:24`（`@wheel.prevent` 全量消费）。mac 触控板双指滚动/捏合是高频小 delta 连续事件流（含动量惯性），一次轻扫数十事件 × 1.15 倍瞬间撞 `W*0.2 ~ W*4` 钳制边界；`ctrlKey`（捏合手势标志）与普通滚动不分。修法：`Math.exp(-evt.deltaY * 0.002)` 幅值归一 + ctrlKey 分流。

**D. 打包 / CI / 测试**

9. **mac 缺 artifactName**：`electron-builder.yml:61` win 配 `${productName}-${version}-${arch}.${ext}`、mac 未配（走默认名无 arch 段）。单 arch 无歧义；恢复双 arch 时两个 dmg 同名相撞。修法：mac 同步显式配置（代理呈报，主审对 yml 亲验 win 有 mac 无成立）。
10. **r0911 字体路径测试与真实打包形态漂移**（代理呈报）：`test/desktop/r0911-font-binary-path.test.ts:25-27` 打包态用例构造 `app.asar/desktop`，真实形态 `app.asar/dist/desktop`；`darwinFontListCommand`（font-cache.ts:323-329）做段级替换功能正确、测试通过，但实现日后收紧为精确匹配时此测试拦不住。修法：用例补 `dist/` 段对齐。
11. **mac 打包态关窗链无自动化覆盖**（代理呈报）：`electron-smoke.mjs:48-59` 的 `CLW_SMOKE_APP_BIN` 打包态注入无任何 workflow 消费；mac 打包态冒烟（desktop.yml 内联 ready/存活/renderer-crash 三判）不含 window-cycle（建窗→关窗退出链），后者只在 ubuntu dev 态覆盖。修法：mac 腿补一步 `CLW_SMOKE_APP_BIN=<.app 二进制> npm run smoke:electron`。

**E. 格式 / 文档 / 导出**

12. **「折叠面」注释漂移族**（代理呈报）：`export/index.ts:309-310`「posix 恒等」、`document/manifest.ts:345`、`check/run.ts:153` 等「win32 折叠」注释与实际（platformCaseFold 自 R45-2 起 darwin 也折叠）不符——行为正确，注释误导后人。修法：批量勘误。
13. **platformCaseFold 按 platform 判定、无法感知卷级大小写敏感性**（代理呈报）：书库放 case-sensitive APFS/外置盘时 `1-A.md` 与 `1-a.md` 两真实文件折叠同键（manifest/树 join 混叠）。README 已披露敏感卷风险（选库时也有探测警告），此为代码面残余边角——建议折叠键外保留精确键双查或文档标注，归入卷敏感性既有议题。
14. **导出文件名长度上限论据错误**（代理呈报）：`export/index.ts:203` 称「APFS 按码位判」——APFS 实为 255 UTF-8 字节上限。当前字节封顶（203B+52B tmp=255B）恰好安全，论据错；未来按码点放宽预算会踩坑。修法：勘误注释。

### 通用质量顺带发现（不计 mac 专项）

- `src/ai/provider/store.ts:380/405` 路径手拼 `'/'` 与同文件 `join()` 并存（风格统一项）。
- `src/ai/rule-hits.ts:96-98` 旁路统计 catch 空吞无留痕（对齐同仓旁路 log.warn 惯例）。
- `src/export/index.ts:233-235` archiveOldExport catch 丢 `e`，mac 上归档失败（Finder/Time Machine 占用）无 errno 线索。

### 查证销案（要点）

- `win-fonts.ts` powershell/chcp 命中：win32 守卫双保险（main.ts:1675 平台门 + win-fonts.ts:97 内部 throw），mac 零执行。
- `APPDATA` 读取：user-data-path.ts:27-29 在 win32 分支内；darwin 走 `~/Library/Application Support/CLWriting` 与 Electron 默认同源。
- 全库 `C:\`、`%USERPROFILE%`、`wmic`、`reg.exe`、`ComSpec`、`ntfs` 命中均为 node_modules 第三方或文档文本，非代码面。
- asarUnpack/fontlist 四环链（tsup 拷贝 universal 二进制 → 显式 `dist/desktop/fontlist` → asar→asar.unpacked 段级改写 → system_profiler 三层回落）实包核验全通（含执行位穿透）。
- hardenedRuntime/notarization 缺席：ad-hoc 链路下无意义；README 已披露 Gatekeeper/右键打开/`xattr -cr` 指引。
- `resolveWithinRoot` 大小写不敏感卷绕过：存在时双侧 realpath 归一 + 不存在时最近祖先 + suffix lstat 防 symlink，词法+物理两道闭合，未发现绕过。
- ExportDialog「platform」= 业务发布平台枚举（番茄等），非 OS 平台。
- 前端无硬编码 ⌘/Ctrl 泄漏（mod-key 单源）、无自绘窗控、无 window.open 外链面、无 CRLF 展示泄漏。

## 三、mac 适配正面证据（质量支撑，六路合计 30+ 条精选）

1. **平台三态单源体系**：`usePlatform.ts:27-34`（mac 红绿灯左上避让 / win WCO 右上 env 避让三态）、`shared/mod-key.ts`（⌘/⇧ 文案单源）、`safe-path.ts:159-162` platformCaseFold（win32∪darwin 折叠单源，九处消费）——平台分支不散落。
2. **主进程 darwin 全套**：hiddenInset 标题栏（main.ts:839）、mac 应用菜单（about/services/hide/hideOthers/unhide/quit/偏好 ⌘,，main.ts:1871-1887）、`role:'zoom'` mac 专属（:1952）、`role:'close'` vs quit 分流（:1909）、dock activate 重建窗口 + 重入防护（:2246 / Y-P2-7）、darwin `app.focus({steal:true})` 双开置前（:268）、GPU 光栅关闭 win-only 门（:72）。
3. **字体链 darwin 闭环**：fontlist universal 二进制随包（tsup darwin 腿拷贝、ENOENT 红构建）→ asarUnpack 显式命中（实包核验）→ `darwinFontListCommand` 段级改写防 `app.asar.bak` 误替换 → 超时必杀 + 会话熔断 → font-list 回落 → system_profiler 终回落；`check-packaging.mjs` 有防回潮门（旧裸模式判红）。
4. **mac 文件系统语义成体系**：AppleDouble `._` 过滤遍布扫描面（walk-md/version/style-entry/iron-rules/leads/foreshadow）；NFC 归一（toNfcName/docJoinKey/建书名 + 存量 v4 迁移改名归一）；大小写折叠覆盖 darwin + case-only 改名专门分支（不 renameSync、全量照迁）+ dev+ino 物理身份判重（防《Foo》/《foo》互覆）；case-probe 卷敏感性探测 + 选库警告 fail-open；跨卷降级（exFAT/FAT/SMB 硬链接 EPERM→rename 带退避）；POSIX 目录 fsync 平台分诊；`/var→/private/var` realpath 感知。
5. **IME 中文输入深度处理**：`shared/ime.ts` 单源（isComposing/keyCode 229）全覆盖命令面板/导出/右键菜单/建书/搜索/聊天；CmHost 组合期双判挂起外部全量替换与切章、compositionend 延迟一拍——中文写作核心体验在 mac 输入法下不丢字。
6. **红绿灯安全区正确**：Ribbon 顶部 drag 带、SidebarLeft 52px 避让、TabBar 左栏隐藏时 lead 右移，按钮显式 no-drag；专注模式 28px 拖拽条兜底。
7. **服务端跨平台纪律**：仅回环监听 + Host 白名单 + port 0 随机；git 全走 spawn 数组形式（零 shell 注入面）+ `-c core.quotepath=false` 保中文路径 + SIGTERM→SIGKILL 升级；pid 锁 `process.kill(pid,0)` EPERM 保守判活 + 注释记档 mac App Nap/SIGSTOP 深睡取舍；CRLF/BOM 规范形全写点收口 + 读侧 GBK/Big5 探测告警。
8. **原子写与崩溃安全**：同目录 tmp+rename（mac 同卷原子语义）+ POSIX fsync + EPERM/EBUSY 退避；tmp `.` 前缀落盘（Finder 隐藏崩溃残留）；token 文件 mode 0600。
9. **userData 大小写统一**（dev clwriting vs 打包 CLWriting 在 Linux 分裂防线，mac 上亦同源确定）+ 多显示器 workArea 校验恢复。
10. **测试工程 mac 面**：vitest exclude `**/._*` 防 AppleDouble 误收；e2e/mac 打包态冒烟在 CI mac 腿真实跑（chromium 缓存按 macOS 实际位配置）。

## 四、完成进度评估

- **功能维度：24/24 阶段全收口（100%）**。总览第三节开放任务看板空（阶段 24 章节结构操作 2026-09-13 全三批 A/B/C 收口），「五、决策状态表」真开放待拍板：无；核心写作全链（建书→设定→正文→AI 连写→机检→三审→定稿防吃书→导出）+ 结构操作（合并/拆分/回收站/撤销）+ 版本快照 + 伏笔追踪 + 文风系统 + RAG + 用量记账 + 对话助手全部实装。
- **版本与发布态：1.0.0-rc.1（发布候选）**。mac（dmg arm64）+ win（nsis x64）双平台出包链就绪；linux 暂缓（既有决策）。发布前已知开口 = arm64 披露（本批 P2-1）+ 正式签名/公证（待作者购证，ad-hoc 现状已披露）+ 无自动更新（已披露，覆盖安装指引在库）。
- **mac 适配专项：≈95%**。五层主链（主进程壳 / 文件系统语义 / 前端交互 / 服务端 / 打包 CI）全部闭环且有实包核验；剩余 = 1 项披露缺口（P2）+ 14 项受限触发边角（P3）。
- **挂账面**：台账 §三 代码挂账看板在册 ≈175 行（A-H 八域，已处置回填与维持/单立/待办混合）；真待拍板 3 项（inline 章号盲区 / 树显示序跨卷分组 / undo 回收站反查歧义）。`01-评审/` 暂存《专项精简优化》收口条件已满足、归档时点待作者定。
- **开发纵深**：mac 分支 853 commits；文档链（总览/台账/Archive 批记/冻结件）完整可考。

## 五、完成质量评估

**评级：A−（高）**。依据：

1. **客观门禁本批 mac 实机亲测全绿**：vitest 全量 **1122 文件 = 7238 过 + 5 跳 0 败**（184.93s）+ tsc/vue-tsc 0 错 + eslint `--max-warnings 0` 0 警 + 三 check 全过（counts 实测与 README 声称逐位对账一致；packaging；knowledge 13 条）+ Playwright e2e **49 过 + 2 跳（40.2s，31 specs）**。coverage 本批未复跑（最近 L2 记档 91.71/87.27/96.23/91.71，CI 三腿矩阵 + 阈值门兜底；soak/出包同 HEAD 前批已绿，如实记档）。
2. **mac 适配工艺成熟度显著高于常规 Electron 项目**：平台分支单源化、mac 文件系统语义（NFC/AppleDouble/大小写折叠/跨卷降级/物理身份）成体系、IME 组合守卫全覆盖、字体链四环闭环实包可考——§三正面清单 30+ 条均有代码锚点。
3. **缺陷结构健康**：零 P1；唯一 P2 是披露缺口而非功能/数据/安全缺陷；P3 全部受限触发（外部建名/异形路径/文案/注释），无一条触及核心写作链路的数据正确性。
4. **可维护性**：注释纪律极强（每处平台分支/修复带轮次编号 + 动机留痕）；测试资产 7238 单测 + 51 e2e 用例，测试:代码比 ≈7:1（用例:行）；静态检查零债。
5. **扣分项**：发布披露完整性（P2-1）；台账 175 行登记债的长尾消化；三处测试/注释口径漂移（P3-10/12/14）显示「文档/测试与实现同步」在快节奏合并下偶有滞后。

## 六、处置建议（待作者指令，本报告不代拍）

- **P2-1 一行修**：README「macOS 版使用须知」补 arm64-only 披露（纯文档 L0）；双 arch 与否属发行决策维持 CI 注记口径。
- **建议随下批择收（均为小改）**：P3-1（两处点前缀过滤）、P3-5（git 文案平台分支）、P3-7（菜单/全局 ⌘F）、P3-8（关系图 wheel 归一）、P3-12（注释勘误族）、P3-14（APFS 论据勘误）。
- **建议登记台账 §三 备查**：P3-2（反斜杠归一族）、P3-3（samePath NFC）、P3-4（bookHash darwin——与既有 R40-23 登记同议题）、P3-13（卷级敏感性感知——并入敏感卷既有议题）。
- **待作者拍板**：P3-6（mac 合法书名字符是否分层放宽 vs 维持跨平台对称拒绝）。
- **测试工程**：P3-10（用例补 dist/ 段）、P3-11（mac 打包态 window-cycle 冒烟接线）建议随下批 CI 面改动顺手。

## 七、门禁实测记录（本批，mac 实机）

| 门 | 结果 |
|---|---|
| `npm test`（vitest 全量） | 1122 文件 = 7238 过 + 5 跳 0 败（184.93s） |
| `npm run typecheck` / `typecheck:web-next` | tsc 0 错 / vue-tsc 0 错 |
| `npm run lint` | eslint 0 错 0 警（--max-warnings 0） |
| `check:counts` | 过——1122/7238 与 README 声称一致；31 e2e spec / 51 用例 |
| `check:packaging` / `check:knowledge` | 过 / 过（13 条 manifest 对账一致） |
| `npm run test:e2e` | 49 过 + 2 跳（40.2s，chromium） |
| coverage / soak / 出包 | 本批未复跑（正本最近 L2 记档 + CI 兜底，如实记档） |

## 八、收口记（2026-09-14 mac 适配修复批）

收口批随作者指令「全部修复，并发做。」落（2026-09-14，主审 = GLM-5.3 会话模型亲修收尾，零 git 提交、工作树留作者）。判定 **P2×1 + P3×14 全处置**：修 P2×1 + P3×11；P3-6 行为维持 + 文案披露单源；P3-4 / P3-13 维持登记台账 §三 E 域（前者 = 在册 E-P3-1 bookHash 行重证扩注，后者新立行）。

**编排**：波 1 四路文件互斥修复代理（在途 ≤4）——A = fs+install+git+document 面（safe-path / user-data-path / initial-book / init / migrate-layout-v2 / books 常量 / git exec / document 三件 + check-run）；B = desktop+前端面（菜单查找链 / useAppActions / useHotkeys / EditorView / useRelationGraph）；C = 打包+README+CI 面（electron-builder.yml / 根 README 披露 / desktop.yml 冒烟步 / r0911 字体测试）；D = ai+export 面（provider store join 化 / rule-hits 留痕 / export 注释与 warning 留痕）。主审核验后亲修 8 处/5 文件同族收尾：`server/api/books.ts` ×2（书名拒绝文案收编 `BOOK_NAME_INVALID_REASON`）+ `state/state.ts:908` + `process/book-search.ts` :97/:218 + `server/api/files.ts:329`（四处收编 `normalizeWinSeparators`）+ `ai/provider/store.ts` :134/:152（路径拼接 join 化）。代理阵亡/回退：无（四路完整回收）。

**修复面摘要**：P2-1 = 根 README「macOS 版使用须知」补 Apple Silicon 专行披露；P3-1 = init/migrate-layout-v2 循环头 `.` 前缀跳过（AppleDouble/.DS_Store）；P3-2 = `safe-path.ts` 新单源 `normalizeWinSeparators`（win32-only 收窄，posix 字面 `\` 名保持身份）+ 同族 8 处收编（resolveWithinRoot 双支 / relPathKey / state relativePath / book-search 双版 / files 布线锁前缀门 / check-run :162/:666）+ document 三件注释记正；P3-3 = `samePath` darwin 臂 NFC 折叠（win32 保持大小写折叠、linux 严格）；P3-5 = `git/exec.ts` `gitMissingHint()` 分平台安装提示（darwin xcode-select --install / linux 三族包管理 / win 原文案）；P3-6 = `install/books.ts` 新 `BOOK_NAME_INVALID_REASON` 跨平台披露文案，拒绝行为三处（install + server books ×2）收编单源、行为零变化；P3-7 = ⌘F 全局查找链（main.ts 编辑菜单「查找…」→ useAppActions `APP_FIND_EVENT` → useHotkeys f 键（既有 IME/defaultPrevented 守卫之下）→ EditorView `openSearch` 监听）；P3-8 = `wheelScale(deltaY) = exp(−Δ·0.002)` 触控板缩放平滑化（钳制不变）；P3-9 = `electron-builder.yml` mac `artifactName` 显式 `${arch}`；P3-10 = r0911 字体测试 3→4（真实打包形态 app.asar + 深度无关）；P3-11 = CI desktop.yml 新 mac「打包态 .app 关窗链冒烟」步（glob + `test -x` 守卫防 dev 回落 + `CLW_SMOKE_APP_BIN` 注入）；P3-14 = export 注释两处记正（APFS 255 字节 / posix 恒等）+ `archiveOldExport`/`rule-hits` catch 改 warn 留痕。P3-4/P3-13 维持理由 = blanket bookHash 重键翻面风险与卷级敏感性重设计均超边角修复体量，登记备查待专项。

**L2 终门（亲跑全绿，如实记档）**：vitest 全量 **1123 文件 = 7261 过 + 7 跳 0 败**（首轮链内绿 + 补跑实录 184.20s；净增 1 文件/25 用例声明 = A8+B16+C1，mac 过 +23〔r71 旧 win 形态 2 例转 `skipIf(!win32)` 入 mac 跳〕，win 门 +3〔safe-path 字面反斜杠 1 + r71 posix 形态 2〕）+ tsc/vue-tsc 0 错 + eslint 0/0（--max-warnings 0）+ 三 check 过（check:counts 修账后复跑过）+ e2e 49 过 2 跳（43.0s）。根 README 修账五处（徽章 / npm test 行 / 门槛行 1123/7261 / 「实测差 80 恒定」+ win 预期 1123 文件 = 7181 过 + 87 跳〔锚 79→80〕/ 技术栈行）。coverage / soak / 出包本批未复跑（上批 L2 记档 + CI 兜底，如实记档）。文档链：台账 §一 收口改写（原行冻结 `Archive/台账历史明细-归档-2026-09-08.md` §十五）+ 总览 §1.3 收口改写（原行冻结 `Archive/总览历史明细-归档-2026-09-08.md` §十五）+ 台账 §三 B/E 域登记三行 + 本报告归档移位（01-评审 2→1 / Archive 29→30 篇）。

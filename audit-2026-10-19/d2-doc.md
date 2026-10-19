# 域2 审计报告：文档模型 / 格式 / 导入导出 / 文件与版本

- 审计日：2026-10-19；范围：`src/document`（28 档）、`src/format`（29 档）、`src/export`（10 档）、`src/fs`（16 档）、`src/git`（2 档），对照测试 `test/document`（93 档）、`test/format`（71 档）等
- 证据口径：只采源码/测试/提交记录；`docs/`、`知识层/`、`.agents/notes/`、`README.md` 未作为结论依据；所有引用为 `file:line`，均可复核
- 深挖优先级：用户书稿数据破坏面（写路径 / 合并 / 快照 / 导出）＞ 路径安全 > 编码与行尾 > 完成度与简洁度
- 未做全量测试与 coverage（遵守预算与内存纪律），未修改任何源码/配置/测试

## 结论摘要

1. **本域写路径的工程水准显著高于仓外平均值**：原子写（tmp + fsync + rename + 目录 fsync）为默认档、快照留底 fail-open 而不吞正文、跨进程锁（`open 'wx'` + stale 接管改名认领）覆盖「校验→落盘」窗口、清单/回收站 RMW 全部走 strict 读防「空表重写整文件」。P0 = 0。
2. 深挖出的缺陷集中在**「非规范形盘面」与「读侧路径校验不对称」**两类边缘态：外部工具/同步盘写入的 CRLF/尾随空白档案、外部改名的 `.版本` 文件名、跨卷重号章。日常路径（应用自身写过一次的文件）不受影响——这解释了它们为何长期未爆。
3. 交付完整度：域内 5 个模块群均为「完成」或「完成（有意简化档）」，**未发现桩实现、未发现半成品导出链**；导出侧 `try/catch` 吞错仅 1 处（`src/export/layout.ts:104`，且同链另有产物存在性守卫）。
4. 最大完成度缺口不是功能，而是**验证面**：字节档读（`readVersionRaw`）的行尾/元数据边界无测试，域内「记录式测试」极多——它们无法替代独立验证。

---

## A. 问题清单

| ID | 严重度 | 类型 | 证据（file:line） | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| A-1 | P2 | 数据完整性（跨卷重号章静默覆盖） | `src/document/draft-path.ts:42-49`（`chapters.find(c => c.章号 === chapter)` 取遍历序首个 → `exists:true`）；`src/document/service.ts:363-368`（基线相符即 `atomicWriteFile` 覆写）；同族风险被 `src/document/structure-merge.ts:133`（跨卷重号章拒合）、`src/document/draft-path.ts:50-67`（同章号坏 fm 拒写保护）显式承认 | 书内两卷共存「章号 N」（外部工具/坏 fm 副本/人工搬运制造）时，`resolveDraftPath` 命中首个不同路径的文件，AI 续写/连写按 `expectedRevision` 通过后**原子覆写错误的章**；被覆内容仅存于快照，作者视角是「另一章的正文被替换」 | 命中同章号多文件时 fail-loud（对齐 `structure-merge` 的 `chapterNoMismatchFailure` 与 draft-path 对坏 fm 的拒写口径），或在返回结构里带 `ambiguous:true` 交由上层确认 | 高（代码路径确定；触发需跨卷重号盘面） |
| A-2 | P2 | 读侧路径校验不对称（防御纵深） | `src/document/version.ts:578-609`（`listVersionEntries` 消费 `readVersionMeta`/`readVersion`）→ `src/document/version.ts:409`（id = 文件名剥 .md，**无校验**）→ `src/document/version.ts:476`（`findVersionFile`）→ `src/document/version.ts:74`（`join(dir, id + '.md')`）；对照 `src/document/version.ts:448`、`:559`（`readVersion`/`readVersionRaw` 均有 ULID 白名单）与 `:712`（prune 直接 `rmWithRetry(s.path)`） | `.版本/<docId>/` 是可被外部/同步盘/恶意脚本写入的盘面；外部放一个 `x/../../y.md` 形态的文件名（win 上非法、mac/linux 合法）即让版本列表/元数据读定位到目录外路径（读到书内他处 md，或读失败静默跳过）。当前无删除面被利用，故非破坏性，但同类入口已显式设防、此入口漏 | 在 `listVersions`（`version.ts:404-414`）对剥出的 id 加与 `readVersion` 同款白名单过滤，把校验前移到唯一的列表派生点 | 中高（路径构造可静态确证；实际可利用性受 `.版本` 目录写入权限约束） |
| A-3 | P3 | 元数据解析漂移（违规档） | `src/document/version.ts:553-572`（`readVersionRaw`：fm 头按 `\n` 切、只做 utf-8 解码，`splitVersionFileBytes` `:521-542`，BOM 剥离 `:523`）＋ `src/format/frontmatter.ts:194`（`parseFlat` 对首行/末行 `\r` 不剥，仅 `trim()`）＋ `src/document/version.ts:429-435`（`metaFromMap` 严格查 `'来源'` 等键） | 外部编辑器/同步盘把快照文件写成 CRLF 时：**首行** `---^M` 使 `fmRaw` 首键带 `\r`（`版本ID\r`）→ 首键静默丢失；**末行** 使值带尾 `\r`（`来源 = 'manual\r'`）。前者令 `来源` 丢失，后者令 origin 值带尾符 → `pruneVersions` 的 pinned 判定（`:665-670`）与按 origin 分域的去重/节流（`:245`、`:273`、`:323`）在违规档上与真实语义不一致，历史面板 origin/原因显示失真 | `parseFlat` 统一剥行尾 `\r`（与 `src/format/frontmatter.ts:564`、`src/shared/frontmatter-core.ts:60` 已采用的「容忍 \r 尾」口径对齐），或 `metaFromMap` 取值前 `trim()` | 中（漂移机理确定；触发需 CRLF 档案，属外部改写入） |
| A-4 | P3 | 跨平台/容错一致性 | 写侧恒 LF：`src/format/frontmatter.ts:420-428`（`joinFrontMatter` 走 `canonicalizeText`）、`src/fs/text-canonical.ts:17-19`、`src/document/version.ts:354-358`；但 `canonicalize` 仅「剥 BOM + 归一 LF」，**不剥行尾空白**（`src/fs/text-canonical.ts:17`），读侧却容忍 `--- ` 尾随空白（`src/shared/frontmatter-core.ts:60`、`:68`；字节层 `src/document/version.ts:505-511`） | 「读侧容忍 / 写侧规范」单向：档案仅在**外部写入且未过 canonicalize**（手工放置、同步盘带入）时保留非规范形；此时表 A-3 的 CRLF 元数据漂移可复现，而起始 fence 的尾随空白已被测试覆盖（见 D-2），故本条仅指行尾差异 | 把行尾容忍收口到读侧解析原语（`parseFlat`/`splitFrontMatter` 各自归一），或在 `.版本` 目录扫描时显式记录「非规范形档案」告警 | 中 |
| A-5 | P3 | 锁粒度/退化窗口 | `src/document/journal.ts:243-265`（`appendLineAsync`：锁超时重试一档后**降级裸写** `appendFileSync`）；`src/document/journal.ts:334-369`（`maybeCompactJournal` 同锁 + stat 双保险）；同文件 `:236-241` 自记「降级行可能落在被 compact 换下的旧 inode → findUnsettled 永不报」 | 极端争用（双进程 + 突发）下丢一条**崩溃检测**行（非正文副本——`:17-24` 已把 pending 收窄为纯元数据）；后果是少一次进门恢复提示 | 保持现状可接受；若要闭合，把降级裸写改为「带 inode 复核的追加」或引入 lease/fencing（同 `src/fs/cross-process-lock.ts:22-23` 自记的残余面） | 高（实现即如此，注释亦自认） |
| A-6 | P3 | 清理误删风险（低概率） | `src/fs/atomic.ts:428-495`（`sweepAbandonedTmpFiles`：对 `.*.tmp` 形态按「年龄门 + pid 存活」删）；`:481-487`（pid 解析失败即只靠 5 分钟年龄门）；`test` 未覆盖「长写 > 5 分钟且 pid 不可解析」形态 | 若某进程在途写的大产物 tmp 恰好命名匹配 `ABANDONED_TMP_RE` 且 pid 段不可解析、超过 5 分钟，可能被另一进程清扫 → 该次写入 rename 失败（不产生半截目标文件，作者可重试） | 现状有 `SWEEP_SKIP_DIRS` 与 pid 守卫兜底，建议仅补一条测试钉死「pid 不可解析 + 超龄」行为的预期 | 中 |
| A-7 | P3 | 不可逆操作的可观测性 | `src/document/trash.ts:568-616`（`purgeTrash` 递归删版本目录/分析信封/journal，失败即 `WRITE_ERROR`）；`src/document/trash.ts:617-633`（条目写回 best-effort，失败静默） | purge 不可逆动作本身有保护（`.trash/` 前缀校验、`safeDocId`、`rmWithRetry` 上抛），但**条目写回失败零留痕**（裸 `catch {}`，`src/document/trash.ts:630-632`），与同文件其它失败点均 `log.warn` 的口径不一致 | 补 `log.warn`（口径对齐 `src/document/trash.ts:507-512`） | 高 |

不列为本域缺陷但值得记档的**已设防面**（避免其他域误判）：非 UTF-8 覆写防线（`src/document/service.ts:379-381`、`src/document/service-meta.ts:129`、`:371`、`src/export/collect.ts:122-127`）、新建路径独占创建（`src/fs/atomic.ts:298-321`、`src/document/service.ts:509-521`）、回收站复活守卫（`src/document/service.ts:264-287`、`:314-323`）、`.trash` 前缀规范化校验（`src/document/trash.ts:360-371`、`:558-567`）、symlink 越出（`src/fs/safe-path.ts:35-90`）、快照留底 fail-open 不吞正文（`src/document/service.ts:463-481`）。

---

## B. 实现完成度（按模块）

| 模块 | 状态 | 证据与说明 |
|---|---|---|
| `src/document/service.ts` 保存协议 | 完成 | 全链齐备：出队守卫 → 跨进程 save 锁 → 锁内复核 → 单读基线判读（revision + UTF-8 闸）→ journal pending → 快照 → 原子写/独占创建 → 新 revision → 条件清单刷新 → settled → 字数记账（`:232-584`、`:586-654`）。失败态各自收口，注释逐段声明「为何回 WRITE_ERROR / 为何 fail-open」 |
| `src/document/structure-merge.ts` 合并/撤销 | 完成 | 干跑指纹（`:260-263`）→ apply 三种崩溃形态分流（`:214-257`）→ 收尾段 `finishMerge` 幂等（`:306-397`）；撤销三级定位（事件 → 正文盘面 → 回收站，`:798-814`）＋半完成态三重核对（`:672-700`）＋「找不到留底即拒」（`:830-835`）。事件载荷逐字段校验（`:481-500`） |
| `src/document/version.ts` 版本档案 | 完成（含 1 处校验缺口 A-2） | 去重/节流/分层保留三件套齐（`:248-337`、`:631-735`）；pinned 与「meta 不可读同 pinned 保护」（`:660-670`）；字节档写读对称（`:553-572`）；目录迁移幂等（`:745-764`） |
| `src/document/trash.ts` 回收站 | 完成 | 软删/还原（link 独占落位 + 内容比对续跑，`:393-451`）/永久删（`:540-634`）齐备；strict 读防「空表重写」（`:162-184`）；死书写回复评（`:334-340`） |
| `src/document/journal.ts` | 完成（有意简化档） | pending 收窄为元数据（`:17-26` 记明「内容副本交前端 dirty 镜像 + 版本历史」）；compact 有锁 + stat 双保险（`:334-369`）；读侧容错跳过非法行（`:158-209`） |
| `src/fs/atomic.ts` | 完成 | 默认 fsync、EPERM/EBUSY 退避单源（`:83-126`）、独占创建 + 非 NTFS 降级（`:338-351`）、崩溃 tmp 清扫含陈锁分支（`:428-495`） |
| `src/fs/safe-path.ts` | 完成 | 越段判定双分隔符（`:33`）、双侧 realpath（`:41-53`）、目标不存在走最近存在祖先 + 后缀 lstat（`:59-89`）、win/darwin 折叠单源（`:175-178`） |
| `src/format/frontmatter.ts` / `yaml-spec.ts` / `yaml.ts` | 完成 | 平铺 YAML 受限子集实现完整（块标量含 chomping 变体、引号状态机、转义往返、全角冒号双认）；`book.yaml` 三面单源 schema 表（`src/format/yaml-spec.ts:219-775`），键清单与 patch 白名单同源派生 |
| `src/export/*` | 完成 | 收集（meta-only，防 OOM，`src/export/collect.ts:23-51`）→ 定稿过滤（`finalizedPathSet` 单源 + `docJoinKey` 折叠，`:66-87`）→ 编号不变量（`:100-105`）→ 写出（非 UTF-8 章跳过并告警，`:110-141`）。错误吞没极少（`src/export/layout.ts:104` 单处） |
| `src/git/*` | 完成（窄面） | `src/git/exec.ts` 承担子进程调用；本域版本系统已去 git（`src/document/version.ts:2` 头注），git 仅余 AI 轨迹旁路（`src/git/ai-track.ts`），与审计口径一致 |

**缺口**：未见桩/`TODO`/未实现分支；未见「导出产物缺口守卫缺失」类问题（`publish` 裁定见 `src/fs/atomic.ts:238-284`）。

---

## C. 简洁与优雅度

1. **超长函数**（域内热点，均可切）：
   - `src/document/service.ts:388-584` `applySaveLocked` ≈197 行，内含 journal/快照/写盘/清单/settled/记账 6 段，段落边界已有注释可作切分点。
   - `src/document/structure-merge.ts:194-301` `applyChapterMerge` ≈108 行 + 三段崩溃分流分支内联；`:764-857` `undoChapterMerge` ≈94 行。
   - `src/format/yaml-spec.ts:676-712` `rag` 段 `parseCustom` 为段级自管例外（表驱动的唯一破例），键序/触发条件写在函数体内，是「三面单源」表的唯一缝隙。
2. **重复实现（已大量收编，残余可查）**：
   - 已单源：越段判定 `ESCAPE_SEGMENT_RE`（`src/fs/safe-path.ts:33`）、win 折叠 `platformCaseFold`（`:175`）、分隔符归一 `normalizeWinSeparators`（`:153`）、退避循环 `retryOnTransientFsError`（`src/fs/atomic.ts:83`）、fm 切分（`src/shared/frontmatter-core.ts:34`）、块标量渲染（`src/format/frontmatter.ts:329-337`）。
   - 残余：frontmatter 行尾 `\r` 剥除在 3 处各自实现（`src/format/frontmatter.ts:244`、`:564`、`src/shared/frontmatter-core.ts:60`），`parseFlat` 未纳入同一收口——这正是 A-3 的结构成因。
3. **深嵌套**：`src/document/version.ts:312-337`（去重循环内嵌 origin 过滤 + 缓存存活校验）、`src/document/structure-merge.ts:354-376`（纲随迁三级 if）建议提为具名判定函数；可读性尚可但认知负荷偏高。
4. **命名**：中英混排键名（`并入`/`章号`/`_raw`）贯穿读写链，属领域词汇而非随性命名；`src/format/manifest.ts` 与 `src/document/manifest.ts` 同名不同物已在头注显式警示（`src/document/manifest.ts:9-11`），保留合理。
5. **魔法值**：多数已具名（`STALE_GRACE_MS`/`MAX_HELD_MS`/`SELF_TMP_MIN_AGE_MS`/`BACKOFF_TRACE_MIN_MS`/`JOURNAL_COMPACT_BYTES`）。仍为字面量且散落者：版本保留三值（`src/document/version.ts:119-123` 已集中）、`src/document/version.ts:484` 的 `65_536` 头部窗口、`src/format/frontmatter.ts:486` 的 `8 * 1024`——建议并入同族常量表。
6. **注释卫生（本域最大的表面积）**：注释承载了大量「为什么 + 历史缺陷编号」，对审计极友好，但 **`src/**` 内注释与代码行数已接近 1:1**（例：`src/fs/atomic.ts` 534 行中说明性注释约 300 行；`src/document/service-meta.ts` 446 行中头注/段注约 200 行）。信息密度高但含大量已结案的历史叙述（「原实现…」「此前…」），属按项目注释纪律应落 git 的内容，建议分批压缩为「当前不变量」一句。

---

## D. 无法判断项及原因

- **D-1 API 层入参是否可被绕过**：`src/studio/server/api/**` 不在本域靶点内，`docId`/`versionId`/`path` 的调用方校验无法在本域闭合判定（例：A-2 的可利用性取决于端点是否另有白名单）。**原因**：跨域边界。
- **D-2 行尾/元数据漂移的实际发生率**：A-3/A-4 的触发需「档案由外部写入且未过 canonicalize」。**反证已完成的部分**：fence 尾随空白容忍**已被测试覆盖**（`test/document/version-raw-bytes.test.ts:94-105` 手工重写 `--- \n…---\t\r\n` 并断言字节层与文本侧同判有效），故该形态**不是**缺陷；但表 A-3 的 CRLF/首键漂移**无对应测试**（同文件 `:59-77` 的「CRLF」用例只把 `\r\n` 放在**正文**中）。**原因**：无用户档案样本，无法给出发生率。
- **D-3 真实书库的盘面形态**：跨卷重号章（A-1）、`.版本` 目录内外部文件（A-2）等触发前提是否存在，需实机抽样。**原因**：审计只读代码。
- **D-4 前端 dirty 镜像的兜底强度**：journal 已把未保存内容副本职责外移给前端镜像（`src/document/journal.ts:17-24` 记明），但 `web-next` 侧实现不在本域靶点内，无法验证其时效门与崩溃窗。**原因**：跨域。
- **D-5 `.版本` 目录被同步盘/备份工具改写的概率**：A-2/A-3 的现实触发条件。**原因**：环境相关。
- **D-6 提交记录中的「反复修复热点」定量结论**：`git log` 已抽取本域近 300 条（见 `src/document`、`src/format`、`src/fs` 相关条目），可见 30+ 轮系统性修复批次（如 `59fd4a4f`、`c7872982`、`845a22fd`、`db8274fb`）反复落在**同一批文件**：`document/service.ts`、`document/version.ts`、`document/trash.ts`、`fs/atomic.ts`、`format/frontmatter.ts`——这本身即「这些文件复杂度已到需逐轮扫描维持」的证据。**但**逐文件 fix 次数统计未做（预算限制），故不给量化排名。

---

## 附：交叉验证与预算声明

- 测试覆盖抽样：`test/document/data-safety.test.ts`（回收站清单降级、版本头部损坏、非 UTF-8）、`test/document/version-raw-bytes.test.ts`（字节对称 + fence 尾随空白）、`test/document/version-prune.test.ts`（pinned 保护）、`test/document/version-cache.test.ts`（去重缓存存活）、`test/document/platform-canonical-save.test.ts`（无 BOM）、`test/document/doc-domain-guards.test.ts`（EACCES/EPERM 注入）、`test/document/encoded-family.test.ts`（编码目录双候选）、`test/document/journal-cross-process-lock.test.ts`（双进程 journal）——**数据破坏类风险有专档测试**，判定「本域测试面充足」；缺口仅在 A-2/A-3 两处边缘形态。
- 本报告依赖的 grep 结果 `test/document` 命中 846 处（含做临时目录清理的 `rmSync`），清理型调用已排除，不作为写路径风险计。
- 工具调用与预算：域内清单排序 1、精读 12 档（`fs/atomic`、`fs/safe-path`、`fs/case-probe`、`fs/text-canonical`、`fs/read-safe`、`document/version`、`fs/cross-process-lock`、`format/yaml-spec`、`document/structure-merge`、`format/frontmatter`、`document/service`(前 760 行)、`document/manifest`(前 300 行)、`shared/frontmatter-core`、`document/trash`、`document/service-meta`、`format/style-candidate`、`document/journal`、`document/draft-path`、`document/service-move`(前 200)、`export/collect`）、结构性 grep 6 次、`git log` 1 次、测试抽样读/搜 4 次，合计 25 次（≤40）；报告行数 ≈190（≤400）。

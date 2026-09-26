#!/usr/bin/env node
/**
 * 源码注释门（comment-surface）：注释只留约束、不变量、平台差与语义说明——修复史归 git。
 *
 * 背景（质量债 P3-1「注释考古化」）：批号标签曾是注释主体（评审度量：全库注释 28.8%、
 * 带标注释行 7484 行 / 标签 11098 个），现行契约要从修复叙事里打捞，且行号引用、悬空
 * 路径、过时状态已开始腐烂。本门仿 check:docs 先例，把「注释不写修复史」从纪律升级为
 * 机器门：源码注释中出现批号标签形态即红，防止清理后回弹。
 *
 * 扫描范围：`src/**`（含 `src/studio/web-next/src/**`）+ 根构建配置四件
 * （tsup / vitest / eslint / playwright config）。排除 node_modules、`*.d.ts`。
 * `test/` 不入门——测试文件头注释留批次号是纪律允许形态（CLAUDE.md 测试分层）。
 *
 * 标签形态（按全库实测标定，均为「只可能是批号 / 轮次 / 评审史」的高置信形态）：
 * - R 系批号：`R40`、`R68-3`、`R51-C-3`、`R34D-19`、`R0916-7-P3-3`、`R1a`、`R-5`
 * - 小写 r 系：`r0912`、`r30`（多为旧测试文件名残留引用，同样算腐烂）
 * - 质量债 ID：`P3`、`P2-1`（域前缀形态 `CC-P2-3`、`Z-P2-4` 由尾部 P 系命中）
 * - 专项系列：`PM-10`；`X-P1-3` 由 P 系尾部命中
 * - 轮次：`第 5 轮`、`第六十轮`、括注 `（三十七轮）`
 * - 批次括注：`（批 5）`
 * - 日期戳：`2026-09-11`、`2026年9月`
 * - 评审过程词：`复审`、`重审`
 * - 单字母域号：`A-6`、`N-10`、`T5`、`Q2`、`D3`、`B5`、二级域号 `L-A3`/`E-N1`/`L-S2`
 * - 已知豁免术语：`V8`（引擎名）、`K8s`、`H1`/`H2`（标题级）——真实技术术语，显式例外表放行
 *
 * **形态表的边界是实测出来的，不是推理出来的**：本表初版注释曾断言「单字母域号全库无
 * 合法撞形」，实测证伪——`L2` 范数、`OQ-V1`、`B7 D5 B4 D6 F2 E5`（win 字体名十六进制
 * 字节串）都曾被当批号删掉。凡真实技术术语 / 现行正文符号与形态撞形，一律进
 * `TOKEN_EXCEPTIONS` 显式放行，**不靠「大概不会撞」**。
 *
 * 字符串字面量零误报：扫描器是逐字符状态机（字符串 / 模板串含 ${} 嵌套 / 正则字面量 /
 * .vue 模板 HTML 注释 / CSS url 裸 URL），字符串内容里的 `R40`、`//` 一律不进注释判定
 * ——清理只动注释、绝不碰生产字面量（此前有误删字面量的事故，本门是该红线的机器化）。
 *
 * allowlist（承重锚注）：若某注释被测试 readFileSync 源码断言钉住（删改即测试红），
 * 在 ANCHOR_ALLOWLIST 登记「文件 + 行内容子串 + 钉住它的测试」放行。开工盘点
 * （方法：全量 test/ 中 readFileSync 读 src 的断言字面量反查注释行）结论：当前零批号
 * 锚注——原「R43-8（四十三轮）」类锚已随测试资产行为化移除，R40 静态锚全部改钉代码
 * 形态——故本表启动为空；机制与直测在位，日后发现承重锚注在此登记，不在注释里续命。
 *
 * 用法：npm run check:comments（退出码 1 = 命中，列出文件:行 + 形态 + 原文供修）。
 * 纯函数 export，直测见 test/scripts/check-comments.test.ts。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 扫描的根配置文件（构建配置同病：构建期注释曾数倍于代码）。
 * prettier.config.mjs 同属根配置面——工具链配置的注释同样只该写约束与取值依据。
 */
export const ROOT_CONFIG_FILES = [
  'tsup.config.ts',
  'vitest.config.ts',
  'eslint.config.js',
  'prettier.config.mjs',
  'playwright.config.ts',
]

/** 扫描的源码扩展名。`.d.ts` 一并扫——手写契约档（`desktop.d.ts`）也是叙述面，
 *  此前按「环境声明非叙述面」排除，结果该档里 4 行批号沿革长期漏网。 */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.vue', '.js', '.mjs', '.cjs'])

/** 豁免目录名（任意层级）。 */
const EXCLUDED_DIRS = new Set(['node_modules'])

/**
 * 修复史批名：只写**后缀**、不吞前缀——`重评修复批` / `0918修复批` / `优化修复批` /
 * `临时目录收敛批` 都命中「修复批」「收敛批」这两个后缀。判定面窄 = 零误报（`批量` /
 * `批注` / `批次` / `批复` / `本批` / `同批` 这类后随汉字的真词一律不入）；切除面由
 * `stripTagSpans` 的前缀补齐（词素闭集见下）。后缀表闭集：每条经全库注释面实测只作批名用。
 */
export const BATCH_NAME_SUFFIX =
  '修复|清偿|拍板|机械|处置|规范化|收敛|拆分|启用|巨石|复核|精简|适配|合并|分桶|升级|预设|清账|补|附|审阅|普查|快断|迁移|遮蔽|优化|并合|收尾|服务端|修账|防穿越|非法字符集|评审|债|行为化|整理|测试|清库|专项|内存|临时目录|收敛'

/**
 * 批名前的修饰词素（闭集，实测自全库注释面）。只用于切除期的**前缀补齐**，不参与判定
 * ——宽一点无害，但必须闭（不能吞任意汉字），否则会连正文一起切走。
 * 逐个「锚尾」匹配，不做嵌套量词（长句上会灾难性回溯）。
 */
const BATCH_NAME_PREFIX_ATOMS = [
  /[零一二三四五六七八九十百\d]{1,6}轮$/,
  /第[零一二三四五六七八九十百\d]{1,3}(?:轮|篇)$/,
  /阶段\s*\d+$/,
  /\d{3,6}[零一二三四五六七八九十百]{1,2}$/,
  /[A-Za-z]{1,8}\.\d+$/,
  /[A-Za-z]{1,8}$/,
  /\d{1,6}$/,
  /残留$/,
  new RegExp(`(?:${BATCH_NAME_SUFFIX})$`),
]

/**
 * 评审过程词（`重评`/`重审`/`复审`）的修饰词素与序号——切除期同样是闭集前缀 + 后缀。
 * `全量重评` / `独立重评` / `RC 源码重审` / `重评-0912-2` / `复审-0914-` 都由此整段切除，
 * 否则会留下 `RC 源码 `（缺主词）、` 全量`（缺主词）这类半截桩。
 * 全部锚尾（`$`）：不加锚会在长句上匹配到句中任意一个词素，切错位置。
 */
const NARRATIVE_PREFIX_ATOMS = [
  /(?:全量|全库|全项目|源码|代码|独立|专项|内存|性能|质量|评审)重$/,
  /(?:全量|全库|全项目|源码|代码|独立|专项|内存|性能|质量|评审)$/,
  // 裸轮次紧贴在过程词左侧（`六轮重评 B101 勘误`）：`裸轮次` 的右手后视挡 CJK，此处
  // `六轮` 后随的正是 `重`，判定层抓不到，只能靠切除期的前缀补齐整段带走——否则剥完
  // `重评` 会剩 `——六轮勘误` 这种半截轮次。
  /总?[零一二三四五六七八九十百\d]{1,5}轮$/,
  /[A-Za-z]{1,8}$/,
]

/** 反向前缀补齐：从尾部锚定的词素逐个剥，返回补齐后的起始下标。
 *  `floor` = 补齐不可越过的下界（注释标记 `/` 与缩进不属正文，吞掉会把 `// X-P3a` 吃成空行）。 */
function expandLeft(text, start, atoms, floor = 0) {
  let a = start
  for (;;) {
    const head = text.slice(0, a)
    let hit = null
    for (const re of atoms) {
      const m = re.exec(head)
      if (m && m[0]) {
        hit = m[0].length
        break
      }
    }
    if (hit !== null && a - hit >= floor) {
      a -= hit
      continue
    }
    // 连接符 / 空白（`复审-0914-优化修复批`、`RC 源码重审`）。破折号与斜杠不吞：
    // `重置」——六轮 B101` 的 `——` 是引下文的正文标点，吞掉成「重置」B101」；
    // `/` 是注释标记本身，吞掉一路吃到行首。二者都只该由下方的标点收敛处理。
    if (a > floor && /[-\s]$/.test(text.slice(0, a))) {
      a -= 1
      continue
    }
    return a
  }
}

/** 一行注释里正文的起点（注释标记与紧随的空白不属正文）。
 *  含 `.vue` 的 HTML 注释开标记——不把 `<!--` 计入，切除会从 `-` 处咬进标记本身。 */
function commentFloor(text) {
  const m = /^\s*(?:<!--|\/\/+|\/\*+|\*+)\s?/.exec(text)
  return m ? m[0].length : 0
}

/** 向后补齐：序号（`重评2`/`重评-0912-2`/`P3-③`）、轮次（`重审-1`）、尾随小写域号（`X-P3a`）、
 *  条目号（`修复批 #3）`）。 */
function expandRight(text, end) {
  let b = end
  for (;;) {
    const tail = text.slice(b)
    // 尾随域号字母只在「紧贴」时吞（`P3a`），隔了连接符则交给下一轮
    const m =
      /^(?:[-–—]?\d{1,4}(?:[-–—]\d{1,4})*(?:[a-z]\b)?|[-–—][a-z]\b|[-–—][①-⑳]|[①-⑳]|[-–—]?[零一二三四五六七八九十百]{1,3}轮)/.exec(
        tail,
      )
    if (m && m[0]) {
      b += m[0].length
      continue
    }
    // 条目号（`修复批 #3）` / `（修复批 #3）`）与紧随的闭括号——`#` 只在此处出现于批号语境
    const h = /^[\s]*#[ \t]*\d{1,4}[ \t]*[）)]?/.exec(tail)
    if (h && h[0]) {
      b += h[0].length
      continue
    }
    // 紧贴的小写字母（`P3a` / `X-P3a` 的 `a`）——仅当后随非字母数字时吞
    if (/^[a-z](?![\w])/.test(tail) && b > 0 && /[\d]/.test(text[b - 1])) {
      b += 1
      continue
    }
    if (b < text.length && /[-–—]/.test(text[b])) {
      b += 1
      continue
    }
    return b
  }
}

/**
 * 切除处的空隙裁定：L = 跨度左邻文本（已去尾随空白），R = 右邻文本（已去前导空白）。
 * 返回左右之间应保留的空白（'' 或 ' '）。
 * 依据：中文正文里标签两侧的空隙只为隔开标签而存在，标签一走就该消失；只有「拉丁词
 * 紧邻拉丁词」时才需要一个空格，否则会粘成一个词。
 */
function spaceBetween(L, R) {
  // L 只剩注释标记（`//`、`/*`、块注续行 `*`）：与正文之间一定有且只有一个空格
  // ——否则剥完就成了 `//已收敛`。
  if (/^\s*(?:\/\/+|\/\*+|\*+)$/.test(L)) return R ? ' ' : ''
  const cjkEnd = /[\u4e00-\u9fa5]$/.test(L)
  const cjkStart = /^[\u4e00-\u9fa5]/.test(R)
  if (cjkEnd || cjkStart) {
    // 一侧是拉丁 / 数字、另一侧是汉字：空格承隔离职责，不能省（`阶段 53 S3 快断` → `阶段 53 快断`）
    if (/[A-Za-z0-9]$/.test(L) || /^[A-Za-z0-9]/.test(R)) return ' '
    return ''
  }
  if (/[，,。、；：！？…）)】」》]$/.test(L)) return ''
  // 左邻以运算/连接符收尾（`（B3 面板 + B4 前置注入）` 的 ` +`）：标签走后那个 `+` 仍是
  // 并列连词，两侧各留一个空格（否则读成 `面板 +前置注入`）。
  if (/[+\-*/=<>|±]$/.test(L) && !/^[，,。、；：）)】」》]/.test(R)) return ' '
  if (/^[（(【〔「《，,。、；：！？…]/.test(R)) return ''
  if (GLUE_L.test(L) && GLUE_R.test(R)) return ' '
  return ''
}

/** 字词字符 / 汉字（决定切除处两侧空白是否只是「胶连标签」的空隙）。 */
const GLUE_L = /[\p{L}\p{N}）)】」》]$/u
const GLUE_R = /^[\p{L}\p{N}（(【〔「《]/u

/**
 * 叙事填充词：剥离标签后若括注（或整行）只剩这些词与标点，说明括注本身也只是修复史，
 * 可整体删除——`（PM-10 性能专项）` 剥掉 ID 剩「性能专项」、`（二十一轮 A 域）` 剥掉轮次
 * 剩「A 域」、`（B005 尾项）` 剥掉条目号剩「尾项」，留着就是半截叙事。判据必须闭：
 * 出现任何实义正文即不删；且**总量受限**（调用方另限汉字数），免得长括注靠词表逐个命中被整删。
 */
const NARRATIVE_FILLER =
  /^(?:[\s，,、；;：:·—\-–/#0-9.①-⑳]|全量|全库|全项目|源码|代码|独立|专项|内存|性能|质量|评审|优化|修复|清偿|拍板|机械|处置|规范化|收敛|拆分|启用|巨石|复核|精简|适配|合并|分桶|升级|预设|清账|批|轮|域|条|组|阶段|第|总|[零一二三四五六七八九十百]|[A-Za-z]|修订|登记|不修|移交|收尾|同因|保守|路径|先行|声明|尾项|主审|裁定|随批|判定|证据链|同向|加固)*$/

/** 括注内容（或整行）剥标签后是否只剩叙事填充词。 */
export function isNarrativeOnly(text) {
  if (!text.trim()) return true
  let rest = ''
  let pos = 0
  for (const s of tagSpansOf(text)) {
    rest += text.slice(pos, s.start)
    pos = s.end
  }
  rest += text.slice(pos)
  return NARRATIVE_FILLER.test(rest)
}

/**
 * 切除一行注释里的全部标签跨度，并吸收只为胶连标签而存在的标点 / 空白。
 * **与门同源**：跨度取自 `tagSpansOf`（同一形态表、同一去重叠口径），故清理的切除粒度
 * 与门的判定粒度必然一致——这正是此前「门按 `B0` 命中、清理删 `B0` 留 `.2`」事故的根因。
 *
 * 切除顺序：
 *   1) 纯标签括注整体删（括注内容剥标签后只剩标点 / 空白）；
 *   2) 其余标签跨度扩张后逐段切除，左端空白遇右侧标点则一并吸收；
 *   3) 残留标点收敛（`tidyGluedPunctuation`）。
 * 只动「标签跨度 + 紧邻的连接符」，其余字符逐字保留。
 */
export function stripTagSpans(text) {
  // 无标签可剥时**逐字原样返回**，不走标点收敛：收敛规则里有「空括注整体删」这类会动
  // 正文的重写（`timer.refresh()` 的 `()` 就是被它吃掉的），对本来干净的注释必须零改动
  // ——清理器只在真的切了东西的行上才有权改写标点。
  if (!tagSpansOf(text).length) return text
  // 迭代：一次剥离会露出被包在里层的新跨度（`M2（二轮复审）` → `（二轮）` → 空括注），
  // 故剥到不动点为止（上限 8 轮，长句上收敛很快）。
  let cur = text
  for (let i = 0; i < 8; i++) {
    const next = stripOnce(cur)
    if (next === cur) break
    cur = next
  }
  return tidyGluedPunctuation(cur)
}

/** 单趟切除（含跨度补齐、纯标签括注整删、两侧空隙去留）。 */
function stripOnce(text) {
  const floor = commentFloor(text)
  const all = []
  for (const k of tagSpansOf(text)) {
    let { start, end } = k
    // 前 / 后补齐：批名吞修饰词素（`0918二轮修复批`）；评审过程词吞修饰词与序号
    // （`RC 源码重审`、`重评-0912-2`）——不补就会留下「RC 源码 」这类半截桩。
    // 单字母域号 / 债 ID 吞紧贴的短域前缀（`dd-P2`、`X-P3a` 的 `X-`）与同链后缀 `a`。
    if (k.name === '修复史批名') {
      start = expandLeft(text, start, BATCH_NAME_PREFIX_ATOMS, floor)
      end = expandRight(text, end)
    } else if (k.name === '评审过程词') {
      start = expandLeft(text, start, NARRATIVE_PREFIX_ATOMS, floor)
      end = expandRight(text, end)
    } else if (
      k.name === '裸轮次' ||
      k.name === '质量债ID' ||
      k.name === '单字母域号' ||
      k.name === '单字母域号-横' ||
      k.name === '域前缀债ID' ||
      k.name === '批次词' ||
      k.name === '条目号' ||
      k.name === '连字条目号' ||
      k.name === '四位日期码'
    ) {
      start = expandLeft(text, start, [/[a-z]{1,4}$/, /[A-Z]{1,5}-$/, /阶段$/], floor)
      end = expandRight(text, end)
      // 日期码与批名简写连写（`0918修复1`、`0918二轮修复1`、`0917清库修复批`）：日期本身是
      // 已判定标签，紧贴其后的「修复N / N轮 / 批名」是同一批号的简写，一并带走——否则日期
      // 一走就剩 `修复1/起：`、`清库修复批增` 这类半截桩（`修复批增` 的后随汉字使
      // `修复史批名` 的右视判不出，判定层窄，只能由切除期补齐）。
      if (k.name === '四位日期码') {
        const m = new RegExp(`^(?:(?:${BATCH_NAME_SUFFIX})\\d{0,2}|总?[零一二三四五六七八九十百]{1,3}轮|批)+`).exec(
          text.slice(end),
        )
        if (m) end += m[0].length
      }
    }
    // 跨度左端悬挂的胶连标点（`RC 源码重审 A-8：更名` 的 `// ` 后是空的，但
    // `// 复审 X：…` 剥完会剩 `//：…`）——把紧贴左侧的空格一并纳入跨度，交给标点收敛。
    all.push([start, end])
  }
  // 纯标签括注：内容剥标签后只剩标点 / 空白 / 叙事填充词 → 整括注删（比留一对空括号干净）。
  // 判据闭集（NARRATIVE_FILLER）：`（2026-09-05 性能专项）` 剥掉日期剩「性能专项」= 仍是修复史，
  // 整删；`（二十一轮，裁定维持）` 剩「裁定维持」= 实义正文，留——留时下面的标点收敛会吃掉
  // 切除后裸露的前导逗号（`（，裁定维持）` → `（裁定维持）`）。
  for (const m of text.matchAll(/[（(][^（()）]*[）)]/g)) {
    const inner = m[0].slice(1, -1)
    if (!tagSpansOf(inner).length) continue
    const rest = stripTagSpans(inner)
    if (
      /^[\s，,、；;：:·—\-–/0-9.①-⑳]*$/.test(rest) ||
      (isNarrativeOnly(rest) && rest.replace(/[^\u4e00-\u9fa5]/g, '').length <= 6)
    ) {
      all.push([m.index, m.index + m[0].length])
    }
  }
  if (!all.length) return text
  all.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  // 合并：①补齐后相互重叠；②两跨度之间只隔「胶连标点」（`（FE-9/L-4 惯例）` 的 `/`、
  // `（批次 / CS-11 + DSH-4 直抄）` 的 `/ +`）——那段标点只为串起两个标签而存在，整段带走，
  // 否则会留下 `（/ 惯例）`、`（批次/+直抄）` 这类残渣。隔着实义字符（字母 / 数字 / 汉字）
  // 则不算胶连，各自成段。
  const merged = []
  for (const [a, b] of all) {
    const last = merged[merged.length - 1]
    if (last && (a <= last[1] || /^[\s，,、；;：:·—\-–/／+±()（）"'“”]*$/.test(text.slice(last[1], a)))) {
      last[1] = Math.max(last[1], b)
      continue
    }
    merged.push([a, b])
  }
  let out = ''
  let pos = 0
  for (const [a, b] of merged) {
    if (a < pos) continue
    // 标签两侧空隙随标签去留（见 spaceBetween）——留 `已被 作废` 这类空档是上次清理的病灶。
    let ls = a
    while (ls > pos && /[ \t]/.test(text[ls - 1])) ls--
    // 左邻「空白 + 分隔斜杠」（`（批次 / CS-11 直抄）` 的 ` /`）：斜杠只为引出标签而存在，
    // 标签一走它就成残渣，故连它前面的空白一并带上（否则留 `（批次 /直抄）`）。
    // **只收 `/`**：`+` 是并列连词（`（B3 面板 + B4 前置注入）` 的 ` +`——收了它就丢了「+」，
    // 读成「面板前置注入」），`±`/`·` 同理是正文字符，都不能当胶连标点删。
    if (ls > pos + 1 && /[/／]/.test(text[ls - 1]) && /[ \t]/.test(text[ls - 2])) {
      ls -= 1
      while (ls > pos && /[ \t]/.test(text[ls - 1])) ls--
    }
    // 左邻「贴住的顿/逗号」（`见 ，R40-2 说明`）：这个逗号只是把标签引进句子，标签一去它
    // 就悬空。只收贴住跨度、且是 `，`/`、` 的这一类——`；`/`：` 常是作者在分句，不能碰。
    if (ls > pos && ls === a && /[，,、]/.test(text[ls - 1])) ls -= 1
    let re = b
    while (re < text.length && /[ \t]/.test(text[re])) re++
    const L = text.slice(pos, ls)
    const R = text.slice(re)
    const hasSpace = ls < a || re > b
    if (hasSpace && L.length && R.length) {
      out += L + spaceBetween(L, R)
      pos = re
      continue
    }
    out += text.slice(pos, a)
    pos = b
  }
  out += text.slice(pos)
  return out
}

/**
 * 标签形态表。re 必须带 g 旗（matchAll 消费）；每命中一处算一个 hit。
 *
 * 收录标准 = 「只可能是批号 / 轮次 / 评审史」。**命中跨度必须落在 token 边界上**——
 * 这是硬约束而非风格：本门的命中集同时充当清理批次的切除集（`stripTagSpans`），
 * 门若在 token 中段命中（`B0.2` 只命中 `B0`），清理就只切中段、留下 `.2` 半截桩，
 * 甚至削掉相邻正文。故单字母域号两形都带 token 级前后视。
 */
export const TAG_PATTERNS = [
  // 尾部 `(?:[a-z])?(?![A-Za-z0-9_])` = token 右界：既收下同链小写域号（`X-P3a` 的 `a`、
  // `R1a`），又挡住词中段（`R40foo` 不许只吃 `R40f`——那正是清理切出半截桩的成因）。
  {
    name: 'R系批号',
    re: /\bR-?\d{1,4}[A-Za-z]?(?:-[A-Za-z0-9]+)*(?:[a-z])?(?![A-Za-z0-9_])/g,
    why: '修复批号叙事应归 commit message',
  },
  {
    name: 'r系批号',
    re: /\br\d{2,4}(?:-[A-Za-z0-9]+)*(?:[a-z])?(?![A-Za-z0-9_])/g,
    why: '旧测试名/批号残留引用应改指现行名或删除',
  },
  {
    name: '质量债ID',
    re: /\bP[123](?:-\d+)*(?:[a-z])?(?![A-Za-z0-9_])/g,
    why: '质量债编号叙事应归报告正本 / commit message',
  },
  { name: 'PM专项', re: /\bPM-\d+\b/g, why: '专项审查项编号应归报告正本' },
  {
    name: '域前缀债ID',
    re: /\b[A-Z]{1,5}(?:-[A-Za-z]{1,8})?-P[123](?:-\d+)*(?:[a-z])?(?![A-Za-z0-9_])/g,
    why: '域内质量债编号应归报告正本',
  },
  {
    // 二级域号（`L-S2`/`L-A3`/`E-N1`/`L-F1`）必须与一级同表：`（第八轮）` 一类括注会被
    // `L-A3（第八轮）` 那样的形态切出 `L-` 半截桩，而 `L-` 自身又因「`-` 后必须是数字」
    // 判不出，成了门看不见的黑洞（实测基线 24 个形全是域号，无合法术语撞形——`UTF-8`/
    // `SHA-256` 这类因单字母 `\b` 左界不入射程）。
    name: '单字母域号-横',
    re: /\b[A-Z]-(?:[A-Z]{0,2})?\d{1,3}(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9_])/g,
    why: '旧修复批域号叙事应归 commit message',
  },
  {
    // 前后视挡四类合法撞形：①点号里程碑号（`B0.2`/`E3.3`/`T2.1`——设计文档块号，
    // 右邻 `.` 即非批号）；②斜杠兄弟形右半（`B0.2/B4` 的 `B4`、`D2/D5` 的 `D5`——
    // 左邻 `/` 即同在引用别的号）；③路径 / 标识符内片段（左邻 `\w.` 或右邻 ASCII
    // 字母数字）；④连字符同链后半（`OQ-V1` 的 `V1`——左邻 `-` 即属更长的条目号，
    // 由 `连字条目号` 整段收）。四者都曾因「跨度过宽」在清理时切出半截桩。
    name: '单字母域号',
    re: /(?<![/\w.-])[A-Z]\d(?![\dA-Za-z./])(?:-[A-Za-z0-9]+)*/g,
    why: '旧修复批域号叙事应归 commit message',
  },
  {
    // 孤儿斜杠形：`/B4`、`/S1`、`/D4`——「斜杠 + 域号」但**斜杠左侧是空白 / 标点 / 行首**，
    // 故左边根本没有兄弟号可引，只能是清理把兄弟左半切走留下的残桩（基线 `B-1/B4：…`、
    // `// Z-8/F1/R37-1 三段`）。独立的条目而非并进上一条：上一条的左视一律放行 `/`
    // （兄弟形右半必须放行），拿它判孤儿形会被自己的豁免吞掉——这正是本形被门漏掉的原因。
    // 三重排除：①左邻 token 字符（`G1/G3`、`S1/S2`、`B0.2/B4`、`#18/M2` 的右半是**真兄弟**
    // 引用，不是残桩）；②右邻字母数字（标识符中段）；③不含数字的斜杠串（URL 路径 `/API`、
    // `/CON`、`/nul.txt` 与正则字面量 `/429/`、`/network/`、`/SSE/`）。
    name: '孤儿斜杠域号',
    re: /(?<![A-Za-z0-9])\/[A-Z]{1,6}\d{1,3}(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9])/g,
    why: '清理残桩（兄弟号被切走留下的孤斜杠）应归 commit message',
  },
  {
    // 修复史批名：后缀闭集 + `批` + 非汉字（`修复批`/`清偿批`/`收敛批`…）。
    name: '修复史批名',
    re: new RegExp(`(?:${BATCH_NAME_SUFFIX})批(?![\\u4e00-\\u9fa5])`, 'g'),
    why: '修复批次名叙事应归 commit message',
  },
  {
    // 四位日期码：`0918`（当年批内简写，无 `20` 前缀故 `日期戳` 抓不到）。前后视挡
    // 数字串内片段（`0916-7` 由本形 + 后续 `-数字` 补齐成一体）。
    name: '四位日期码',
    re: /(?<!\d)09\d{2}(?!\d)/g,
    why: '修订日期应归 git 历史（blame 可查）',
  },
  {
    // 条目号：`A001`/`B005`/`C101`/`E003`/`G104`（单双字母 + 3~5 位）——0918 批的条目编号。
    // **下限取 3 位**：`M12` 这类两位形是设计文档块号（`M12 块0.1`）与审查项号（`E10`/`S24`），
    // 前者是**现行**设计文档的可查引用，清掉反而丢信息，故不入表（例外表仍列几个已实测的术语形）。
    name: '条目号',
    re: /\b[A-Z]{1,2}\d{3,5}(?![\dA-Za-z_.])/g,
    why: '审查条目号叙事应归报告正本',
  },
  {
    // 连字条目号：`DSH-18`/`MP2-4`/`DA-3`/`PL-2`/`BE-4`/`IR-2`/`CS-12`/`GG-F1`/`L-F1`。
    // `-[A-Z]?` 收「字母再一位数字」形（`GG-F1`——旧形要求 `-` 后直接是数字，整支漏判，
    // 门看不见它、清理器也就修不掉，批 5 之后它一直以半截桩形态留在注释里）。
    // 4 位以上数字后缀被右视挡住（`RFC-1234`/`ISO-8601` 这类规范号因此不入射程）。
    // 例外表挡编码与摘要算法名（`UTF-8`/`SHA-256`/`AES-256`）。
    name: '连字条目号',
    re: /\b[A-Z]{1,6}\d{0,2}-[A-Z]?\d{1,3}(?![\dA-Za-z_.])/g,
    why: '审查条目号叙事应归报告正本',
  },
  { name: '轮次', re: /第\s*[零一二三四五六七八九十百\d]+\s*轮/g, why: '轮次叙事应归 commit message' },
  {
    // 裸轮次（无「第」无括注）：「（三十轮 A 域）」「四轮-A402」「总六十五轮」等。前后视
    // 挡「下一轮」「本轮」「轮次」一类真词（前置汉字 / 后随汉字即不算）。注意右视挡 CJK
    // 会漏「六轮重评」这种轮次紧跟过程词的写法——判定面窄，由切除期的前缀补齐兜住。
    // （初版注释曾写「基线 2115 处全部为轮次叙事」，该数字经复核实为误记：实测命中 277 处。）
    name: '裸轮次',
    re: /(?<![\u4e00-\u9fa5])总?[零一二三四五六七八九十百\d]{1,5}轮(?![\u4e00-\u9fa5])/g,
    why: '轮次叙事应归 commit message',
  },
  { name: '括注轮次', re: /[（(]\s*[零一二三四五六七八九十百]+\s*轮\s*[）)]/g, why: '轮次叙事应归 commit message' },
  {
    // 括注轮次·带内容：`（二十二轮批 A）`、`（十五轮登记销账）`、`（七十四轮批 D）`——`轮`
    // 后紧跟汉字，于是 `裸轮次` 的右视挡它、`括注轮次` 又要求整括注只有「N 轮」，两形都不收，
    // 是门与清理器共享的第四处盲区（前三年分别是二级域号、连字条目号、孤儿斜杠）。判据取
    // 「括注以『N 轮』开头」——修复史括注都是这个形状；内容限 60 字且不含嵌套括注，
    // 再长就不是出处标注而是正文了。
    name: '括注轮次·带内容',
    re: /[（(](?:总)?[零一二三四五六七八九十百\d]{1,5}轮[^（()）]{0,60}[）)]/g,
    why: '轮次叙事应归 commit message',
  },
  {
    // 括注轮次·模型名（`（Opus-5.5 轮）`、`（GLM-5.3 轮）`）：审查轮的**执行模型名 + 轮**，
    // 同属「哪一轮评审留下的」出处标注。要求括注内容**以拉丁词起、以 `轮` 收**——`（data +
    // 本轮 usage）`、`（stopChild / killNow / 换轮清旧）`、`（重启定时器在途，无在途轮）`
    // 这些真词括注因含分隔符或汉字起首而不入射程。
    name: '括注轮次·模型名',
    re: /[（(]\s*[A-Za-z][\w.-]*(?:\s+[A-Za-z][\w.-]*)*\s*轮\s*[）)]/g,
    why: '轮次叙事应归 commit message',
  },
  { name: '批次括注', re: /[（(]\s*批\s*[\dA-Za-z]{1,3}\s*[）)]/g, why: '批次叙事应归 commit message' },
  {
    // 批次词（非括注）：`批 5`/`批2`/`批 D`/`批 E`/`52 批`/`22 批`/`D3 批 5`。左界挡汉字
    // （`分批`/`同批`/`一批` 这类量词与动词）与词字符（`ii 批` 是平台缩写前缀，
    // 属真批次叙事故保留；`delete 批` 这类英文词首字母被 `\w` 左界挡住）。
    // **两侧可同时出现**（`D3 批 5` 是「前缀 + 批 + 序号」一体），故并成单支：拆成两支时
    // 左支 `[\dA-Za-z]+\s*批` 会在更靠左处先命中、吃掉共用的 `批`，右支再无机可乘，
    // 残留 `（5 起三口径` 这样的半截序号。尾视同时挡汉字与词字符（`批次`/`批量` 不入）。
    name: '批次词',
    re: /(?<![\u4e00-\u9fa5\w])(?:[\dA-Za-z]{1,3}\s*)?批(?:\s*[\dA-Za-z]{1,3})?(?![\u4e00-\u9fa5\dA-Za-z])/g,
    why: '批次叙事应归 commit message',
  },
  { name: '日期戳', re: /\b20\d{2}-\d{1,2}-\d{1,2}\b|20\d{2}\s*年/g, why: '修订日期应归 git 历史（blame 可查）' },
  { name: '评审过程词', re: /复审|重审|重评/g, why: '评审沿革叙事应归报告正本' },
]

/**
 * 真实技术术语豁免（形态撞上条目号 / 单字母域号，但属正常术语，不是审查条目号）。
 * 逐条都经全库注释面实测：**当前命中**里只有这些是术语，其余都是批次 / 条目号。
 */
export const TOKEN_EXCEPTIONS = new Set([
  // 单字母域号撞形
  'V8',
  '/V8', // 「Node 警告 / V8 诊断」：斜杠是并列连接词，不是兄弟号引用——孤儿斜杠形也得放行
  'K8s',
  'H1',
  'H2',
  // 编码 / 摘要 / 密码学
  'UTF-8',
  'UTF-16',
  'UTF-32',
  'UTF8',
  'SHA-1',
  'SHA-256',
  'SHA-384',
  'SHA-512',
  'SHA256',
  'AES-256',
  'AES-128',
  'AES-192',
  'AES-256-GCM',
  'GB2312',
  'GBK',
  'MD5',
  // 语言 / 平台规范版本
  'ES2023',
  'ES2022',
  'ES2021',
  'ES2020',
  'ES2015',
  'HTML5',
  'HTML4',
  'FAT32',
  'FAT16',
  'ISO8601',
  // 浏览器版本
  'M80',
  'M12',
  // Unicode 码点与码点区间
  'D800',
  'DBFF',
  'DC00',
  'DFFF',
  'AC00',
  'D7A3',
  'F900',
  'FAFF',
  'FF00',
  'FFEF',
  'E000',
  'F8FF',
  'FEFF',
  '200B',
  '3000',
  'FFFD',
  'U3000',
  // 编解码 / 设备名 / TS 错误码
  'H264',
  'H265',
  'TS2307',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  // Windows 保留设备名的**区间**写法（`COM1-9`/`LPT1-9`）——同一术语的缩写形
  'COM1-9',
  'LPT1-9',
])

/**
 * 承重锚注 allowlist：被测试源码断言钉住、不得删改的注释。
 * file = 相对仓库根或相对 src/ 的路径（按路径后缀匹配）；contains = 注释行内的原文子串；
 * why = 钉住它的测试文件。命中行满足 file + contains 即放行。
 */
export const ANCHOR_ALLOWLIST = []

// 正则字面量起判位置：上一有效符号在这些字符后、或上一完整词是这些关键字时，
// `/` 开正则态而非除法。（`return /re/` vs `a / b` 的经典歧义启发式。）
const REGEX_AFTER = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '\n',
])
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'yield',
  'await',
  'instanceof',
])

/**
 * 逐字符状态机：抽出每行的注释片段。字符串 / 模板串 / 正则字面量内容一律不算注释。
 * 返回 [{ line, col, endCol, text }]——text = 该行注释区域原文（不含换行），
 * col/endCol = 该行内注释起止列；无注释的行不出现。ext = '.vue' 时启用 HTML 注释态。
 */
export function extractCommentLines(text, ext = '.ts') {
  const out = []
  const n = text.length
  let i = 0
  let line = 1
  // 注释态：'line' | 'block' | 'html' | null
  let mode = null
  let regionStart = -1 // 注释区域起始偏移（全文）
  let regionLine = -1
  // 模板串栈：'tpl'（模板文本段）| 'interp'（${} 内代码段）
  const stack = []
  let braceDepth = 0
  let prevSig = ''
  let prevWord = ''

  const isWordCh = (c) => /[A-Za-z0-9_$]/.test(c)

  const lineStartOf = (idx) => {
    const nl = text.lastIndexOf('\n', idx - 1)
    return nl + 1
  }

  // 注释区域 [regionStart, endIdx) 按行拆片登记
  const pushRegion = (endIdx) => {
    let segStart = regionStart
    let segLine = regionLine
    while (segStart < endIdx) {
      const nl = text.indexOf('\n', segStart)
      const segEnd = nl === -1 || nl >= endIdx ? endIdx : nl
      const col = segStart - lineStartOf(segStart)
      out.push({ line: segLine, col, endCol: segEnd - lineStartOf(segStart), text: text.slice(segStart, segEnd) })
      if (nl === -1 || nl >= endIdx) break
      segStart = nl + 1
      segLine++
    }
  }

  while (i < n) {
    const c = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    if (c === '\n') {
      if (mode === 'line') {
        pushRegion(i)
        mode = null
        regionStart = -1
      }
      line++
      i++
      continue
    }

    if (mode === 'line' || mode === 'block' || mode === 'html') {
      if (mode === 'block' && c === '*' && next === '/') {
        pushRegion(i + 2)
        mode = null
        regionStart = -1
        prevSig = '/'
        prevWord = ''
        i += 2
        continue
      }
      if (mode === 'html' && c === '-' && next === '-' && text[i + 2] === '>') {
        pushRegion(i + 3)
        mode = null
        regionStart = -1
        prevSig = '>'
        prevWord = ''
        i += 3
        continue
      }
      i++
      continue
    }

    // ── 模板文本态（先于一切代码态分支——闭合反引号 / 引号 / ${} 都归它管）──
    if (stack.length && stack[stack.length - 1] === 'tpl') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '$' && next === '{') {
        stack.push('interp')
        braceDepth = 0
        prevSig = '{'
        prevWord = ''
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        prevSig = '`'
        prevWord = ''
        i++
        continue
      }
      i++
      continue
    }

    // ── 代码 / 字符串 / 正则态（含 ${} 插值内的代码）──
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < n && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') i++
        i++
      }
      if (text[i] === quote) i++
      prevSig = quote
      prevWord = ''
      continue
    }
    if (c === '`') {
      stack.push('tpl')
      i++
      continue
    }
    if (c === '}' && braceDepth === 0 && stack.length && stack[stack.length - 1] === 'interp') {
      stack.pop() // ${ } 插值收口，回模板文本态
      prevSig = '}'
      prevWord = ''
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      prevSig = '{'
      prevWord = ''
      i++
      continue
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--
      prevSig = '}'
      prevWord = ''
      i++
      continue
    }
    if (c === '/' && next === '/' && text[i - 1] !== ':') {
      // `://`（裸 URL scheme）不开行注释（CSS url() 内合法）
      mode = 'line'
      regionStart = i
      regionLine = line
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      mode = 'block'
      regionStart = i
      regionLine = line
      i += 2
      continue
    }
    if (ext === '.vue' && c === '<' && next === '!' && text[i + 2] === '-' && text[i + 3] === '-') {
      mode = 'html'
      regionStart = i
      regionLine = line
      i += 4
      continue
    }
    if (c === '/' && (REGEX_AFTER.has(prevSig) || REGEX_KEYWORDS.has(prevWord))) {
      // 正则字面量态：跳到收尾 /（字符类外，转义与换行尊重）
      i++
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '/') {
          i++
          break
        }
        i++
      }
      prevSig = '/'
      prevWord = ''
      continue
    }
    if (c === '/') {
      prevSig = '/'
      prevWord = ''
      i++
      continue
    }
    if (isWordCh(c)) {
      prevWord = isWordCh(prevSig) || prevWord === '' ? prevWord + c : c
      prevSig = c
      i++
      continue
    }
    // 空白不覆盖 prevSig——`return /re/`、`= /re/` 的关键字/符号与 `/` 之间可隔空白
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    prevSig = c
    prevWord = ''
    i++
  }
  if (mode === 'line') pushRegion(n)
  return out
}

/**
 * allowlist 判定：file 按路径后缀匹配（支持仓库根相对与 src/ 相对两种写法）。
 */
export function isAllowlisted(file, lineText, allowlist = ANCHOR_ALLOWLIST) {
  return allowlist.some(
    (a) =>
      (file === a.file ||
        file.endsWith(sep + a.file) ||
        file.endsWith('/' + a.file) ||
        file.replace(/^src\//, '') === a.file) &&
      lineText.includes(a.contains),
  )
}

/**
 * 收集一行注释里的标签跨度（按位置排序、去重叠：位置优先、同位长者优先）。
 * 去重叠口径 = 「命中数 = 真实标签数而非形态数」——`R2W-7` 由 R 系 + 单字母两形撞出时
 * 只留覆盖最长的那一个。
 *
 * 本函数是**单一切除源**：门的判定与清理批次的切除共用它，二者粒度必然一致
 * （此前门与清理器各写一套形态导致「门按 `B0` 命中、清理器删掉 `B0` 留下 `.2`」）。
 */
export function tagSpansOf(text) {
  const found = []
  for (const { name, re } of TAG_PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (TOKEN_EXCEPTIONS.has(m[0])) continue
      found.push({ start: m.index, end: m.index + m[0].length, name, match: m[0] })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept = []
  for (const f of found) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue
    kept.push(f)
  }
  return kept
}

/** 标签切走后残留的标点收敛（只动标点与空白，绝不碰字母 / 数字 / 汉字）。 */
export function tidyGluedPunctuation(text) {
  return (
    text
      // 空括注 / 只剩标点的括注——内层必须**非空**（标点或空白 ≥1），裸 `()` 不动：
      // `timer.refresh()`、`clearTimeout()` 这类正文里的空参数表被删过一次，是实打实的
      // 正文损伤；而标签切走留下的残括注必是「有内容」形（纯标签括注另有整删通路）。
      .replace(/[（(]\s*[，,、；;：:·—\-–\s]+[）)]/g, '')
      // 叠标：只留前一个
      .replace(/([，,。、；;])\s*[：:]/g, '$1')
      // 破折号后紧跟句读 → 只留破折号
      .replace(/(——|—)\s*[。，,、；：:]+/g, '$1')
      // 同族标点叠写 → 收敛为一个
      .replace(/([，,。、；：])\s*(?=[，,。；：])/g, '$1')
      .replace(/([，,、；：])\s*(?=[）)])/g, '')
      // 括注内悬挂前导标点（`（，裁定维持）` → `（裁定维持）`）。斜杠**只收孤零零的**
      // （后随空白，`（/ 惯例）` → `（惯例）`）：`（/\.md$/i）` 的开头 `/` 是正则字面量
      // 定界符，按标点一视同仁地删过一次，把正则改成了 `\.md$/i`。
      .replace(/([（(])\s*[，,、；;：:·—]+\s*/g, '$1')
      .replace(/([（(])\s*[/／]\s+(?=\S)/g, '$1')
      // 注释标记后悬挂标点（标签贴行首时：`//：tasks` → `// tasks`、`// ：tasks` → `// tasks`）
      .replace(/^(\s*(?:<!--|\/\/+|\/\*+|\*+))\s*[，,、；;：:·]+\s*/gm, '$1 ')
      // 注：**没有**「行首 / 行尾悬挂标点」这一档。行尾的 `，`（换行续写的逗号）、
      // `——`（引出下文的破折号）、`──────`（分节装饰）都是作者的正文标点，标签切走后
      // 它们照样属于句子；把三者的「悬挂」笼统当残渣删过一次，`（面板 + 前置注入）` 的
      // `+`、`…终稿，` 的行尾逗号、`⚠ ——` 的破折号都因此凭空消失。残渣清理只走
      // `stripOnce` 的切除边界（贴着跨度的那一个逗号，见左邻 `，`/`、` 规则），
      // 不做「全文行尾标点一律抹掉」这种无差别重写。
      // 标点前的多余空白
      .replace(/[ \t]+([，,。、；：）)】」》])/g, '$1')
      // 空白收敛
      .replace(/[ \t]{2,}/g, ' ')
  )
}

/**
 * 对单文件内容找标签命中。返回 [{ line, name, match, text }]。
 */
export function findTagHits(content, { file = '', ext = '.ts', allowlist = ANCHOR_ALLOWLIST } = {}) {
  const hits = []
  for (const { line, text } of extractCommentLines(content, ext)) {
    if (isAllowlisted(file, text, allowlist)) continue
    for (const k of tagSpansOf(text)) {
      hits.push({ line, name: k.name, match: k.match, text: text.trim().slice(0, 120) })
    }
  }
  return hits
}

/** 收集待扫文件清单（src/** + 根配置）。 */
export function collectFiles(base = root) {
  const files = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!EXCLUDED_DIRS.has(name)) walk(p)
        continue
      }
      if (!SCAN_EXTS.has(name.slice(name.lastIndexOf('.')))) continue
      files.push(p)
    }
  }
  walk(join(base, 'src'))
  for (const f of ROOT_CONFIG_FILES) {
    try {
      statSync(join(base, f))
      files.push(join(base, f))
    } catch {
      /* 配置可缺席 */
    }
  }
  return files
}

/** 全库扫描。返回 [{ file, line, name, match, text }]（file 为相对仓库根的 POSIX 路径）。 */
export function scanRepo(base = root) {
  const all = []
  for (const abs of collectFiles(base)) {
    const rel = relative(base, abs).split(sep).join('/')
    let content
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const ext = abs.endsWith('.vue') ? '.vue' : abs.slice(abs.lastIndexOf('.'))
    for (const h of findTagHits(content, { file: rel, ext })) {
      all.push({ file: rel, ...h })
    }
  }
  return all
}

export function main() {
  const hits = scanRepo()
  if (hits.length) {
    console.error('源码注释门未过（comment-surface）：注释里出现批号标签 / 轮次 / 日期戳 / 评审史。')
    console.error('  纪律：注释只留约束、不变量、平台差与语义说明；修复史正本 = git 历史（commit message）。')
    let lastFile = ''
    for (const h of hits) {
      if (h.file !== lastFile) {
        console.error(`  ${h.file}`)
        lastFile = h.file
      }
      console.error(`    :${h.line} [${h.name}「${h.match}」] ${h.text}`)
    }
    console.error(`  共 ${hits.length} 处命中。承重锚注（被测试钉住、不得删改）经 ANCHOR_ALLOWLIST 登记。`)
    process.exit(1)
  }
  console.log(`check:comments 通过：src 与根配置注释零批号标签（扫描 ${collectFiles().length} 个文件）。`)
}

// 直跑判据走 pathToFileURL——argv[1] 可能是相对路径（`node scripts/check-comments.mjs`），
// 裸拼 `file://${argv[1]}` 与之不等，main() 会静默不执行（门形同虚设）。
// argv[1] 可缺席（node -e / REPL 动态 import），缺席即非直跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

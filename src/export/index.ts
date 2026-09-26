/**
 * 干净导出 —— 依据 #36 spec。
 *
 * 把定稿正文导出成多形态（单文件合并 / 分章），剥所有 front matter，
 * 产物落 `工作区/导出/`。
 *
 * 复用边界（#36 第 2.1/5 节）：
 * - 遍历复用 readChapterDir（不新写）
 * - 正文取法复用 frontmatter.readFile.body（readChapter 只返 meta）
 * - 排序按章号数值（不依赖文件名字符串序——定稿文件名不补零）
 * - 净化：每章 `# {标题}\n\n{body}`，完全不输出 front matter
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { atomicWriteFile, atomicWriteStream, renameWithRetry } from '../fs/atomic.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { readChapterDir, isPublishedValue } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { chapterFilePrefix } from '../format/words.js'
import { matchFenceLine } from '../format/fence.js'
import { readBookConfig } from '../format/yaml.js'
import { sanitizeFileNamePart, isMdFileName } from '../format/filename.js'
import { finalizedPathSet } from '../document/manifest.js'
import { docJoinKey } from '../fs/safe-path.js'
// （errMsg 收编）：错误摘要口径单源
import { errMsg } from '../log/index.js'
import {
  formatShortSubmissionView,
  scanShortCollection,
  SUBMISSION_TEMPLATES,
  type ShortSubmissionPlatform,
} from '../metrics/short-index.js'

/** 非 UTF-8 字节判定（与 document/service.ts isUtf8Bytes 同口径——
 *  TextDecoder fatal；就地声明避免把 document/service 整链拉进导出依赖图）。
 * 原插在 import 区之间，下移到全部
 *  import 之后（零行为变化）。 */
function isUtf8ExportBytes(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export type ExportFormat = 'merged' | 'split' | 'both'
/** 平台标识（配置化：查 SUBMISSION_TEMPLATES，未知平台 fallback generic）。 */
export type ExportPlatform = ShortSubmissionPlatform

export interface ExportOptions {
  /** 书仓库根 */
  bookRoot: string
  /** 导出形态（默认 both） */
  format?: ExportFormat
  /** 短篇投稿视图模板（长篇忽略） */
  platform?: ExportPlatform
}

export interface ExportResult {
  ok: boolean
  /** 导出的文件列表（相对书仓库的路径） */
  files: string[]
  /** 导出的章数 */
  chapterCount: number
  /** 导出对象单位 */
  unit: '章'
  /** 因未定稿被滤掉的章数（前端可提示） */
  skippedDrafts?: number
  /** 清偿-导出未过滤提示：定稿过滤是否实际生效。
   * 定稿清单缺失（finalizedPathSet → null）时导出兜底不过滤（宁多勿漏，
   * 哲学不动），但成功结果此前无任何标记（只在失败文案区分），作者可能拿
   *  含未定稿章的全本而不自知——补显式标记，服务端信封/前端 toast 透传展示。
   *  'applied' = 已按定稿清单过滤；'skipped-no-manifest' = 清单缺失未过滤（结果含未定稿章）。
   *  判定发生在正文扫描后（finalizedPathSet 读取处）：此前置失败路径（参数错/无章
   *  可扫）未达过滤阶段且零产物，值不参与语义，统一置 'applied' 保必填契约。 */
  finalizedFilter: 'applied' | 'skipped-no-manifest'
  /** 单章级问题（解析失败/正文为空被跳过）——个别坏章不再拖垮整本导出 */
  warnings?: string[]
  /** 错误信息 */
  error?: string
}

/** 导出单元（收集段产出、过滤/编号/写出段消费）——导出供分段直测。 */
export interface ExportUnit {
  num: number
  title: string
  path: string
  /** （阶段 24）：排序键 = fm `序` ?? 章号（缺省语义；无 序 旧书 = 章号，零漂移）。 */
  sortKey: number
  /** （阶段 24）：已发布判据（readChapterDir `_raw.已发布` 解析，B.4——导出侧
   *  现状不读 fm `已发布`，published 判定在 units 组装时带出）。 */
  published: boolean
  /** （阶段 24）：分流呈现号（排序后赋值）——已发布章固定本地章号；其后未发布段
   *  从「已发布最大章号+1」按 sortKey 序位连续编（留洞制：合并/拆分产生的章号空洞在
   *  投稿分章前缀上闭合）。仅分章文件名前缀消费；全本/投稿视图/文案引用维持本地章号。 */
  displayNum?: number
}

/**
 * 导出定稿正文（多形态 + 净化）。
 */

/** 净化正文：去首尾空白 + 过滤 #% 作者批注（§6 过渡期，导出不泄漏定稿批注）。
 * 行首整行批注与行中批注尾巴一并截掉；截断后行尾空白收敛，整行批注变空行
 *  则剔除，原空行保留（markdown 分段）。
 * E-9f：`#%` 截断收紧为确属内部批注形态才剥——①行首（含缩进后）；
 *  ②紧贴正文（`#` 前是非空白字符，即 AI 习惯的 `正文#%批注` 贴附写法）。
 *  `#` 前是空白的行中字面 `#%`（如 `达标线 #%=95%`）保留——无法与批注完全区分，
 *  保守只剥上述两种标记形态，正文合法字面序列不再误删。
 * markdown fenced 代码块（``` 围栏）内的 `#%` 是代码字面量
 *  （注释语法/字符串常量常见），围栏内整段跳过剥除——行级状态机跟踪 ``` 开闭。
 *  只处理 ``` fenced：~~~ 围栏与缩进代码块不扩大识别范围（定稿正文惯例 ```）。
 * 围栏行识别与机检 checkSectionCount 收编 format/fence 单源（CommonMark
 *  0-3 空格缩进）——缩进代码块（4+ 空格）内的 ``` 行不再误当围栏开关（此前
 *  trimStart 全缩进翻转，误开栏成对闭合时其间真实 `#%` 批注漏进导出稿）。
 * 围栏**未闭合**（奇数个 ``` 行/作者忘收口）时首遍
 *  状态机把其后全部行当「围栏内」整段跳过——作者批注从围栏行起成串泄漏进导出稿，
 *  「围栏内是代码字面量」的前提已不成立。两遍收口：首遍照常；末态仍在围栏内则对
 *  原文再跑一遍关围栏感知（围栏内 `#%` 也按批注剥）。权衡登记：坏围栏章节内的
 *  代码字面 `#%` 会被误剥——宁误剥字面不泄漏批注（批注可能含剧透/内部备注，
 *  代码字面截断只损失代码展示，二者不对等）。
 *  权衡登记（存留）：`正文 #% 批注`（# 前带空白的贴附写法）与正文字面 `#%` 无法
 * 区分，维持现状不剥（泄漏形态留待批注语法下线后随收口统一消除），避免误伤正文。
 *  -（全量代码）：行内多个 `#%` 时取**首个满足上述标记形态
 *  判定的出现位**截断——首处是保留的行中字面（`达标线 #%=95%`）不再掩护其后的紧贴
 *  真批注；全部出现位均不满足才整行保留（上条存留口径不变）。 */
/** CJK 字符类与「内容以 CJK 起」判定（批注形态收紧用）。
 *  覆盖：CJK 统一区/部首/注音假名（2E80-9FFF 含 3000-30FF）、谚文（1100-11FF、
 *  AC00-D7AF）、相容表意（F900-FAFF）、全角形式（FF00-FFEF）。 */
const CJK_CHAR_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/
/** `#%` 后允许前导空白再接 CJK（紧贴分支用：`x = 1#% 中文批注` 形态；`#%…` URL 片段不中）。 */
const CJK_LEAD_RE = /^\s*[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

function purifyBody(body: string): string {
  /** 单遍剥除。respectFence=false 时忽略围栏状态（未闭合回退遍用）。
   *  返回 unclosed = 遍历结束后仍处围栏内（有未闭合围栏）。 */
  const strip = (respectFence: boolean): { text: string; unclosed: boolean } => {
    let inFence = false
    const text = body
      .split('\n')
      .map((line) => {
        // fenced 代码块围栏行翻转状态；块内行原样保留（#% 是代码字面量非批注）
        // 围栏行识别收编 format/fence 单源（CommonMark 0-3 空格缩进口径，与
        // 机检 checkSectionCount 同源）——原 trimStart.startsWith('```') 对任意缩进
        // 翻转，缩进代码块（4+ 空格）内的 ``` 行被误当围栏开关，误开栏成对闭合时其
        // 间真实 `#%` 批注被当围栏内容整段保留漏进导出稿。只认反引号围栏（~~~ 不扩
        // 大识别范围口径不变）：单源只共享「围栏行识别」，开/闭栏语义两侧各自
        // 保留（机检侧同类同长才闭栏，本侧简单翻转）。
        if (respectFence) {
          const fence = matchFenceLine(line)
          if (fence !== null && fence.ch === '`') {
            inFence = !inFence
            return { keep: true, out: line }
          }
          if (inFence) return { keep: true, out: line }
        }
        if (line.trim() === '') return { keep: true, out: line } // 原空行保留（分段）
        // E-9f：仅内部标记形态才作为批注起点——①`#%` 前只有空白（含行首）
        // ②紧贴正文（前一个字符非空白，即 `正文#%批注` 贴附写法）。
        // `#` 前是空白但前面有正文的行中字面量保留。
        // ②由「前置非空白」收紧为「前置 CJK，或前置非空白且
        // 批注内容以 CJK 起」——AI 贴附批注的正文与批注内容均为中文；ASCII 紧贴
        // 且 ASCII 内容的 `#%`（URL 片段 `…/wiki/#%%88%86%%%BB`、代码字面
        // `a#%b`）不是批注，原「非空白即剥」把 URL 从 `#%` 起整段静默截断。
        // 内容判定只作用于紧贴分支：`#` 前带空白的行中字面（`达标线 #%=95%` /
        // `const a = 1 #% 松散字面`）维持 E-9f 登记口径一律保留；紧贴分支
        // 的 `x = 1#% 中文批注`（前置 ASCII、内容中文）仍按批注剥——宁误剥字面
        // 不泄漏批注的口径不回退。
        // -（全量代码）：遍历行内全部 `#%` 出现位，取**首个满足
        // 上述标记形态判定的位置**截断——只看首个出现位时，首处是保留的行中字面量
        // （`达标线 #%=95% 才放行正文甲#%批注`）会让整行原样保留，行内后续紧贴真批注
        // 泄入导出稿；全部出现位均不满足则整行保留（E-9f 存留口径不变）。
        let cut = -1
        for (let i = line.indexOf('#%'); i !== -1; i = line.indexOf('#%', i + 1)) {
          const marker =
            line.slice(0, i).trim() === '' ||
            (!/\s/.test(line[i - 1]!) && (CJK_CHAR_RE.test(line[i - 1]!) || CJK_LEAD_RE.test(line.slice(i + 2))))
          if (marker) {
            cut = i
            break
          }
        }
        // 截断行保留原行尾——replace(/\s+$/) 会把 \r 一并
        // 剥掉，CRLF 正文的截断行此前落成 LF 混行尾（保留行原样带 \r，口径对齐）
        const hadCr = line.endsWith('\r')
        const out = cut === -1 ? line : line.slice(0, cut).replace(/\s+$/, '') + (hadCr ? '\r' : '')
        return { keep: out.trim() !== '', out }
      })
      .filter((r) => r.keep)
      .map((r) => r.out)
      .join('\n')
      .trim()
    return { text, unclosed: inFence }
  }
  const first = strip(true)
  // 首遍末态仍处围栏内 = 存在未闭合围栏 → 按无围栏重剥（批注零泄漏优先）
  return first.unclosed ? strip(false).text : first.text
}

/** 净化文件名：替换路径分隔符为 _，杜绝 ../ 越出导出目录；超长截断（码位 + FF- 字节双封顶）。
 *  书名/章标题来自 book.yaml 与 frontmatter（不可信），拼文件名前须净化——
 *  AI 产出标题可任意长，超 255 字节文件名在 macOS/NTFS 直接写失败，整本导出被一章拖垮。
 *  FF-：APFS/ext4/NTFS 单段上限一律按 255 **UTF-8 字节**判（-mac适配
 *  勘误：原注「APFS 按码位判，本地恒绿会掩盖 CI 红」失实——APFS 同为 255 字节上限、
 *  无码位豁免；当前字节封顶 = 203B 名字预算 + 52B tmp 余量 = 255B，恰好贴线安全，行为不动）——
 *  码位封顶挡不住 4 字节字符（emoji 类 AI 标题 × 80 码位 = 320 字节），须再按字节截断；
 *  字节预算按各拼接点实际前后缀计算（分章序号 / 全本- / 投稿视图-平台后缀 长度不一），截断不切多字节字符。
 *  预算还须为原子写临时名让路：src/fs/atomic.ts 在同目录写 `.{名}.{pid}.{uuid}.tmp`
 *  （42B 固定 + pid 位数，Linux 上限 7 位 = 49B）——最终名贴着 255B 截断则临时名必超限，
 *  三平台均直接 ENAMETOOLONG，故预留 52B。预算含 tmp 后缀余量，未来放宽上限勿按码点算，
 *  须连 tmp 余量一并重新核账。 */
const FILENAME_MAX_CP = 80
const FILENAME_MAX_BYTES = 255 - 52

/** 导出目录内旧版归档子目录。 */
const OLD_EXPORT_DIR = '.旧版'

/** 导出目录内同名前缀的序号兜底名（扩展名前插 -N，撞名递推）——归档失败时本次产物
 *  改写入它，与分章目录的「分章-N」不覆写口径同族。 */
function nextFreeName(exportDir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 2
  while (existsSync(join(exportDir, `${stem}-${n}${ext}`))) n++
  return `${stem}-${n}${ext}`
}

/** 旧产物归档而非删除——移入 导出/.旧版/（不存在则创建），
 *  同名冲突追加序号后缀；任一步失败保留原文件不动（宁可残留不可销毁：作者手改过
 *  的导出稿（改书名/换平台后再导出）被 rmSync 静默销毁不可挽回）+ warnings 留痕。
 *  返回是否归档成功——调用方据此决定本次产物写原名还是序号兜底名（原名被占且归档
 *  不下时直接覆写即销毁手改稿，与「已保留原位」警告自相矛盾）。 */
function archiveOldExport(exportDir: string, oldName: string, warnings: string[]): boolean {
  try {
    const archiveDir = join(exportDir, OLD_EXPORT_DIR)
    mkdirSync(archiveDir, { recursive: true })
    // 同名冲突序号后缀插在扩展名前（全本-x.md → 全本-x-2.md）
    const dot = oldName.lastIndexOf('.')
    const stem = dot > 0 ? oldName.slice(0, dot) : oldName
    const ext = dot > 0 ? oldName.slice(dot) : ''
    let dstName = oldName
    let n = 2
    while (existsSync(join(archiveDir, dstName))) dstName = `${stem}-${n++}${ext}`
    // 归档 rename 收编 renameWithRetry——win 杀软/索引器
    // 瞬时锁（EPERM/EBUSY）不再直接滑进 warning 分支（3×50ms 退避；确定性错误仍走
    // catch 保留原位 + 提示手动移入，语义不变）
    renameWithRetry(join(exportDir, oldName), join(archiveDir, dstName))
    return true
  } catch (e) {
    // 通用-1：留痕补病因（e.message）——通用文案让作者无从判断
    // 失败原因（EACCES/EBUSY/…）；对齐本文件其余 catch 的 message 口径，语义不变
    warnings.push(`旧产物 ${oldName} 归档失败（${errMsg(e)}；已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）`)
    return false
  }
}

function sanitizeFileName(name: string, maxBytes: number): string {
  // 删除 sanitizeFileNamePart 之后的重复截断循环——后者已是单一
  // 真相源（非法字符 + win 尾点/保留名 + 码位/字节双预算后缀感知截断），外层逐字符
  // 循环行为恒等却构成漂移风险死码（改预算只改其一必分叉）。
  return sanitizeFileNamePart(name, FILENAME_MAX_CP, maxBytes) || '未命名'
}

/** （评审）：导出阶段结果——失败携错误文案（与该阶段原
 * 错误信封文案逐字一致）；写出段与投稿视图段另携已落盘产物快照（口径：
 *  split 项 ⟺ 已落盘、merged 名仅完整发布后列），其余阶段恒为 []。 */
type StageResult<T> = { ok: true; value: T } | { ok: false; error: string; files?: string[] }

/** 导出运行态——跨阶段共享的可变状态（警告留痕 / 产物表 / 写出计数与
 *  实际产出章号集）。行为面与拆分前的同名局部变量逐位等价（警告文案求值时机不变）。
 *  导出供分段直测（测试自建 run 驱动单段）。 */
export interface ExportRun {
  readonly bookRoot: string
  readonly warnings: string[]
  readonly files: string[]
  writtenCount: number
  /** 实际产出章号集——投稿视图按它对齐（原经定稿预滤天然排除空正文章） */
  readonly writtenNums: Set<number>
}

/** 备目录段产物（写出段的落点与命名口径）——导出供分段直测。 */
export interface ExportPlan {
  exportDir: string
  /** 全本产物名（同名归档不下时就地改写为序号兜底名——写出段读改写后的值，勿缓存旧名） */
  mergedFileName: string
  /** 分章产物目录名（归档失败时为「分章-N」；不覆写原目录） */
  splitTargetDirName: string
  doMerged: boolean
  doSplit: boolean
  /** 定稿过滤后的可导出单元（收集 → 过滤 → 编号三段的结果，写出段按此序产出） */
  filtered: ExportUnit[]
}

/** 相对书根的 posix 路径（win 的 relative() 产反斜杠，警告文案按 / 单源——）。 */
function relPosixIn(bookRoot: string, p: string): string {
  return relative(bookRoot, p).replace(/\\/g, '/')
}

/** 阶段一·收集：扫描定稿正文（统一 readChapterDir，递归卷结构）。
 * 不再 includeBody 一次读带出全部正文——极端大书（200 万字级）
 *  全部章正文 + 净化副本同时驻留内存可 OOM；改 meta-only 扫描，正文在写出段逐章现读
 * 即弃（读-写流水化，峰值降为单章级）。单个坏章（解析失败）不再拖垮整本导出
 *  ——记入 warnings 跳过，仍有可导章则继续。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段一）。 */
export function collectExportUnits(bookRoot: string, warnings: string[]): StageResult<{ units: ExportUnit[] }> {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, error: '没有定稿正文可导出。' }
  }
  const { chapters, errors } = readChapterDir(bodyDir)
  for (const e of errors) warnings.push(`${relPosixIn(bookRoot, e.file)}: ${e.message}`)
  // （阶段 24）：units 组装带出 sortKey（序 ?? 章号）与 published（_raw.已发布）——
  // readChapter 已将 `已发布` 容错落 _raw（中文键不在 KNOWN_FM_KEYS），经 isPublishedValue
  // 单源判定（与树 probe regex 同式）
  const units: ExportUnit[] = chapters.flatMap((ch) =>
    ch._path
      ? {
          num: ch.章号,
          title: ch.标题,
          path: ch._path,
          sortKey: ch.序 ?? ch.章号,
          published: isPublishedValue(ch._raw?.['已发布']),
        }
      : [],
  )
  if (units.length === 0 && warnings.length > 0) {
    return { ok: false, error: `章解析失败：${warnings.join('; ')}` }
  }
  if (units.length === 0) {
    return { ok: false, error: '没有定稿正文可导出。' }
  }
  return { ok: true, value: { units } }
}

/** 阶段二·过滤：「导出定稿正文」名要符实——滤掉从未定稿的章（manifest 无
 *  finalizedRevision；态7 流水线刚写出的在写章/坏 fm 草稿不再混进全本/分章/投稿视图）。
 * 判定收敛到 manifest.finalizedPathSet 单一真相（learn 收割同款，防两处漂移）。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段二）。 */
export function filterFinalizedUnits(
  bookRoot: string,
  units: ExportUnit[],
): {
  filtered: ExportUnit[]
  skippedDrafts: number
  finalizedFilter: ExportResult['finalizedFilter']
  finalizedPaths: Set<string> | null
} {
  const finalizedPaths = finalizedPathSet(bookRoot)
  // 定稿集身份折叠（win 大小写不敏感 FS 外部 case-only 改名后
  // 精确匹配失配，定稿章被当草稿跳过）；非 win 并非恒等——platformCaseFold（收编、
  // 折叠面扩 darwin）在 darwin 也折叠，仅 linux 恒等（mac适配
  // 注释勘误：原注「posix 恒等」失实，零行为变化）
  const finalizedKeys = finalizedPaths === null ? null : new Set([...finalizedPaths].map(docJoinKey)) // 升 docJoinKey（+NFC 归一）
  // 清偿-导出未过滤提示：过滤是否生效的显式标记（见
  // ExportResult.finalizedFilter 注）——自此以下各构造点（含失败信封）一律携带
  const finalizedFilter: ExportResult['finalizedFilter'] = finalizedPaths === null ? 'skipped-no-manifest' : 'applied'
  let skippedDrafts = 0
  const filtered: ExportUnit[] =
    finalizedPaths !== null
      ? units.filter((u) => {
          // relative() 在 Windows 产反斜杠而 manifest path 是正斜杠——
          // 不归一会把全部章误判未定稿、导出为空（对齐 state.ts 既有 slash 归一口径）
          if (finalizedKeys?.has(docJoinKey(relative(bookRoot, u.path)))) return true
          skippedDrafts++
          return false
        })
      : units
  return { filtered, skippedDrafts, finalizedFilter, finalizedPaths }
}

/** 阶段三·编号：按排序键数值排序（`序 ?? 章号`——不依赖文件名字符串序；tie 章号
 * 保稳定），随后分流编号。
 *  顺序不变量：编号按排序后序位——先排后编不可倒置。
 * （阶段 24）分流：已发布章固定本地章号，其后未发布段从「已发布最大章号+1」
 *  按 sortKey 序位连续编。全无已发布章时（旧书常态）从 1 连续编——无 `序` 且章号
 *  连续的旧书 displayNum ≡ num，零漂移；章号空洞（合并留洞）在分章前缀上闭合。
 * （作者指令「按建议顺序开工」）：displayNum 语义拍板维持
 * 已发布章号不可变优先于显示序单调（发布号是读者侧锚点）；已发布章不居
 * sortKey 序前时显示序非单调（[6,7,8,9,5,10] 形态源码 ⑰）系该语义的
 *  自然结论，接受不改。
 * 导出供分段直测（纯函数：排序 +编号，生产唯一调用点在 exportBook 阶段三）。 */
export function orderAndNumberUnits(filtered: ExportUnit[]): void {
  filtered.sort((a, b) => a.sortKey - b.sortKey || a.num - b.num)
  const maxPublished = filtered.reduce((m, u) => (u.published ? Math.max(m, u.num) : m), 0)
  let next = maxPublished + 1
  for (const u of filtered) u.displayNum = u.published ? u.num : next++
}

/** 写出段内部：逐章现读正文（frontmatter.readFile 单源，剥 fm 取 body）。
 *  返回 null = 读取失败/正文为空（已记 warnings，调用方跳过该章）。
 * 导出供分段直测（生产唯一调用点在 writeExportProducts）。 */
export function readUnitBody(bookRoot: string, u: ExportUnit, warnings: string[]): string | null {
  // 导出链补非 UTF-8 防线——save/finalize 链均有 isUtf8Bytes 闸
  //（document/service.ts:71 同款 TextDecoder fatal 口径），导出此前 utf-8 文本直读，
  // GBK 章产出 U+FFFD 乱码且零警告、照常计入 chapterCount。现按字节先验：非 UTF-8
  // 记警告按读取失败同口径跳过（源文件只读不动，作者转码后可再导出）。
  let bytes: Buffer
  try {
    bytes = readFileSync(u.path)
  } catch (e) {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文读取失败（${errMsg(e)}），已跳过`)
    return null
  }
  if (!isUtf8ExportBytes(bytes)) {
    warnings.push(
      `${relPosixIn(bookRoot, u.path)}: 正文不是 UTF-8 编码（如 GBK 旧档），导出会产生乱码，已跳过——请先转码为 UTF-8 再导出`,
    )
    return null
  }
  // 字节已验 UTF-8，toString 无损；复用同份内容走 readFile 解析（避免双读竞态）
  const r = readFile(u.path, bytes.toString('utf-8'))
  if (!r.ok) {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文读取失败（${r.error.message}），已跳过`)
    return null
  }
  // 判空改 trim 口径——全空白正文（纯空行/空白符，非空串）
  // 此前 `!r.body` 判不住，照常计入章数并在产物中产出空壳章节（分隔符 + 空段）。
  // 净化管线（stripAuthorNotes 后 trim）本就会把它打成空串，此处提前同口径拦截。
  if (r.body.trim() === '') {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文为空，已跳过`)
    return null
  }
  return r.body
}

export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, platform = 'generic' } = options
  const format = options.format ?? 'both'
  // 前置失败（未达定稿过滤阶段）信封单源——finalizedFilter
  // 恒 'applied'（值不参与语义，见 ExportResult.finalizedFilter 注）、无 skippedDrafts/
  // warnings 面。与下方 fail（过滤阶段后）分立：二者捕获的变量面不同，前置闭包不引用
  // 尚未声明的 warnings/finalizedFilter/skippedDrafts（TDZ）。
  const failEarly = (error: string): ExportResult => ({
    ok: false,
    files: [],
    chapterCount: 0,
    unit: '章',
    finalizedFilter: 'applied',
    error,
  })
  // format 入口校验——TS 类型上只可能是三合法值，但 API/worker 层透传
  // 任意 JSON 可达（运行期不受类型约束），非法值此前会让 doMerged/doSplit 双 false：
  // 全部章静默跳过写入，落到「零产出」收口误报「正文全部为空或读取失败」，病因完全
  // 错位（误导作者去查正文）。改入口显式参数错误返回（对齐本文件 {ok:false,error}
  // 错误信封形态），不做任何盘上操作。
  if (format !== 'merged' && format !== 'split' && format !== 'both') {
    // 前置失败未达过滤阶段（零产物，finalizedFilter 值不参与语义）
    return failEarly(`参数错误：format=${JSON.stringify(format)} 非法（只接受 merged / split / both）`)
  }
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  // 正文为空/读取失败的单章在写出段现读时判定（起正文不预读），
  // 记警告跳过，不再整本失败；零可写章按 writtenCount 收口
  const warnings: string[] = []

  // ── 阶段一·收集（拆段）──
  const collected = collectExportUnits(bookRoot, warnings)
  if (!collected.ok) return failEarly(collected.error)
  const units = collected.value.units

  // ── 阶段二·过滤 ──
  const { filtered, skippedDrafts, finalizedFilter, finalizedPaths } = filterFinalizedUnits(bookRoot, units)
  // 失败信封单源——下方 7 处 {ok:false, files, chapterCount:0,
  // unit:'章', finalizedFilter, skippedDrafts, ...(warnings), error} 同构字面量收编单行调用。
  // warnings/finalizedFilter/skippedDrafts 闭包捕获（求值时机 = 调用时刻，与原字面量一致）；
  // filesSnapshot 仅两处「已落盘产物回填」（口径：split 项 ⟺ 已落盘、merged 名仅
  // 完整发布后列）传当时 files 快照，其余恒 []。前置失败（过滤阶段前）走上方 failEarly。
  const fail = (error: string, filesSnapshot?: string[]): ExportResult => ({
    ok: false,
    files: filesSnapshot ?? [],
    chapterCount: 0,
    unit: '章',
    finalizedFilter,
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
    error,
  })
  const run: ExportRun = { bookRoot, warnings, files: [], writtenCount: 0, writtenNums: new Set() }
  if (filtered.length === 0) {
    return fail(`正文区共 ${units.length} 章均未定稿，没有可导出的定稿正文；请先在文档树中定稿。`)
  }

  // ── 阶段三·编号 ──
  orderAndNumberUnits(filtered)

  const doMerged = format === 'merged' || format === 'both'
  const doSplit = format === 'split' || format === 'both'
  // 读书名（用于合并文件名；book.yaml #9 格式）
  const bookTitle = cfg.ok && cfg.config.book.title ? cfg.config.book.title : '未命名'

  // ── 阶段四·备目录（母本 6.2 工作区/导出/）──
  const layout = prepareExportLayout({ bookRoot, bookTitle, doMerged, doSplit, warnings })
  if (!layout.ok) return fail(layout.error)
  const plan: ExportPlan = { ...layout.value, filtered }

  // ── 阶段五·写出（全本流式 / 分章逐章）──
  const wrote = writeExportProducts(run, plan)
  if (!wrote.ok) return fail(wrote.error, wrote.files)

  // 定稿章在册但全部空正文/读取失败 → 零产物，按失败收口（原实现经定稿预滤
  // （filtered）走同一信封；具体病因见 warnings 逐章留痕）。
  // 文案如实归因——到达此处时各章**均已定稿**（filtered 即定稿
  // 集），真实病因是空正文/读取失败；原「均未定稿，请先在文档树中定稿」误导作者去重
  // 复定稿操作。配合 publish 裁定，盘上亦无空壳产物残留。
  // 报数口径再收紧——units.length 是正文区全部章数，跳过草稿
  // （skippedDrafts>0）或无清单兜底（finalizedPaths===null）时按它报「有定稿章 N 章」
  // 会虚高（10 章仅 1 定稿且空 → 误报 10 章）。分口径如实表述：有定稿清单报定稿章数
  // （filtered.length，另注跳过的草稿数）；无清单兜底改说正文区全部章（未按定稿过滤）。
  if (run.writtenCount === 0) {
    const scope =
      finalizedPaths !== null
        ? `有定稿章 ${filtered.length} 章但正文全部为空或读取失败${skippedDrafts > 0 ? `（另有 ${skippedDrafts} 章未定稿已跳过）` : ''}`
        : `正文区 ${units.length} 章的正文全部为空或读取失败（未找到定稿清单，未按定稿过滤）`
    return fail(`${scope}，没有可导出的内容；逐章原因见 warnings。`)
  }

  // ── 阶段六·投稿视图（short 分支整体收编进错误信封——只包了
  // merged/split 写入，投稿视图的 scanShortCollection/readdirSync 清点/atomicWriteFile
  // 裸穿：磁盘满/目录并发删除时异常破坏 {ok:false} 契约、worker 形态丢 warnings 上下文）──
  if (kind === 'short') {
    const view = writeSubmissionView({
      bookRoot,
      exportDir: plan.exportDir,
      cfg,
      bookTitle,
      platform,
      writtenNums: run.writtenNums,
      warnings,
      files: run.files,
    })
    if (!view.ok) return fail(view.error, view.files)
  }

  return {
    ok: true,
    files: run.files,
    chapterCount: run.writtenCount,
    unit: '章',
    // 清偿-导出未过滤提示：成功面核心消费点——清单缺失
    // （skipped-no-manifest）时前端据此明示「本次导出未按定稿过滤（含未定稿章）」
    finalizedFilter,
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** 阶段四·备目录：导出目录创建 + 同名旧产物归档清位 + 分章目录归档重建。
 *  顺序不变量（勿调换）：①目录先建——其后全部产物写在其下；②清旧只归档「其它名字」
 *  的过期产物——当前同名的保护留给写出段「先归档再覆盖 / 归档不下改序号」单点
 * 清旧失败不阻断导出（清的是别名产物，留在原位不构成覆写）；
 * ③分章目录归档失败 → 本次产物写「分章-N」新目录（不覆写原目录——目录被
 *  编辑器/Word 占用正是 win 上整目录 rename 最常失败的场景）。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段四）。 */
export function prepareExportLayout(args: {
  bookRoot: string
  bookTitle: string
  doMerged: boolean
  doSplit: boolean
  warnings: string[]
}): StageResult<Omit<ExportPlan, 'filtered'>> {
  const { bookRoot, bookTitle, doMerged, doSplit, warnings } = args
  const exportDir = join(bookRoot, '工作区', '导出')
  // 目录创建位于主信封 try 之外——工作区只读/EROFS/EACCES 时裸异常
  // 上抛，worker 形态变 500 且丢 chapterCount/warnings，违背确立的
  // {ok:false} 信封契约。mkdir 结果被后续清旧/分章目录准备依赖、无法并入主 try，
  // 本地收编同款错误信封（口径照抄的 short 分支收编写法）。
  try {
    mkdirSync(exportDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `导出写入失败：${errMsg(e)}` }
  }

  let mergedFileName = ''
  if (doMerged) {
    mergedFileName = `全本-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength('全本-') - Buffer.byteLength('.md'))}.md`
    // 书改名/字节截断形变后，旧「全本-旧书名.md」残留在导出目录里会让作者
    // 拿错稿——同前缀其余文件视为过期产物归档清位（归档不删，清旧失败不阻断导出）
    // readdirSync 清点同在主信封 try 之外——导出目录被并发删/
    // EACCES 时裸异常上抛破坏 {ok:false} 信封契约（同上方 mkdir 收编口径，口径照抄）。
    // 清旧循环里归档失败是安全的——清的是「其它名字」的过期产物，归档
    // 不下就留在原位，本次写的是另一个名字，不存在覆写；故此处不比照写入点做兜底改名。
    try {
      for (const old of readdirSync(exportDir)) {
        // .md 判定改 isMdFileName（大小写不敏感）——.MD 家族漏网点
        if (old.startsWith('全本-') && isMdFileName(old) && old !== mergedFileName) {
          archiveOldExport(exportDir, old, warnings)
        }
      }
    } catch (e) {
      return { ok: false, error: `导出写入失败：${errMsg(e)}` }
    }
  }

  // 分章导出目录准备：旧目录先归档再重建（原 rmSync 整删与「归档
  //    不删」哲学相悖——作者手改过 分章/ 内单章稿后再导出即被静默销毁不可挽回；
  //    对齐 archiveOldExport：整目录 rename 进 导出/.旧版/分章[-N]/，归档失败保留
  //    原目录记 warnings 继续导（宁可残留不可销毁））
  // 归档失败分支不再允许新产物同名覆写原目录——目录被占用
  //    （编辑器/Word 开着导出稿）正是 win 上 rename 整目录搬迁最常失败的场景，随后
  //    writeSplit 的同名 atomicWriteFile 会把作者手改稿替换掉且无 .旧版 副本，与
  //    「已保留原位」警告自相矛盾。改：本次产物写入带序号新目录（分章-N）。
  let splitTargetDirName = '分章'
  if (doSplit) {
    const splitDir = join(exportDir, '分章')
    if (existsSync(splitDir)) {
      try {
        const archiveDir = join(exportDir, OLD_EXPORT_DIR)
        mkdirSync(archiveDir, { recursive: true })
        let dstName = '分章'
        let n = 2
        while (existsSync(join(archiveDir, dstName))) dstName = `分章-${n++}`
        // 分章目录归档同族收编 renameWithRetry（win 瞬时锁退避；确定性错误仍走
        // catch 改写带序号新目录「不覆写原目录」语义不变）
        renameWithRetry(splitDir, join(archiveDir, dstName))
      } catch {
        let n = 2
        while (existsSync(join(exportDir, `分章-${n}`))) n++
        splitTargetDirName = `分章-${n}`
        warnings.push(
          `分章目录归档失败（原目录已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）；本次产物改写入 ${splitTargetDirName}/，不覆写原目录`,
        )
      }
    }
    // 连带（代理范围外上报、主评审收口）：分章目录重建 mkdir 同在主信封
    // try 之外（EROFS/EACCES 裸抛破坏 {ok:false} 信封契约）——与上方母本目录/清旧
    // 两处同族同款本地收编（口径照抄）。
    try {
      mkdirSync(join(exportDir, splitTargetDirName), { recursive: true })
    } catch (e) {
      return { ok: false, error: `导出写入失败：${errMsg(e)}` }
    }
  }
  return { ok: true, value: { exportDir, mergedFileName, splitTargetDirName, doMerged, doSplit } }
}
/** 阶段五内部·分章单章写出：前缀/文件名净化 + 撞名序号判定 + 规范化写 + 产物登记。
 * 单章写入失败带上章上下文重抛——外层收编为 {ok:false}。
 * 导出供分段直测（生产唯一调用点在 writeExportProducts）。 */
export function writeSplitUnit(
  run: ExportRun,
  plan: ExportPlan,
  splitUsed: Set<string>,
  unit: { num: number; title: string; path: string; displayNum?: number },
  body: string,
): void {
  try {
    // （阶段 24）：分章前缀走 displayNum（分流）+ chapterFilePrefix 单源收编
    //（原内联 padStart(4) 未走写侧单源家族）；文案章号引用维持本地章号。
    const display = unit.displayNum ?? unit.num
    const prefix = chapterFilePrefix(display, 'chapter')
    const baseName = sanitizeFileName(
      unit.title,
      FILENAME_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength('.md'),
    )
    // 同章号+同标题（手工复制备份 / 网盘同步副本「xxx 2.md」形态）撞名——
    // 此前 atomicWriteFile 直写同路径幂等替换，chapterCount 与 files 却计两次，两章只
    // 留一章且无提示；改为追加序号后缀保双份并计入 warnings，作者可手动取舍。
    const fileName = `${prefix}${baseName}.md`
    // 平台：导出产物规范形写（正文源自库内章，CRLF 存量可携 \r 残尾——归一后
    // 两台机器的导出产物字节一致，作者侧 diff/比对有基准）
    const payloadOf = (title: string, body: string): string => canonicalizeText(`# ${title}\n\n${body}`)
    // 撞名/非撞名两分支重复的 atomicWriteFile+files.push
    // 合并单点写——名单先算定（finalName），写盘与登记只写一份
    let finalName = fileName
    if (splitUsed.has(fileName)) {
      let n = 2
      while (splitUsed.has(`${prefix}${baseName}-${n}.md`)) n++
      finalName = `${prefix}${baseName}-${n}.md`
      run.warnings.push(
        `分章 ${unit.num}「${unit.title}」与已导出产物撞名，已另存为 ${finalName}——若为同名重复章请手动核对/清理`,
      )
    }
    splitUsed.add(finalName)
    atomicWriteFile(join(plan.exportDir, plan.splitTargetDirName, finalName), payloadOf(unit.title, body))
    run.files.push(`工作区/导出/${plan.splitTargetDirName}/${finalName}`)
  } catch (e) {
    // 分章单章写入失败带上章上下文重抛——外层收编为 {ok:false}
    throw new Error(`分章 ${unit.num}「${unit.title}」写入失败：${errMsg(e)}`)
  }
}

/** 阶段五·写出：全本（单遍流式，内存闸审计不再物化 purified 全书
 *  数组与 `join('\n\n---\n\n')` 整书大串，逐章净化即写即弃，峰值降为单章级，产物字节
 *  与物化实现逐一恒等）+ 分章逐章原子写。
 * 写入期异常（分章经 merged 流式回调或 split 循环抛出、
 *  atomicWriteStream 自身失败）不再裸穿透 exportBook——库形态信封契约是 {ok:false}，
 *  裸异常在服务端直接打到 500 兜底面且丢 chapterCount/warnings 上下文。收编时全本
 *  尚在 tmp 未发布（atomicWriteStream 自清理），分章半产物由下次导出整目录归档清位。
 *  （§四.9）：错误信封回填已落盘产物——原 `files: []`
 *  清零让 merged+split 双模式中途失败时盘上已落的部分产物无列表（调用方/作者无从
 *  核对半产物）。回填累积的 files：split 项 push 紧随成功 atomicWriteFile 之后 ⟺
 *  已落盘；merged 名仅在 atomicWriteStream 完整发布后 unshift（中途失败 tmp 自
 *  清理、目标不在盘），不虚列。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段五）。 */
export function writeExportProducts(run: ExportRun, plan: ExportPlan): StageResult<null> {
  // splitUsed 原声明在 writeSplit 闭包定义之后（仅靠「闭包实际调用
  // 晚于声明执行」侥幸不触发 TDZ）——结构脆弱：后续在声明执行前新增任何 writeSplit
  // 调用即 ReferenceError；声明保持在产出闭包之前，消除对调用时序的隐式依赖（行为不变）。
  const splitUsed = new Set<string>() // 分章产物文件名占用集（撞名序号判定）
  const { warnings, files } = run
  try {
    if (plan.doMerged) {
      let first = true
      // 同名产物先归档再覆盖——上方清旧循环只归档「其它名字」，
      // 当前同名被跳过后被 atomicWriteStream 直接覆盖；作者手改过的导出稿（
      // 分章侧已定性「不可挽回」）就此静默销毁。
      // （1.0 前质量）：归档失败不再覆写——原实现归档失败仍照常
      // rename 覆盖原名，warnings 却写「已保留原位，请手动移入 .旧版/」，警告与事实
      // 相反（作者按提示去找的稿已被销毁）。改：归档未成 → 本次产物写序号兜底名，
      // 与分章目录「分章-N 不覆写原目录」同口径。
      if (
        existsSync(join(plan.exportDir, plan.mergedFileName)) &&
        !archiveOldExport(plan.exportDir, plan.mergedFileName, warnings)
      ) {
        const fallback = nextFreeName(plan.exportDir, plan.mergedFileName)
        warnings.push(`本次产物改写入 ${fallback}，不覆写原产物`)
        plan.mergedFileName = fallback
      }
      atomicWriteStream(
        join(plan.exportDir, plan.mergedFileName),
        (append) => {
          for (const unit of plan.filtered) {
            const raw = readUnitBody(run.bookRoot, unit, warnings)
            if (raw === null) continue // 读取失败/空正文：警告已记，跳过（不出分隔符）
            const body = purifyBody(raw)
            if (!first) append('\n\n---\n\n')
            first = false
            // 平台：全本产物规范形写（同分章/投稿视图收口）
            append(canonicalizeText(`# ${unit.title}\n\n${body}`))
            if (plan.doSplit) writeSplitUnit(run, plan, splitUsed, unit, body)
            run.writtenCount++
            run.writtenNums.add(unit.num)
          }
        },
        // 发布裁定——零成功章时全本文件连空壳都不落盘（原口径
        // 空 `全本-*.md` 照常 rename 落盘后才在下方按失败收口，盘上残留空产物）
        { publish: () => run.writtenCount > 0 },
      )
      if (run.writtenCount > 0) files.unshift(`工作区/导出/${plan.mergedFileName}`)
    } else if (plan.doSplit) {
      for (const unit of plan.filtered) {
        const raw = readUnitBody(run.bookRoot, unit, warnings)
        if (raw === null) continue
        writeSplitUnit(run, plan, splitUsed, unit, purifyBody(raw))
        run.writtenCount++
        run.writtenNums.add(unit.num)
      }
    }
    return { ok: true, value: null }
  } catch (e) {
    return { ok: false, error: `导出写入失败：${errMsg(e)}`, files }
  }
}

/** 阶段六·投稿视图（短篇书专属）：旧产物清点归档 + 同名先归档再覆盖（归档不下改序号
 *  兜底名，与全本侧同口径）+ 规范形写。写失败时 merged/split 产物均已完整落盘，错误
 * 信封回填累积的 files（同族收口）。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段六）。 */
export function writeSubmissionView(args: {
  bookRoot: string
  exportDir: string
  cfg: ReturnType<typeof readBookConfig>
  bookTitle: string
  platform: ExportPlatform
  writtenNums: ReadonlySet<number>
  warnings: string[]
  files: string[]
}): StageResult<null> {
  const { bookRoot, exportDir, cfg, bookTitle, platform, writtenNums, warnings, files } = args
  try {
    // 文件名与内容标题一致：非 generic 平台带模板 label（多平台产物不互相覆盖）
    const submissionNameOf = (p: string, label: string | undefined): string => {
      const suffix = label && p !== 'generic' ? `-${label}` : ''
      return `投稿视图-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength(`投稿视图-${suffix}.md`))}${suffix}.md`
    }
    const submissionName = submissionNameOf(platform, SUBMISSION_TEMPLATES[platform]?.label)
    // 实际写入名——归档失败时改序号兜底名（同 merged 侧口径），
    // 故此处可变，且下方清旧循环仍以「原名」为当前名保护（清的是其它名字的过期产物）。
    let targetName = submissionName
    // 低级项：投稿视图旧产物清理（对齐「全本-」口径）——书改名后旧
    // 「投稿视图-旧名…」残留会让作者拿错稿。管线：平台槽位归属由
    // 「尾部 endsWith 平台后缀」猜测改为「当前书名 + 各平台后缀」精确名保护——
    // 书名恰以「-公众号」等 label 结尾时，generic 旧产物会被误认成其他平台产物
    // 永不清；其他平台的旧书名残留同样是拿错稿风险，一并清（只精确保留各平台
    // 当前书名的最新产物）
    const protectedNames = new Set(
      Object.entries(SUBMISSION_TEMPLATES)
        .filter(([k]) => k !== platform)
        .map(([k, t]) => submissionNameOf(k, t.label)),
    )
    for (const old of readdirSync(exportDir)) {
      // 同上 isMdFileName 口径
      if (!old.startsWith('投稿视图-') || !isMdFileName(old) || old === submissionName) continue
      if (protectedNames.has(old)) continue
      // 旧产物归档不删（作者手改过的投稿稿不可静默销毁）
      archiveOldExport(exportDir, old, warnings)
    }
    // 投稿视图同口径滤未定稿（entries 按实际产出章号对齐）
    const entries = scanShortCollection(bookRoot).filter((e) => writtenNums.has(e.num))
    // 同名投稿视图先归档再覆盖（与 merged 同族修法哲学补齐）
    // 归档失败改序号兜底名，不覆写（同 merged 侧口径）
    if (existsSync(join(exportDir, submissionName)) && !archiveOldExport(exportDir, submissionName, warnings)) {
      targetName = nextFreeName(exportDir, submissionName)
      warnings.push(`本次产物改写入 ${targetName}，不覆写原产物`)
    }
    // 平台：投稿视图规范形写（同分章产物收口）
    atomicWriteFile(
      join(exportDir, targetName),
      canonicalizeText(formatShortSubmissionView(entries, cfg.ok ? cfg.config.short : undefined, bookTitle, platform)),
    )
    files.push(`工作区/导出/${targetName}`)
    return { ok: true, value: null }
  } catch (e) {
    return { ok: false, error: `导出写入失败：${errMsg(e)}`, files }
  }
}

/**
 * 干净导出 —— 依据 M7 #36 spec。
 *
 * 把定稿正文导出成多形态（单文件合并 / 分章），剥所有 front matter，
 * 产物落 `工作区/导出/`。
 *
 * 复用边界（#36 第 2.1/5 节）：
 * - 遍历复用 M1 readChapterDir（不新写）
 * - 正文取法复用 frontmatter.readFile().body（readChapter 只返 meta）
 * - 排序按章号数值（不依赖文件名字符串序——定稿文件名不补零）
 * - 净化：每章 `# {标题}\n\n{body}`，完全不输出 front matter
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join, relative } from 'node:path'
import { atomicWriteFile, atomicWriteStream } from '../fs/atomic.js'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { readBookConfig } from '../format/yaml.js'
import { sanitizeFileNamePart } from '../format/filename.js'
import { finalizedPathSet } from '../document/manifest.js'
import {
  formatShortSubmissionView,
  scanShortCollection,
  SUBMISSION_TEMPLATES,
  type ShortSubmissionPlatform,
} from '../metrics/short-index.js'

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
  /** 因未定稿被滤掉的章数（V-P2-2，前端可提示） */
  skippedDrafts?: number
  /** X-P2-4：单章级问题（解析失败/正文为空被跳过）——个别坏章不再拖垮整本导出 */
  warnings?: string[]
  /** 错误信息 */
  error?: string
}

interface ExportUnit {
  num: number
  title: string
  path: string
}

/**
 * 导出定稿正文（多形态 + 净化）。
 */

/** 净化正文：去首尾空白 + 过滤 #% 作者批注（W0 §6 过渡期，导出不泄漏定稿批注）。
 *  P3-14：行首整行批注与行中批注尾巴一并截掉；截断后行尾空白收敛，整行批注变空行
 *  则剔除，原空行保留（markdown 分段）。
 *  E-9f（第五十三轮）：`#%` 截断收紧为确属内部批注形态才剥——①行首（含缩进后）；
 *  ②紧贴正文（`#` 前是非空白字符，即 AI 习惯的 `正文#%批注` 贴附写法）。
 *  `#` 前是空白的行中字面 `#%`（如 `达标线 #%=95%`）保留——无法与批注完全区分，
 *  保守只剥上述两种标记形态，正文合法字面序列不再误删。
 *  N-6（第五十四轮）：markdown fenced 代码块（``` 围栏）内的 `#%` 是代码字面量
 *  （注释语法/字符串常量常见），围栏内整段跳过剥除——行级状态机跟踪 ``` 开闭。
 *  只处理 ``` fenced：~~~ 围栏与缩进代码块不扩大识别范围（定稿正文惯例 ```）。
 *  权衡登记：`正文 #% 批注`（# 前带空白的贴附写法）与正文字面 `#%` 无法区分，
 *  维持现状不剥（泄漏形态留待批注语法下线后随 W0 收口统一消除），避免误伤正文。 */
function purifyBody(body: string): string {
  let inFence = false
  return body
    .split('\n')
    .map((line) => {
      // N-6：fenced 代码块围栏行翻转状态；块内行原样保留（#% 是代码字面量非批注）
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence
        return { keep: true, out: line }
      }
      if (inFence) return { keep: true, out: line }
      if (line.trim() === '') return { keep: true, out: line } // 原空行保留（分段）
      // E-9f：仅内部标记形态才作为批注起点——①`#%` 前只有空白（含行首）；
      // ②紧贴正文（前一个字符非空白，即 `正文#%批注` 贴附写法）。
      // `#` 前是空白但前面有正文的行中字面量保留。
      const i = line.indexOf('#%')
      const isMarker = i !== -1 && (line.slice(0, i).trim() === '' || !/\s/.test(line[i - 1]!))
      const out = !isMarker ? line : line.slice(0, i).replace(/\s+$/, '')
      return { keep: out.trim() !== '', out }
    })
    .filter((r) => r.keep)
    .map((r) => r.out)
    .join('\n')
    .trim()
}

/** 净化文件名：替换路径分隔符为 _，杜绝 ../ 越出导出目录；超长截断（X-P2-4 码位 + FF-F3 字节双封顶）。
 *  书名/章标题来自 book.yaml 与 frontmatter（不可信），拼文件名前须净化——
 *  AI 产出标题可任意长，超 255 字节文件名在 macOS/NTFS 直接写失败，整本导出被一章拖垮。
 *  FF-F3：ext4/NTFS 单段上限按 255 **字节**判（APFS 按码位判，本地恒绿会掩盖 CI 红）——
 *  码位封顶挡不住 4 字节字符（emoji 类 AI 标题 × 80 码位 = 320 字节），须再按字节截断；
 *  字节预算按各拼接点实际前后缀计算（分章序号 / 全本- / 投稿视图-平台后缀 长度不一），截断不切多字节字符。
 *  预算还须为原子写临时名让路：src/fs/atomic.ts 在同目录写 `.{名}.{pid}.{uuid}.tmp`
 *  （42B 固定 + pid 位数，Linux 上限 7 位 = 49B）——最终名贴着 255B 截断则临时名必超限，
 *  ext4 直接 ENAMETOOLONG（APFS 按码位判，本地恒绿会再次掩盖 CI 红），故预留 52B。 */
const FILENAME_MAX_CP = 80
const FILENAME_MAX_BYTES = 255 - 52

/** 导出目录内旧版归档子目录（R65-27）。 */
const OLD_EXPORT_DIR = '.旧版'

/** R65-27（第六十五轮）：旧产物归档而非删除——移入 导出/.旧版/（不存在则创建），
 *  同名冲突追加序号后缀；任一步失败保留原文件不动（宁可残留不可销毁：作者手改过
 *  的导出稿（改书名/换平台后再导出）被 rmSync 静默销毁不可挽回）+ warnings 留痕。 */
function archiveOldExport(exportDir: string, oldName: string, warnings: string[]): void {
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
    renameSync(join(exportDir, oldName), join(archiveDir, dstName))
  } catch {
    warnings.push(`旧产物 ${oldName} 归档失败（已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）`)
  }
}

function sanitizeFileName(name: string, maxBytes: number): string {
  // R72-9（二十轮 C-7）：删除 sanitizeFileNamePart 之后的重复截断循环——后者已是单一
  // 真相源（非法字符 + win 尾点/保留名 + 码位/字节双预算后缀感知截断），外层逐字符
  // 循环行为恒等却构成漂移风险死码（改预算只改其一必分叉）。
  return sanitizeFileNamePart(name, FILENAME_MAX_CP, maxBytes) || '未命名'
}

export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, platform = 'generic' } = options
  const format = options.format ?? 'both'
  // C-9（二十九轮）：format 入口校验——TS 类型上只可能是三合法值，但 API/worker 层透传
  // 任意 JSON 可达（运行期不受类型约束），非法值此前会让 doMerged/doSplit 双 false：
  // 全部章静默跳过写入，落到「零产出」收口误报「正文全部为空或读取失败」，病因完全
  // 错位（误导作者去查正文）。改入口显式参数错误返回（对齐本文件 {ok:false,error}
  // 错误信封形态），不做任何盘上操作。
  if (format !== 'merged' && format !== 'split' && format !== 'both') {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      error: `参数错误：format=${JSON.stringify(format)} 非法（只接受 merged / split / both）`,
    }
  }
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 扫描定稿正文（统一 readChapterDir，递归卷结构）。R73-37（二十一轮）：不再
  // includeBody 一次读带出全部正文——极端大书（200 万字级）全部章正文 + 净化副本同时
  // 驻留内存可 OOM；改 meta-only 扫描，正文在下方写循环内逐章现读即弃（读-写流水化，
  // 峰值降为单章级，对齐 5+6 步「单遍流式」注释口径）。
  if (!existsSync(bodyDir)) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }
  // X-P2-4：单个坏章（解析失败）不再拖垮整本导出——记入 warnings 跳过，仍有可导章则继续
  const warnings: string[] = []
  const { chapters, errors } = readChapterDir(bodyDir)
  for (const e of errors) warnings.push(`${relative(bookRoot, e.file)}: ${e.message}`)
  const units: ExportUnit[] = chapters.flatMap((ch) =>
    ch._path ? [{ num: ch.章号, title: ch.标题, path: ch._path }] : [],
  )
  if (units.length === 0 && warnings.length > 0) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: `章解析失败：${warnings.join('; ')}` }
  }
  if (units.length === 0) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }

  // V-P2-2：「导出定稿正文」名要符实——滤掉从未定稿的章（manifest 无 finalizedRevision；
  // 态7 流水线刚写出的在写章/坏 fm 草稿不再混进全本/分章/投稿视图）。
  // 判定收敛到 manifest.finalizedPathSet 单一真相（learn 收割 H-1 同款，防两处漂移）
  const finalizedPaths = finalizedPathSet(bookRoot)
  let skippedDrafts = 0
  const filtered: ExportUnit[] =
    finalizedPaths !== null
      ? units.filter((u) => {
          // RB-KN-P2-3：relative() 在 Windows 产反斜杠而 manifest path 是正斜杠——
          // 不归一会把全部章误判未定稿、导出为空（对齐 state.ts 既有 slash 归一口径）
          if (finalizedPaths.has(relative(bookRoot, u.path).replace(/\\/g, '/'))) return true
          skippedDrafts++
          return false
        })
      : units
  // X-P2-4：正文为空/读取失败的单章在写循环内现读时判定（R73-37 起正文不预读），
  // 记警告跳过，不再整本失败；零可写章在下方按 writtenCount 收口
  const exportable: ExportUnit[] = filtered
  /** R73-37：逐章现读正文（frontmatter.readFile 单源，剥 fm 取 body）。
   *  返回 null = 读取失败/正文为空（已记 warnings，调用方跳过该章）。 */
  const readUnitBody = (u: ExportUnit): string | null => {
    const r = readFile(u.path)
    if (!r.ok) {
      warnings.push(`${relative(bookRoot, u.path)}: 正文读取失败（${r.error.message}），已跳过`)
      return null
    }
    if (!r.body) {
      warnings.push(`${relative(bookRoot, u.path)}: 正文为空，已跳过`)
      return null
    }
    return r.body
  }
  if (exportable.length === 0) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `正文区共 ${units.length} 章均未定稿，没有可导出的定稿正文；请先在文档树中定稿。`,
    }
  }

  // 2. 按章号数值排序（不依赖文件名字符串序）
  exportable.sort((a, b) => a.num - b.num)

  // 3. 准备导出目录（母本 6.2 工作区/导出/）
  const exportDir = join(bookRoot, '工作区', '导出')
  // R74-2（二十二轮）：目录创建位于主信封 try 之外——工作区只读/EROFS/EACCES 时裸异常
  // 上抛，worker 形态变 500 且丢 chapterCount/warnings，违背 R67-10/R70-4 确立的
  // {ok:false} 信封契约。mkdir 结果被后续清旧/分章目录准备依赖、无法并入主 try，
  // 本地 try 收编同款错误信封（口径照抄 R70-4 的 short 分支收编写法）。
  try {
    mkdirSync(exportDir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `导出写入失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  // 4. 读书名（用于合并文件名；book.yaml #9 格式）
  let bookTitle = '未命名'
  if (cfg.ok && cfg.config.book.title) {
    bookTitle = cfg.config.book.title
  }

  const files: string[] = []
  const doMerged = format === 'merged' || format === 'both'
  const doSplit = format === 'split' || format === 'both'

  // 5. 单文件合并：全本-<书名>.md
  // 5+6. 单遍流式导出（内存闸 2026-08-24 审计 A1）：不再物化 purified 全书数组与
  //  `join('\n\n---\n\n')` 整书大串（原峰值 ≈4-6× 全书体积，200 万字书几十 MB
  //  多份并存）——逐章净化即写即弃，merged 经 atomicWriteStream 追加写、split 逐章
  //  原子写，峰值降为单章级；产物字节与原实现逐一恒等（同段同序同分隔符）。
  let mergedFileName = ''
  if (doMerged) {
    mergedFileName = `全本-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength('全本-') - Buffer.byteLength('.md'))}.md`
    // 第五轮：书改名/字节截断形变后，旧「全本-旧书名.md」残留在导出目录里会让作者
    // 拿错稿——同前缀其余文件视为过期产物归档清位（R65-27：归档不删，清旧失败不阻断导出）
    // R74-2（二十二轮）：readdirSync 清点同在主信封 try 之外——导出目录被并发删/
    // EACCES 时裸异常上抛破坏 {ok:false} 信封契约（同上方 mkdir 收编口径，口径照抄 R70-4）。
    try {
      for (const old of readdirSync(exportDir)) {
        if (old.startsWith('全本-') && old.endsWith('.md') && old !== mergedFileName) {
          archiveOldExport(exportDir, old, warnings)
        }
      }
    } catch (e) {
      return {
        ok: false,
        files: [],
        chapterCount: 0,
        unit: '章',
        skippedDrafts,
        ...(warnings.length > 0 ? { warnings } : {}),
        error: `导出写入失败：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  // 6. 分章导出目录准备：旧目录先归档再重建（R67-1：原 rmSync 整删与 R65-27「归档
  //    不删」哲学相悖——作者手改过 分章/ 内单章稿后再导出即被静默销毁不可挽回；
  //    对齐 archiveOldExport：整目录 rename 进 导出/.旧版/分章[-N]/，归档失败保留
  //    原目录记 warnings 继续导（宁可残留不可销毁），新产物照常覆写）
  if (doSplit) {
    const splitDir = join(exportDir, '分章')
    if (existsSync(splitDir)) {
      try {
        const archiveDir = join(exportDir, OLD_EXPORT_DIR)
        mkdirSync(archiveDir, { recursive: true })
        let dstName = '分章'
        let n = 2
        while (existsSync(join(archiveDir, dstName))) dstName = `分章-${n++}`
        renameSync(splitDir, join(archiveDir, dstName))
      } catch {
        warnings.push(`分章目录归档失败（已保留原位，请手动移入 ${OLD_EXPORT_DIR}/）`)
      }
    }
    // R74-2 连带（批 B 代理范围外上报、主评审收口）：分章目录重建 mkdir 同在主信封
    // try 之外（EROFS/EACCES 裸抛破坏 {ok:false} 信封契约）——与上方母本目录/清旧
    // 两处同族同款本地收编（口径照抄 R70-4）。
    try {
      mkdirSync(splitDir, { recursive: true })
    } catch (e) {
      return {
        ok: false,
        files: [],
        chapterCount: 0,
        unit: '章',
        skippedDrafts,
        ...(warnings.length > 0 ? { warnings } : {}),
        error: `导出写入失败：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
  // R66-23（十四轮）：splitUsed 原声明在 writeSplit 闭包定义之后（仅靠「闭包实际调用
  // 晚于声明执行」侥幸不触发 TDZ）——结构脆弱：后续在声明执行前新增任何 writeSplit
  // 调用即 ReferenceError；声明上移到闭包定义之前，消除对调用时序的隐式依赖（行为不变）。
  const splitUsed = new Set<string>() // R62-15：分章产物文件名占用集（撞名序号判定）
  const writeSplit = (unit: { num: number; title: string; path: string }, body: string): void => {
   try {
    // R69-22（十七轮）：3 位 → 4 位，与正文写侧章文件名（format/words.ts 4 位）对齐
    //——长篇分章产物 005-x.md 与源 0005-x.md 命名族分裂（纯观感，分章为终端产物无下游）。
    const prefix = `${String(unit.num).padStart(4, '0')}-`
    const baseName = sanitizeFileName(unit.title, FILENAME_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength('.md'))
    // R62-15：同章号+同标题（手工复制备份 / 网盘同步副本「xxx 2.md」形态）撞名——
    // 此前 atomicWriteFile 直写同路径幂等替换，chapterCount 与 files 却计两次，两章只
    // 留一章且无提示；改为追加序号后缀保双份并计入 warnings，作者可手动取舍。
    let fileName = `${prefix}${baseName}.md`
    if (splitUsed.has(fileName)) {
      let n = 2
      while (splitUsed.has(`${prefix}${baseName}-${n}.md`)) n++
      const dedupName = `${prefix}${baseName}-${n}.md`
      splitUsed.add(dedupName)
      warnings.push(`分章 ${unit.num}「${unit.title}」与已导出产物撞名，已另存为 ${dedupName}——若为同名重复章请手动核对/清理`)
      atomicWriteFile(join(exportDir, '分章', dedupName), `# ${unit.title}\n\n${body}`)
      files.push(`工作区/导出/分章/${dedupName}`)
    } else {
      splitUsed.add(fileName)
      atomicWriteFile(join(exportDir, '分章', fileName), `# ${unit.title}\n\n${body}`)
      files.push(`工作区/导出/分章/${fileName}`)
    }
   } catch (e) {
    // R67-10（十五轮）：分章单章写入失败带上章上下文重抛——外层收编为 {ok:false}
    throw new Error(`分章 ${unit.num}「${unit.title}」写入失败：${e instanceof Error ? e.message : String(e)}`)
   }
  }

  // R67-10（十五轮）：写入期异常（writeSplit 经 merged 流式回调或 split 循环抛出、
  // atomicWriteStream 自身失败）不再裸穿透 exportBook——库形态信封契约是 {ok:false}，
  // 裸异常在服务端直接打到 500 兜底面且丢 chapterCount/warnings 上下文。收编时全本
  // 尚在 tmp 未发布（atomicWriteStream 自清理），分章半产物由下次导出整目录归档清位。
  // R73-37：循环内逐章 readUnitBody 现读即弃（读-写流水化），writtenCount 记实际
  // 写出的章数（空正文/读取失败章已记 warnings 跳过，不再计入）。
  let writtenCount = 0
  // R73-37：实际产出章号集——投稿视图按它对齐（原实现经 exportable 预滤天然排除空正文
  // 章；预滤取消后改按实际写出集合，口径不漂移）
  const writtenNums = new Set<number>()
  try {
    if (doMerged) {
      let first = true
      atomicWriteStream(
        join(exportDir, mergedFileName),
        (append) => {
          for (const unit of exportable) {
            const raw = readUnitBody(unit)
            if (raw === null) continue // 读取失败/空正文：警告已记，跳过（不出分隔符）
            const body = purifyBody(raw)
            if (!first) append('\n\n---\n\n')
            first = false
            append(`# ${unit.title}\n\n${body}`)
            if (doSplit) writeSplit(unit, body)
            writtenCount++
            writtenNums.add(unit.num)
          }
        },
        // R26-53（二十六轮）：发布裁定——零成功章时全本文件连空壳都不落盘（原口径
        // 空 `全本-*.md` 照常 rename 落盘后才在下方按失败收口，盘上残留空产物）
        { publish: () => writtenCount > 0 },
      )
      if (writtenCount > 0) files.unshift(`工作区/导出/${mergedFileName}`)
    } else if (doSplit) {
      for (const unit of exportable) {
        const raw = readUnitBody(unit)
        if (raw === null) continue
        writeSplit(unit, purifyBody(raw))
        writtenCount++
        writtenNums.add(unit.num)
      }
    }
  } catch (e) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `导出写入失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  // R73-37：定稿章在册但全部空正文/读取失败 → 零产物，按失败收口（原实现经 exportable
  // 预滤走同一信封；具体病因见 warnings 逐章留痕）。
  // R26-53（二十六轮）：文案如实归因——到达此处时各章**均已定稿**（exportable 即定稿
  // 集），真实病因是空正文/读取失败；原「均未定稿，请先在文档树中定稿」误导作者去重
  // 复定稿操作。配合 publish 裁定，盘上亦无空壳产物残留。
  // R28-16（二十八轮）：报数口径再收紧——units.length 是正文区全部章数，跳过草稿
  // （skippedDrafts>0）或无清单兜底（finalizedPaths===null）时按它报「有定稿章 N 章」
  // 会虚高（10 章仅 1 定稿且空 → 误报 10 章）。分口径如实表述：有定稿清单报定稿章数
  // （filtered.length，另注跳过的草稿数）；无清单兜底改说正文区全部章（未按定稿过滤）。
  if (writtenCount === 0) {
    const scope =
      finalizedPaths !== null
        ? `有定稿章 ${filtered.length} 章但正文全部为空或读取失败${skippedDrafts > 0 ? `（另有 ${skippedDrafts} 章未定稿已跳过）` : ''}`
        : `正文区 ${units.length} 章的正文全部为空或读取失败（未找到定稿清单，未按定稿过滤）`
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `${scope}，没有可导出的内容；逐章原因见 warnings。`,
    }
  }

  // R70-4（十八轮）：short 分支整体收编进错误信封——R67-10 只包了 merged/split 写入，
  // 投稿视图的 scanShortCollection/readdirSync 清点/atomicWriteFile 裸穿：磁盘满/目录
  // 并发删除时异常破坏 {ok:false} 契约（worker 形态丢 warnings 上下文、库形态裸异常）。
  try {
  if (kind === 'short') {
    // 文件名与内容标题一致：非 generic 平台带模板 label（多平台产物不互相覆盖）
    const submissionNameOf = (p: string, label: string | undefined): string => {
      const suffix = label && p !== 'generic' ? `-${label}` : ''
      return `投稿视图-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength(`投稿视图-${suffix}.md`))}${suffix}.md`
    }
    const submissionName = submissionNameOf(platform, SUBMISSION_TEMPLATES[platform]?.label)
    // 低级项（第六轮）：投稿视图旧产物清理（对齐「全本-」第五轮口径）——书改名后旧
    // 「投稿视图-旧名…」残留会让作者拿错稿。P5-管线（第七轮）：平台槽位归属由
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
      if (!old.startsWith('投稿视图-') || !old.endsWith('.md') || old === submissionName) continue
      if (protectedNames.has(old)) continue
      // R65-27：旧产物归档不删（作者手改过的投稿稿不可静默销毁）
      archiveOldExport(exportDir, old, warnings)
    }
    // V-P2-2：投稿视图同口径滤未定稿（entries 按 R73-37 实际产出章号对齐）
    const exportableNums = writtenNums
    const entries = scanShortCollection(bookRoot).filter((e) => exportableNums.has(e.num))
    atomicWriteFile(
      join(exportDir, submissionName),
      formatShortSubmissionView(entries, cfg.ok ? cfg.config.short : undefined, bookTitle, platform),
    )
    files.push(`工作区/导出/${submissionName}`)
  }
  } catch (e) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `导出写入失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  return {
    ok: true,
    files,
    chapterCount: writtenCount,
    unit: '章',
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

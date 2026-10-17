/**
 * 短篇投稿视图写出（md 面专属）：旧产物清点归档 + 同名先归档再覆盖 + 规范形写。
 *
 * 不变量：各平台当前书名产物受保护不误清；归档不下改序号兜底名；写失败回填已落盘 files。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { readBookConfig } from '../format/yaml.js'
import { isMdFileName } from '../format/filename.js'
import { formatShortSubmissionView, scanShortCollection, SUBMISSION_TEMPLATES } from '../metrics/short-index.js'
import { errMsg } from '../log/index.js'
import { archiveOldExport, nextFreeName, sanitizeFileName, FILENAME_MAX_BYTES } from './naming.js'
import type { ExportPlatform, StageResult } from './types.js'
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
    // 视图面不消费反转质量（弱反转/铺垫回收），quality: false 跳过逐章正文锚点扫描
    const entries = scanShortCollection(bookRoot, { quality: false }).filter((e) => writtenNums.has(e.num))
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

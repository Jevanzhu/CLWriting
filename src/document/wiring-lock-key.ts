/**
 * 布线文件锁键单源——文档保存链（DocContext.wiringFileLockKey）、定稿履历回写链
 * （lead-finalize）、PUT 直写链（studio/server/api/files）三侧共用同一构造，互斥才成立。
 *
 * 键 = `join(bookRoot, rel)` 词法路径 + `.lock`；不经 realpath——save 链按词法 relPath
 * 取锁，symlink 根（macOS /var→/private/var）下 realpath 会拼出不同键名使互斥静默失效。
 * 归一管线 = toNfcName（先）→ platformCaseFold（后），与文档身份键 docJoinKey 同序：
 * NFC/NFD 两种来源路径与 win32 case-only 改名都不得对同一布线文件派生第二个锁文件。
 * 前缀门 = `布线/` 与 `大纲/关系线/`（布线族回写点）；门外路径 → null（不加锁）。
 */
import { join } from 'node:path'
import { normalizeWinSeparators, platformCaseFold } from '../fs/safe-path.js'
import { toNfcName } from '../fs/text-canonical.js'

/** 布线锁键（绝对路径形态；调用方已确认属布线族）。 */
export function wiringLockKeyOfAbs(absFile: string): string {
  return `${platformCaseFold(toNfcName(absFile))}.lock`
}

/** 布线锁键（书根 + 相对路径形态）；非布线族路径 → null（不取锁）。 */
export function wiringLockKeyOfRel(bookRoot: string, relPath: string): string | null {
  const p = normalizeWinSeparators(relPath)
  if (p.startsWith('布线/') || p.startsWith('大纲/关系线/')) {
    return wiringLockKeyOfAbs(join(bookRoot, relPath))
  }
  return null
}

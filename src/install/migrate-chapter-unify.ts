/**
 * 短篇「篇→章」统一迁移：
 * 1. fm 字段 `篇号:` → `章号:`（写作/正文/*.md + 大纲/章纲/*.md + 大纲/清单/*.md）
 * 2. 目录 `大纲/清单/` → `大纲/章纲/`
 *
 * 幂等：已是新格式 → no-op。仅对短篇书（readKind === 'short'）执行。
 */
import { existsSync, readdirSync, renameSync, readFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { readKind } from '../format/kind.js'
import { atomicWriteFile } from '../fs/atomic.js'

/** 将单个 md 文件的 fm 中 `篇号:` 替换为 `章号:`（仅首行 front matter 内） */
function rewriteFmField(filePath: string): boolean {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }
  // 只替换 front matter 区块内的 篇号（--- ... --- 之间）
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return false
  const fmBody = fmMatch[1]!
  if (!fmBody.includes('篇号')) return false // 无篇号字段，无需改
  const newFm = fmBody.replace(/^篇号:/m, '章号:')
  const newContent = content.slice(0, fmMatch.index!) + '---\n' + newFm + '\n---' + content.slice(fmMatch.index! + fmMatch[0]!.length)
  try {
    atomicWriteFile(filePath, newContent)
    return true
  } catch {
    return false
  }
}

/** 扫目录下所有 .md，重写 fm 字段 */
function rewriteDir(dirPath: string): number {
  if (!existsSync(dirPath)) return 0
  let n = 0
  try {
    for (const name of readdirSync(dirPath)) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      if (rewriteFmField(join(dirPath, name))) n++
    }
  } catch {
    // 读目录失败 → 跳过
  }
  return n
}

export function migrateChapterUnify(bookRoot: string): { migrated: number; errors: string[] } {
  // 仅短篇书需要迁移
  if (readKind(bookRoot) !== 'short') return { migrated: 0, errors: [] }

  let migrated = 0
  const errors: string[] = []

  // 1. 目录迁移：大纲/清单/ → 大纲/章纲/
  const oldDir = join(bookRoot, '大纲', '清单')
  const newDir = join(bookRoot, '大纲', '章纲')
  if (existsSync(oldDir)) {
    if (!existsSync(newDir)) {
      try {
        renameSync(oldDir, newDir)
      } catch (e) {
        errors.push(`目录迁移失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      // 新旧都存在：逐文件搬（新目录已有同名则跳过）
      try {
        for (const name of readdirSync(oldDir)) {
          const src = join(oldDir, name)
          const dst = join(newDir, name)
          if (!existsSync(dst)) {
            try {
              renameSync(src, dst)
            } catch {
              // 单文件搬运失败不阻断
            }
          }
        }
        // 尝试删空旧目录
        try {
          if (readdirSync(oldDir).length === 0) {
            rmdirSync(oldDir)
          }
        } catch {
          // 非空或删除失败 → 保留
        }
      } catch {
        // 读旧目录失败 → 跳过
      }
    }
  }

  // 2. fm 字段重写：写作/正文/*.md + 大纲/章纲/*.md
  migrated += rewriteDir(join(bookRoot, '写作', '正文'))
  migrated += rewriteDir(join(bookRoot, '大纲', '章纲'))

  return { migrated, errors }
}

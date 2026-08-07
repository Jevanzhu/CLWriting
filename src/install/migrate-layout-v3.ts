/**
 * v3 迁移：取消草稿目录——`写作/草稿/草稿-N.md` 搬到正文区。
 *
 * 幂等：源不存在 → no-op；目标已存在 → 跳过（防覆盖）。
 * 搬完后更新文档清单路径，尝试删空 `写作/草稿/` 目录。
 *
 * 细纲/本章写作材料/首篇细纲 已在任务1改路径引用，此处做磁盘搬迁兜底。
 */
import { existsSync, readdirSync, renameSync, rmdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveDraftPath } from '../format/draft.js'
// B-P1-3：消除 install 层对 studio 层的反向依赖，改读内核 format/kind
import { readKind } from '../format/kind.js'
import { readManifest, writeManifest } from '../document/manifest.js'

export function migrateLayoutV3(bookRoot: string): { migrated: number; errors: string[] } {
  const draftDir = join(bookRoot, '写作', '草稿')
  if (!existsSync(draftDir)) return { migrated: 0, errors: [] }

  let migrated = 0
  const errors: string[] = []
  const kind = readKind(bookRoot)
  const pathRemap = new Map<string, string>() // 旧 path → 新 path（manifest 更新用）

  for (const name of readdirSync(draftDir)) {
    const srcAbs = join(draftDir, name)
    if (name === '细纲.md' || name === '本章写作材料.md') {
      // 临时产物 → 工作区/
      const dst = join(bookRoot, '工作区', name)
      if (!existsSync(dst)) {
        try {
          mkdirSync(dirname(dst), { recursive: true })
          renameSync(srcAbs, dst)
          migrated++
        } catch (e) { errors.push(`${name}: ${e}`) }
      }
      continue
    }
    if (name === '首篇细纲.md') {
      // 持久化规划 → 大纲/
      const dst = join(bookRoot, '大纲', name)
      if (!existsSync(dst)) {
        try {
          mkdirSync(dirname(dst), { recursive: true })
          renameSync(srcAbs, dst)
          migrated++
          pathRemap.set(`写作/草稿/${name}`, `大纲/${name}`)
        } catch (e) { errors.push(`${name}: ${e}`) }
      }
      continue
    }
    const m = name.match(/^草稿-(\d+)\.md$/)
    if (!m) continue // 其他文件跳过
    const chapterNum = Number(m[1])
    // 读 content 传给 resolveDraftPath 提取标题
    let content: string | undefined
    try { content = readFileSync(srcAbs, 'utf-8') } catch { /* 读失败用 undefined */ }
    const { relPath: dstRel } = resolveDraftPath(bookRoot, chapterNum, kind, content)
    const dstAbs = join(bookRoot, dstRel)
    if (existsSync(dstAbs)) {
      // 目标已存在（同章号已有定稿/草稿）→ 旧稿移回收站，不覆盖也不残留草稿区
      const trashDir = join(bookRoot, '工作区', '.trash')
      try {
        mkdirSync(trashDir, { recursive: true })
        renameSync(srcAbs, join(trashDir, name))
        migrated++
      } catch (e) { errors.push(`${name} → .trash: ${e}`) }
      continue
    }
    try {
      mkdirSync(dirname(dstAbs), { recursive: true })
      renameSync(srcAbs, dstAbs)
      migrated++
      pathRemap.set(`写作/草稿/${name}`, dstRel)
    } catch (e) {
      errors.push(`${name} → ${dstRel}: ${e}`)
    }
  }

  // 更新文档清单路径（path 变更 → 重建 entries Map，key 不变只改 entry.path）
  if (pathRemap.size > 0) {
    try {
      const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
      const manifest = readManifest(manifestPath)
      for (const entry of manifest.entries.values()) {
        const newPath = pathRemap.get(entry.path)
        if (newPath) entry.path = newPath
      }
      writeManifest(manifestPath, manifest)
    } catch (e) {
      errors.push(`manifest 更新失败: ${e}`)
    }
  }

  // 尝试删空草稿目录（仍有文件则保留）
  try { rmdirSync(draftDir) } catch { /* 非空或其他原因 → 保留 */ }

  return { migrated, errors }
}

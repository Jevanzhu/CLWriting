/**
 * v3 迁移：取消草稿目录——`写作/草稿/草稿-N.md` 搬到正文区。
 *
 * 幂等：源不存在 → no-op；目标已存在 → 跳过（防覆盖）。
 * 搬完后更新文档清单路径，尝试删空 `写作/草稿/` 目录。
 *
 * 细纲/本章写作材料/首章细纲 已在任务1改路径引用，此处做磁盘搬迁兜底。
 */
import { existsSync, readdirSync, renameSync, rmdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveDraftPath } from '../format/draft.js'
import { readManifest, writeManifest } from '../document/manifest.js'
import { appendTrashEntry } from '../document/trash.js'
import { ulid } from '../fs/id.js'
import { roleOf } from '../document/layout.js'

/** 冲突/受阻草稿 → 工作区/.trash + 回收站清单登记（W-P2-3：只挪文件不登记，
 *  回收站 UI 永不可见、无法还原——与 doTrash 的回收站语义保持一致）。 */
function trashDraft(bookRoot: string, srcAbs: string, name: string): void {
  const trashDir = join(bookRoot, '工作区', '.trash')
  mkdirSync(trashDir, { recursive: true })
  // L-D3（第八轮）：目标占用不静默覆盖——POSIX renameSync 对已存在文件静默替换，
  // 跨次迁移同名旧稿会被覆盖（doTrash 用 <docId>- 前缀正是防此）；追加 ULID 保全两代
  let dstName = name
  if (existsSync(join(trashDir, dstName))) dstName = `${ulid()}-${name}`
  renameSync(srcAbs, join(trashDir, dstName))
  appendTrashEntry(bookRoot, {
    id: ulid(),
    originalPath: `写作/草稿/${name}`,
    trashedPath: `工作区/.trash/${dstName}`,
    trashedAt: new Date().toISOString(),
    role: roleOf(`写作/草稿/${name}`),
  })
}

export function migrateLayoutV3(bookRoot: string): { migrated: number; errors: string[] } {
  const draftDir = join(bookRoot, '写作', '草稿')
  if (!existsSync(draftDir)) return { migrated: 0, errors: [] }

  let migrated = 0
  const errors: string[] = []
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
        } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      continue
    }
    if (name === '首篇细纲.md' || name === '首章细纲.md') {
      // 持久化规划 → 大纲/（统一文件名为 首章细纲.md）
      const dstName = '首章细纲.md'
      const dst = join(bookRoot, '大纲', dstName)
      if (!existsSync(dst)) {
        try {
          mkdirSync(dirname(dst), { recursive: true })
          renameSync(srcAbs, dst)
          migrated++
          pathRemap.set(`写作/草稿/${name}`, `大纲/${dstName}`)
        } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      continue
    }
    const m = name.match(/^草稿-(\d+)\.md$/)
    if (!m) continue // 其他文件跳过
    const chapterNum = Number(m[1])
    // 读 content 传给 resolveDraftPath 提取标题
    let content: string | undefined
    try { content = readFileSync(srcAbs, 'utf-8') } catch { /* 读失败用 undefined */ }
    // W-P1-5：resolveDraftPath 对已定稿章无条件 throw（V-P1-3 防线）——迁移跑在启动链路，
    // throw 冒泡会让 server 起不来且每次启动重演；归入 errors + 冲突稿进回收站，迁移继续。
    let dstRel: string
    try {
      dstRel = resolveDraftPath(bookRoot, chapterNum, content).relPath
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      try {
        trashDraft(bookRoot, srcAbs, name)
        migrated++
      } catch (e2) { errors.push(`${name} → .trash: ${e2 instanceof Error ? e2.message : String(e2)}`) }
      continue
    }
    const dstAbs = join(bookRoot, dstRel)
    if (existsSync(dstAbs)) {
      // 目标已存在（同章号已有定稿/草稿）→ 旧稿移回收站，不覆盖也不残留草稿区
      try {
        trashDraft(bookRoot, srcAbs, name)
        migrated++
      } catch (e) { errors.push(`${name} → .trash: ${e instanceof Error ? e.message : String(e)}`) }
      continue
    }
    try {
      mkdirSync(dirname(dstAbs), { recursive: true })
      renameSync(srcAbs, dstAbs)
      migrated++
      pathRemap.set(`写作/草稿/${name}`, dstRel)
    } catch (e) {
      errors.push(`${name} → ${dstRel}: ${e instanceof Error ? e.message : String(e)}`)
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
      errors.push(`manifest 更新失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 尝试删空草稿目录（仍有文件则保留）
  try { rmdirSync(draftDir) } catch { /* 非空或其他原因 → 保留 */ }

  return { migrated, errors }
}

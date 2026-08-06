/**
 * 书库目录结构 v2 迁移 —— 固化虚拟分组为真实磁盘目录。
 *
 * 旧（v1）                    v2
 * 定稿/正文/            →    写作/正文/      （含卷子目录整体搬迁）
 * 篇/（短篇集正文）      →    写作/正文/      （短篇的"篇"即正文，与长篇章同目录）
 * 清单/                 →    大纲/清单/
 * 工作区/草稿-N.md      →    写作/草稿/
 * 大纲/{5类线索}/       →    布线/{5类线索}/
 * 定稿/设定/            →    设定/
 *
 * 保留原位（不迁移）：
 * - 运行时资产：工作区/.trash、.journal、.版本、待定稿（路径硬编码在 service/trash）
 * - 关系线：大纲/关系线/（派生数据，tree skip）
 * - 定稿/摘要/：脚本产物，tree skip
 *
 * 幂等：v2 结构已存在 → no-op。server 启动时对每本书库调用一次。
 * 与 migratePieceLayout 同模式：renameSync 原子、目标存在跳过、返回 { migrated, errors }。
 */
import { existsSync, readdirSync, renameSync, mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readManifest, writeManifest } from '../document/manifest.js'

/** 迁移到布线的 5 类线索（关系线为派生数据，保留原位）。 */
const LEADS_TO_MOVE = ['悬念', '感情线', '布局线', '设定线', '成长线'] as const

/** v2 目录迁移主入口（幂等）。 */
export function migrateLayoutV2(bookRoot: string): { migrated: number; errors: string[] } {
  let migrated = 0
  const errors: string[] = []

  // 1. 长篇正文：定稿/正文/ → 写作/正文/（含卷子目录）
  migrated += moveTree(bookRoot, '定稿/正文', '写作/正文', errors)
  // 2. 短篇正文：篇/ → 写作/正文/（短篇的"篇"即正文，与长篇章同目录，由 kind 区分语义）
  migrated += moveTree(bookRoot, '篇', '写作/正文', errors)
  // 3. 短篇清单：清单/ → 大纲/清单/（规划性质，对齐长篇"规划在大纲区"）
  migrated += moveTree(bookRoot, '清单', '大纲/清单', errors)
  // 4. 工作区草稿 → 写作/草稿/（只搬草稿文件，不碰运行时资产）
  migrated += moveDrafts(bookRoot, errors)
  // 5. 线索：大纲/{5类} → 布线/{5类}
  for (const lead of LEADS_TO_MOVE) {
    migrated += moveTree(bookRoot, `大纲/${lead}`, `布线/${lead}`, errors)
  }
  // 6. 设定：定稿/设定/ → 设定/
  migrated += moveTree(bookRoot, '定稿/设定', '设定', errors)
  // 7. 更新清单（文档清单.jsonl）entry.path（v1 → v2），保持 docId 不断链
  migrated += migrateManifestPaths(bookRoot, errors)

  return { migrated, errors }
}

/** v1 路径 → v2 路径（纯映射，用于清单 entry.path 更新）。 */
function migratePath(oldPath: string): string {
  if (oldPath.startsWith('定稿/正文/')) return '写作/正文/' + oldPath.slice('定稿/正文/'.length)
  if (oldPath.startsWith('篇/')) return '写作/正文/' + oldPath.slice('篇/'.length)
  if (oldPath.startsWith('清单/')) return '大纲/清单/' + oldPath.slice('清单/'.length)
  if (oldPath.startsWith('定稿/设定/')) return '设定/' + oldPath.slice('定稿/设定/'.length)
  if (oldPath.startsWith('大纲/伏笔/')) return '设定/伏笔/' + oldPath.slice('大纲/伏笔/'.length) // P2：伏笔迁移路径同步
  if (/^工作区\/(草稿-\d+|细纲)\.md$/.test(oldPath)) return '写作/草稿/' + oldPath.slice('工作区/'.length)
  for (const lead of LEADS_TO_MOVE) {
    const prefix = `大纲/${lead}/`
    if (oldPath.startsWith(prefix)) return `布线/${lead}/` + oldPath.slice(prefix.length)
  }
  return oldPath
}

/** 更新清单 entry.path（v1 → v2），保持 docId 不变。 */
function migrateManifestPaths(bookRoot: string, errors: string[]): number {
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return 0
  let m
  try {
    m = readManifest(manifestPath)
  } catch (e) {
    errors.push(`清单读取失败: ${errMsg(e)}`)
    return 0
  }
  let count = 0
  for (const entry of m.entries.values()) {
    const newPath = migratePath(entry.path)
    if (newPath !== entry.path) {
      entry.path = newPath
      count++
    }
  }
  if (count > 0) {
    try {
      writeManifest(manifestPath, m)
    } catch (e) {
      errors.push(`清单写入失败: ${errMsg(e)}`)
    }
  }
  return count
}

/**
 * 整目录搬迁（幂等）。
 * - 旧目录不存在 → no-op
 * - 新目录不存在 → renameSync 整搬（保留子结构，卷目录跟着走）
 * - 新目录已存在 → 逐项搬进（同名跳过防覆盖），搬完尝试删空旧目录
 */
function moveTree(
  bookRoot: string,
  oldRel: string,
  newRel: string,
  errors: string[],
): number {
  const oldPath = join(bookRoot, ...oldRel.split('/'))
  const newPath = join(bookRoot, ...newRel.split('/'))
  if (!existsSync(oldPath)) return 0

  // 新目录不存在 → 整个原子搬
  if (!existsSync(newPath)) {
    mkdirSync(dirname(newPath), { recursive: true })
    try {
      renameSync(oldPath, newPath)
      return 1
    } catch (e) {
      errors.push(`${oldRel}: ${errMsg(e)}`)
      return 0
    }
  }

  // 新目录已存在（部分迁移过）→ 逐项搬
  let count = 0
  try {
    for (const name of readdirSync(oldPath)) {
      const src = join(oldPath, name)
      const dst = join(newPath, name)
      if (existsSync(dst)) {
        // 同名子目录 → 递归合并内部文件（D5）；同名文件 → 幂等跳过
        if (statSync(src).isDirectory() && statSync(dst).isDirectory()) {
          count += moveTree(bookRoot, `${oldRel}/${name}`, `${newRel}/${name}`, errors)
        }
        continue
      }
      try {
        renameSync(src, dst)
        count++
      } catch (e) {
        errors.push(`${oldRel}/${name}: ${errMsg(e)}`)
      }
    }
    // 搬完尝试删空旧目录（非空则保留）
    try {
      rmdirSync(oldPath)
    } catch {
      /* 残留文件，保留旧目录 */
    }
  } catch (e) {
    errors.push(`${oldRel}: 读目录失败 ${errMsg(e)}`)
  }
  return count
}

/**
 * 工作区草稿搬迁：草稿-N.md + 细纲.md → 写作/草稿/。
 * 不碰运行时资产（.trash/.journal/.版本/待定稿/.confirm.json/.ai-calls.json）。
 */
function moveDrafts(bookRoot: string, errors: string[]): number {
  const workdir = join(bookRoot, '工作区')
  if (!existsSync(workdir)) return 0
  const dstDir = join(bookRoot, '写作', '草稿')
  let count = 0
  try {
    for (const name of readdirSync(workdir)) {
      // 仅草稿文件；其余运行时资产不动
      if (!/^草稿-\d+\.md$/.test(name) && name !== '细纲.md') continue
      const src = join(workdir, name)
      const dst = join(dstDir, name)
      if (existsSync(dst)) continue // 幂等
      try {
        mkdirSync(dstDir, { recursive: true })
        renameSync(src, dst)
        count++
      } catch (e) {
        errors.push(`工作区/${name}: ${errMsg(e)}`)
      }
    }
  } catch (e) {
    errors.push(`工作区: 读目录失败 ${errMsg(e)}`)
  }
  return count
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

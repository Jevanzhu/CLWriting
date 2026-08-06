/**
 * 定稿基线迁移（去 git 自管版本系统 · 阶段3）。
 *
 * 旧书库首次加载时，把 git 时代的状态映射到 manifest.finalizedRevision 基线：
 * - 有 git 的书库：git clean 文件 = 已定稿 → 基线 = 当前指纹；dirty/untracked → 不设（revision/draft）。
 * - 无 git 的书库：之前所有文件都坍缩为 final（collectFileStatuses 降级空集）→ 基线 = 当前指纹（状态不变）。
 *
 * 幂等：已有 finalizedRevision 的 entry 跳过；已迁移的书库（任一 document entry 有基线）整书跳过 git 反推。
 * 迁移后 book.yaml 不再依赖 git——此后状态机、定稿全走指纹 + manifest。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readManifest, writeManifest } from '../document/manifest.js'
import { computeRevision } from '../document/revision.js'
import { statusPorcelain } from '../git/exec.js'

/**
 * 迁移定稿基线（幂等）。返回更新了多少个 entry。
 *
 * @param bookRoot 书仓库根
 * @returns 本次迁移建立的定稿基线数（0 = 已迁移或无需迁移）
 */
export function migrateFinalizedRevisions(bookRoot: string): number {
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(manifestPath)) return 0 // 无清单（新书/未建）→ no-op
  const manifest = readManifest(manifestPath)

  // 幂等闸：任一 document entry 已有定稿基线 → 整书已迁移，跳过 git 反推
  let migratedAny = false
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) migratedAny = true
  }
  if (migratedAny) return 0

  const hasGit = existsSync(join(bookRoot, '.git'))
  // 有 git：一次 porcelain 拿 clean/dirty 全集（untrackedAll 展开目录）
  const dirty = hasGit ? new Set(statusPorcelain(bookRoot, true).split('\n').filter(Boolean).map((l) => l.slice(3))) : null

  let updated = 0
  const nowIso = new Date().toISOString()
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document') continue
    if (e.finalizedRevision) continue // 幂等：已有基线跳过
    const abs = join(bookRoot, e.path)
    if (!existsSync(abs)) continue
    if (hasGit && dirty && dirty.has(e.path)) continue // git dirty/untracked → 不设基线（revision/draft）
    e.finalizedRevision = computeRevision(abs)
    e.finalizedAt = nowIso
    updated++
  }
  if (updated > 0) writeManifest(manifestPath, manifest)
  return updated
}
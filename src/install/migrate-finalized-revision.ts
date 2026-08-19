/**
 * 定稿基线迁移（去 git 自管版本系统 · 阶段3）。
 *
 * 旧书库首次加载时，把 git 时代的状态映射到 manifest.finalizedRevision 基线：
 * - 有 git 的书库：git clean 文件 = 已定稿 → 基线 = 当前指纹；dirty/untracked → 不设（revision/draft）。
 * - 无 .git 的书库：**跳过**（X-P1-1）。原「无 git = 全部坍缩 final」是 git 时代的迁移假设——
 *   v3 架构新书永无 .git（scaffold 不再 git init），假设失效：误标会把新书正常草稿判成已定稿，
 *   断写章链路（ensureChapterNotFinalized 拦截 + 手改误报）。无基线保持 draft 是安全方向
 *   （误判 draft 可正常走定稿流程，误判 final 断写）。
 *
 * 幂等：已有 finalizedRevision 的 entry 跳过；已迁移的书库（任一 document entry 有基线）整书跳过。
 * 迁移后 book.yaml 不再依赖 git——此后状态机、定稿全走指纹 + manifest。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readManifest, writeManifest } from '../document/manifest.js'
import { computeRevision } from '../document/revision.js'
import { statusPorcelain } from '../git/exec.js'
import { log } from '../log/index.js'

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

  // X-P1-1：仅对有 .git 的 git 时代书库执行（无 git = 从未经历 git 时代 → 无状态可映射）。
  if (!existsSync(join(bookRoot, '.git'))) return 0
  // 一次 porcelain 拿 clean/dirty 全集（untrackedAll 展开目录）
  const porcelain = statusPorcelain(bookRoot, true)
  if (porcelain === null) {
    // RB-IF-P1-1：git 状态不可读（git 缺失/执行失败）时 clean/dirty 无从判定——按本文件
    // 红线（误判 final 断写）跳过本次迁移不写 finalizedRevision，留待下次加载重试
    log.warn('migrate-finalized-revision', `git 状态不可读，跳过定稿基线迁移：${bookRoot}`)
    return 0
  }
  const dirty = new Set(porcelain.split('\n').filter(Boolean).map((l) => l.slice(3)))

  let updated = 0
  const nowIso = new Date().toISOString()
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document') continue
    if (e.finalizedRevision) continue // 幂等：已有基线跳过
    const abs = join(bookRoot, e.path)
    if (!existsSync(abs)) continue
    if (dirty.has(e.path)) continue // git dirty/untracked → 不设基线（revision/draft）
    e.finalizedRevision = computeRevision(abs)
    e.finalizedAt = nowIso
    updated++
  }
  if (updated > 0) writeManifest(manifestPath, manifest)
  return updated
}
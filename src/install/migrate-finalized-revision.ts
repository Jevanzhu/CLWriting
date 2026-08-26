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
import { readManifest, writeManifest, withManifestLock } from '../document/manifest.js'
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
  // 低级项（第六轮）：porcelain 路径归一后再入脏集——git 对含空格/非 ASCII 的路径加
  // C 风格引号转义（`"a b/c.md"`），rename 行是 `old -> new` 形；manifest 路径是正斜杠
  // 无引号，原先直接 has 比对会整段失配（脏文件漏判 clean → 误标 final 断写，本文件红线）
  const dirty = new Set(
    porcelain
      .split('\n')
      .filter(Boolean)
      .map((l) => normalizePorcelainPath(l.slice(3), l.slice(0, 2).includes('R'))),
  )

  let updated = 0
  const nowIso = new Date().toISOString()
  // R64-23（十二轮）：清单 RMW 持锁（Y-4/X-5 纪律）——此前读改写无锁，双开窗口内
  // 与 service/其他迁移并发时后写者整文件覆盖先写者（finalizedRevision 丢行）。
  // 锁内重读复查幂等闸：并发迁移者可能已写入。git 状态在锁外取（与清单无依赖）。
  updated = withManifestLock(manifestPath, () => {
    const m = readManifest(manifestPath)
    for (const e of m.entries.values()) {
      if (e.nodeType === 'document' && e.finalizedRevision) return 0
    }
    let n = 0
    for (const e of m.entries.values()) {
      if (e.nodeType !== 'document') continue
      if (e.finalizedRevision) continue // 幂等：已有基线跳过
      const abs = join(bookRoot, e.path)
      if (!existsSync(abs)) continue
      if (dirty.has(e.path)) continue // git dirty/untracked → 不设基线（revision/draft）
      e.finalizedRevision = computeRevision(abs)
      e.finalizedAt = nowIso
      n++
    }
    if (n > 0) writeManifest(manifestPath, m)
    return n
  })
  return updated
}

/**
 * 低级项（第六轮）：porcelain 行路径归一。
 * - 引号段：git 对含空格/非 ASCII/引号的路径整体 C 风格转义（`\"` `\\` `\t` `\n`
 *   及八进制）——按 git core.quotePath 语义解回字面路径；
 * - rename 行：`R  old -> new` 取箭头后的现路径（盘上现存的是它，脏判定应对它做）。
 */
function normalizePorcelainPath(raw: string, isRename = false): string {
  let p = raw
  // P5-数据层（第七轮）：仅 rename（R 状态）行才切箭头——文件名字面含 " -> " 的普通
  // 改动行原先被首匹配 indexOf 误截成残路径
  if (isRename) {
    // L-D7（第八轮）：引号外扫描定位 " -> "——R 状态 + 引号路径且任一侧路径字面含
    // " -> " 时，首匹配/末匹配都会切在引号内产出残路径；跟踪引号开合（含 \" 转义）
    // 只认闭引号外的箭头
    let inQuote = false
    for (let i = 0; i < p.length - 3; i++) {
      const c = p[i]
      if (c === '\\') { i++; continue } // 转义字符（含 \"）跳过
      if (c === '"') inQuote = !inQuote
      if (!inQuote && p.slice(i, i + 4) === ' -> ') {
        p = p.slice(i + 4)
        break
      }
    }
  }
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    const body = p.slice(1, -1)
    let out = ''
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!
      if (c !== '\\') {
        out += c
        continue
      }
      const n = body[++i]
      if (n === undefined) break
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === '\\') out += '\\'
      else if (n === '"') out += '"'
      else out += n // 八进制 \nnn 等罕见转义按字面收（比整段失配好）
    }
    return out
  }
  return p
}
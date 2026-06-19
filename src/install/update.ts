/**
 * `clwriting update` 逻辑层 —— 依据 M5 #31。
 *
 * 三类文件分治（#31 第 2 节）：
 * - 插件本体（.clwriting/dist）：从当前包 dist 同步到工作目录
 * - 派生物（.claude/.codex/AGENTS.md 壳）：generateRoleShells 重生
 * - 作者数据（book.yaml/角色源/知识层）：只增不覆盖 + 模板哈希差异提示
 *
 * 幂等：同版本重跑无副作用。不碰书仓库内容。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { generateRoleShells, checkRoleShellDrift, formatDriftReport, type ShellPlatform } from '../roles/shells.js'
import { findWorkDir } from './books.js'

export interface UpdateOptions {
  workDir: string
  detail: 'brief' | 'full'
}

export type UpdateResult =
  | { ok: true; report: string[] }
  | { ok: false; reason: string }

const CLWRITING_DIR = '.clwriting'
const ROLES_DIR = '.clwriting/roles'
const ROLES_BAK_DIR = '.clwriting/roles.bak'
const TEMPLATES_ROLES_DIR = 'templates/roles'
const TEMPLATES_MANIFEST = '.clwriting/templates.manifest.json'

interface TemplateRecord {
  path: string
  installed_hash: string
}

interface TemplatesManifest {
  version: 1
  records: TemplateRecord[]
}

/** update 主流程（#31 第 6 节 5 步）。 */
export function doUpdate(opts: UpdateOptions): UpdateResult {
  const workDir = resolve(opts.workDir)
  if (!findWorkDir(workDir)) {
    return { ok: false, reason: '当前不在 CLWriting 工作目录' }
  }
  const report: string[] = []
  report.push('升级报告：')

  // 步骤 1：插件本体（dist）——从当前包内 dist 覆盖到工作目录。
  syncDist(workDir, report)

  // 步骤 2：角色源备份（#31 第 4 节 S1）
  backupRoles(workDir, report)

  // 步骤 3：重生派生物（壳）——先 drift check，反向 drift 提示再重生
  const driftReport = checkRoleShellDrift(workDir)
  if (!driftReport.ok) {
    const outputDrift = driftReport.issues.filter((i) => i.kind === 'output-drift' || i.kind === 'output-malformed')
    if (outputDrift.length > 0) {
      report.push('· ⚠ 角色壳被手改过（壳是派生物，改源别改壳）：')
      for (const i of outputDrift) report.push(`    - ${i.message}`)
    }
  }
  // 重生壳（generateRoleShells 自带 writeManagedFile 覆盖纪律）
  const shellResult = generateRoleShells({ projectRoot: workDir })
  if (!shellResult.ok) {
    report.push(`· ⚠ 重生角色壳失败：${shellResult.reason}（可能是角色源损坏，见 .clwriting/roles.bak 回退）`)
  } else {
    report.push(`· 角色壳已重生（${shellResult.written.length} 个产物）`)
    // 重生后再 drift check 应绿
    const after = checkRoleShellDrift(workDir)
    report.push(after.ok ? '· 角色壳 drift 校验：✓ 绿' : `· 角色壳 drift：${formatDriftReport(after)}`)
  }

  // 步骤 4：模板哈希比对（#31 第 3 节）——角色源模板
  const templateReport = syncTemplateHashes(workDir, opts.detail)
  report.push(...templateReport)

  report.push('')
  report.push('升级完成。作者数据（book.yaml/角色源/正文）未被覆盖。')
  return { ok: true, report }
}

/** 角色源备份（.clwriting/roles → .clwriting/roles.bak，单份覆盖）。 */
function backupRoles(workDir: string, report: string[]): void {
  const src = join(workDir, ROLES_DIR)
  const bak = join(workDir, ROLES_BAK_DIR)
  if (!existsSync(src)) {
    report.push('· 角色源备份：跳过（无 .clwriting/roles 目录）')
    return
  }
  // 清旧备份再拷（单份覆盖策略）
  rmSync(bak, { recursive: true, force: true })
  mkdirSync(bak, { recursive: true })
  for (const file of readdirSync(src)) {
    if (file.startsWith('._')) continue
    cpSync(join(src, file), join(bak, file))
  }
  report.push('· 角色源备份：.clwriting/roles → .clwriting/roles.bak（改坏可回退）')
}

function syncDist(workDir: string, report: string[]): void {
  const src = resolvePackageDistDir()
  const dest = join(workDir, CLWRITING_DIR, 'dist')
  if (!src) {
    mkdirSync(dest, { recursive: true })
    report.push('· ⚠ 插件本体（.clwriting/dist）：找不到当前包 dist，已保留现有目录')
    return
  }
  if (resolve(src) === resolve(dest)) {
    report.push('· 插件本体（.clwriting/dist）：已是当前 dist，无需复制')
    return
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  report.push('· 插件本体（.clwriting/dist）：已同步当前包 dist')
}

/**
 * 模板哈希比对（#31 第 3 节）。
 * base = installed_hash（初装版）、current = 当前文件、new = 新版模板种子。
 * - current == installed（作者没改）→ 升级到 new + 更新 hash
 * - current != installed（作者改过）→ 保留 + 差异提示
 */
function syncTemplateHashes(workDir: string, detail: 'brief' | 'full'): string[] {
  const lines: string[] = []
  const newTemplatesDir = resolveTemplatesRolesDir()
  const manifestPath = join(workDir, TEMPLATES_MANIFEST)
  const manifest = readTemplatesManifest(manifestPath)
  const recordsByName = new Map(manifest.records.map((r) => [templateName(r.path), r]))

  if (!newTemplatesDir) {
    lines.push('· 模板哈希：跳过（找不到新版模板种子 templates/roles/）')
    return lines
  }

  const newFiles = readdirSync(newTemplatesDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  const updated: string[] = []
  const conflicts: { name: string; cur: string; newHash: string }[] = []
  const nextRecords: TemplateRecord[] = []

  for (const file of newFiles) {
    const curPath = join(workDir, ROLES_DIR, file)
    const newPath = join(newTemplatesDir, file)
    const newContent = readFileSync(newPath, 'utf-8')
    const newHash = hashText(newContent)
    const record = recordsByName.get(file)

    if (!existsSync(curPath)) {
      // 工作目录没这文件（新模板）→ 直接拷
      cpSync(newPath, curPath)
      updated.push(file)
      nextRecords.push({ path: `${ROLES_DIR}/${file}`, installed_hash: newHash })
      continue
    }

    const curContent = readFileSync(curPath, 'utf-8')
    const curHash = hashText(curContent)

    if (!record) {
      // 旧安装无 base：先记录当前为 installed，避免把作者已有改动误判成新版。
      nextRecords.push({ path: `${ROLES_DIR}/${file}`, installed_hash: curHash })
      continue
    }

    if (curHash === record.installed_hash) {
      // 作者没改 → 升级到 new（除非 new 和 installed 一样）
      if (curHash !== newHash) {
        cpSync(newPath, curPath)
        updated.push(file)
      }
      nextRecords.push({ path: `${ROLES_DIR}/${file}`, installed_hash: newHash })
    } else {
      // 作者改过 → 保留 + 记差异
      if (curHash !== newHash) {
        conflicts.push({ name: file, cur: curContent, newHash })
      }
      nextRecords.push({ path: record.path, installed_hash: curHash === newHash ? newHash : record.installed_hash })
    }
  }

  // 写回 manifest（更新 installed_hash）
  writeTemplatesManifest(manifestPath, nextRecords)

  if (updated.length > 0) {
    lines.push(`· 模板升级（作者未改，自动更新）：${updated.join('、')}`)
  }
  if (conflicts.length > 0) {
    lines.push(`· ⚠ 模板有新版但你改过（保留你的，${detail === 'full' ? '差异如下' : '用 --full 看差异'}）：`)
    for (const c of conflicts) {
      lines.push(`    - ${c.name}`)
      if (detail === 'full') {
        lines.push(`      （你改过，新版哈希 ${c.newHash.slice(0, 16)}…；要合并请手动对照新版改）`)
      }
    }
  }
  if (updated.length === 0 && conflicts.length === 0) {
    lines.push('· 模板哈希：无变化')
  }
  return lines
}

function templateName(path: string): string {
  return path.split('/').pop() ?? path
}

function readTemplatesManifest(path: string): TemplatesManifest {
  if (!existsSync(path)) return { version: 1, records: [] }
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'))
    if (obj && typeof obj === 'object' && Array.isArray(obj.records)) {
      return { version: 1, records: obj.records as TemplateRecord[] }
    }
  } catch {
    // 坏 manifest 当空
  }
  return { version: 1, records: [] }
}

function writeTemplatesManifest(path: string, records: TemplateRecord[]): void {
  const manifest: TemplatesManifest = { version: 1, records }
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8')
}

function hashText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** 定位 templates/roles/ 目录（兼容 src 直跑 + dist 打包，与 init.ts 同逻辑）。 */
function resolveTemplatesRolesDir(): string | null {
  const root = resolvePackageDir()
  if (!root) return null
  const dir = join(root, TEMPLATES_ROLES_DIR)
  return existsSync(dir) ? dir : null
}

function resolvePackageDistDir(): string | null {
  const root = resolvePackageDir()
  if (!root) return null
  const dir = join(root, 'dist')
  return existsSync(dir) ? dir : null
}

function resolvePackageDir(): string | null {
  try {
    let here = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(here, 'package.json'))) {
        return here
      }
      here = dirname(here)
    }
    return null
  } catch {
    return null
  }
}

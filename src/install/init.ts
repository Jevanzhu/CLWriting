/**
 * `clwriting init` 逻辑层 —— 依据 M5 #30。
 *
 * 把 #21 壳生成器接成完整安装器：装工作目录（非 git）+ 建第一本书（独立 git 仓库）。
 * 混合式：关键项交互（书名/题材→账本类），其余默认；全参数则非交互逃生。
 *
 * 幂等：工作目录骨架已存在则复用；同名书已登记则报冲突不覆盖。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { generateRoleShells, type ShellPlatform } from '../roles/shells.js'
import { matchGenreLeads } from './data.js'
import { appendBook, writeActive, readBooks, bookStoragePath } from './books.js'
import { scaffoldBookRepo, findGitAncestor, type BookScaffoldOpts } from './scaffold.js'
import { atomicWriteFile } from '../fs/atomic.js'
import type { LeadType } from '../format/types.js'

export interface InitOptions {
  /** 工作目录（cwd 或显式指定）；init 在此建书 */
  workDir: string
  /** 书名（必填，交互或 --name） */
  name: string
  /** 题材（可选，驱动 leads 推荐） */
  genre?: string
  /** 扩展账本类（--leads 直接指定；否则按题材推荐） */
  leads?: readonly string[]
  /** 长篇/短篇（默认 long；short 细节归 M8） */
  kind?: 'long' | 'short'
  /** AI 宿主（决策 12/22，默认 cc；首版只 cc） */
  host?: 'cc' | 'codex'
  /** 装哪些平台壳（默认全装） */
  platforms?: ShellPlatform[]
  /** 全书目标字数（决策 14，落 book.yaml target_words） */
  targetWords?: number
  /** 简介（GUI 新增 5.1，落 简介.md） */
  brief?: string
}

export type InitResult =
  | { ok: true; workDir: string; bookRoot: string; bookName: string; bookPath: string }
  | { ok: false; reason: string }

const CLWRITING_DIR = '.clwriting'
const TEMPLATES_ROLES_DIR = 'templates/roles'
const TEMPLATES_MANIFEST = '.clwriting/templates.manifest.json'

/**
 * init 主流程（#30 第 5 节 9 步）。
 * 非交互：调用方已收集 name/genre/leads；交互式逃生由 CLI 层处理（本函数纯逻辑）。
 */
export function doInit(opts: InitOptions): InitResult {
  const workDir = resolve(opts.workDir)
  const bookName = opts.name
  if (!bookName) return { ok: false, reason: '书名不能为空' }

  const kind = opts.kind ?? 'long'
  const bookPath = bookStoragePath(bookName, kind)
  const bookRoot = join(workDir, bookPath)

  const gitAncestor = findGitAncestor(workDir)
  if (gitAncestor) {
    return { ok: false, reason: `工作目录不能放在 git 仓库里：${gitAncestor}。请换一个非 git 目录再 init。` }
  }

  // 幂等检查：同名书已登记或目录已存在 → 拒绝覆盖
  if (existsSync(bookRoot) && readdirSync(bookRoot).length > 0) {
    return { ok: false, reason: `目录「${bookName}」已存在且非空，换个书名或先清空它` }
  }
  const existingBooks = readBooks(workDir)
  if (existingBooks.some((b) => b.name === bookName)) {
    return { ok: false, reason: `已有一本叫「${bookName}」的书` }
  }

  // 确定扩展账本类（显式 > 题材推荐 > 空）。短篇集无长程账本（降级单篇清单 #27），恒空
  const leadsEnabled: LeadType[] = kind === 'short'
    ? []
    : opts.leads
      ? sanitizeToExtendedLeads(opts.leads)
      : opts.genre
        ? matchGenreLeads(opts.genre)
        : []

  // 步骤 5：工作目录骨架（非 git，幂等复用）+ 插件本体 dist
  const workDirResult = scaffoldWorkDir(workDir)
  if (!workDirResult.ok) return workDirResult

  // 步骤 6：书仓库 scaffold（独立 git + book.yaml + 6.2 目录 + 文风占位 + 初始 commit）
  scaffoldBookRepo(bookRoot, { name: bookName, genre: opts.genre ?? '', leadsEnabled, kind, host: opts.host, targetWords: opts.targetWords, brief: opts.brief })

  // 步骤 7：装壳（种默认角色源 → generateRoleShells）
  const seedResult = seedDefaultRoles(workDir)
  if (!seedResult.ok) return seedResult

  const platforms = opts.platforms ?? (['claude', 'codex', 'generic'] as ShellPlatform[])
  const shellResult = generateRoleShells({ projectRoot: workDir, platforms })
  if (!shellResult.ok) {
    return { ok: false, reason: `装壳失败：${shellResult.reason}` }
  }

  // 步骤 8：登记 books.jsonl + 设活动书
  const appendRes = appendBook(workDir, {
    name: bookName,
    path: bookPath,
    kind,
    created_at: new Date().toISOString(),
  })
  if (!appendRes.ok) return appendRes
  writeActive(workDir, bookName)

  return { ok: true, workDir, bookRoot, bookName, bookPath }
}

/** 步骤 5：工作目录骨架（非 git，幂等——已存在则复用）。 */
function scaffoldWorkDir(workDir: string): { ok: true } | { ok: false; reason: string } {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  mkdirSync(join(workDir, CLWRITING_DIR, 'roles'), { recursive: true })
  const distResult = syncPackageDist(workDir)
  if (!distResult.ok) return distResult
  // books.jsonl / active 由 books.ts 按需建，这里不预建
  return { ok: true }
}

/** 步骤 7：种默认角色源（从 templates/roles/ 拷到工作目录 .clwriting/roles/）。 */
function seedDefaultRoles(workDir: string): { ok: true } | { ok: false; reason: string } {
  const srcDir = resolveTemplatesRolesDir()
  if (!srcDir || !existsSync(srcDir)) {
    return { ok: false, reason: '找不到默认角色源种子（templates/roles/ 缺失），请重装 clwriting' }
  }
  const destDir = join(workDir, CLWRITING_DIR, 'roles')
  mkdirSync(destDir, { recursive: true })

  // 幂等：已有角色源不覆盖（作者可能改过）；只补缺失的
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.md') || file.startsWith('._')) continue
    const dest = join(destDir, file)
    if (!existsSync(dest)) {
      // readFileSync+atomicWriteFile 明确支持 asar 读(Electron 打包态 templates 在 app.asar 内);
      // cpSync 单文件 from asar 在部分 Node 版本不稳。
      atomicWriteFile(dest, readFileSync(join(srcDir, file)))
    }
  }
  writeTemplatesManifest(workDir, srcDir)
  return { ok: true }
}

function writeTemplatesManifest(workDir: string, srcDir: string): void {
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  const records = files.map((f) => ({
    path: `${CLWRITING_DIR}/roles/${f}`,
    installed_hash: hashText(readFileSync(join(srcDir, f), 'utf-8')),
  }))
  atomicWriteFile(
    join(workDir, TEMPLATES_MANIFEST),
    JSON.stringify({ version: 1, records }, null, 2),
  )
}

function hashText(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf-8').digest('hex')
}

/** 定位 templates/roles/ 目录（兼容 src 直跑 + dist 打包）。 */
function resolveTemplatesRolesDir(): string | null {
  const root = resolvePackageDir()
  if (!root) return null
  const dir = join(root, TEMPLATES_ROLES_DIR)
  return existsSync(dir) ? dir : null
}

function syncPackageDist(workDir: string): { ok: true } | { ok: false; reason: string } {
  const root = resolvePackageDir()
  if (!root) return { ok: false, reason: '找不到 clwriting 包根目录，请重装 clwriting' }
  const src = join(root, 'dist')
  // Electron 打包态:dist 在 app.asar 内(只读虚拟 fs),cpSync 递归拷贝会 ENOENT。
  // 桌面版 claude 子进程用 app 内 dist/cli.js(ELECTRON_RUN_AS_NODE,见 api/cli.ts),
  // 不消费 .clwriting/dist → 跳过同步。CLI/npm 模式(src 不含 app.asar)不受影响。
  if (src.includes('app.asar')) return { ok: true }
  if (!existsSync(src)) {
    return { ok: false, reason: '找不到当前包 dist，请先运行 npm run build 或重装 clwriting' }
  }
  const dest = join(workDir, CLWRITING_DIR, 'dist')
  if (resolve(src) === resolve(dest)) return { ok: true }
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  return { ok: true }
}

function resolvePackageDir(): string | null {
  try {
    // 本文件：src/install/init.ts（直跑）或 dist/init-<hash>.js（打包）
    // 包根 = 本文件上溯到含 package.json 的目录
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

/** 把字符串数组收敛为合法扩展账本类（剔除基础类/未知类/去重）。 */
function sanitizeToExtendedLeads(raw: readonly string[]): LeadType[] {
  const extended = new Set<LeadType>(['局线', '设定线', '成长线', '关系债'])
  const seen = new Set<LeadType>()
  const out: LeadType[] = []
  for (const r of raw) {
    const t = r as LeadType
    if (extended.has(t) && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

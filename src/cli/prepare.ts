/**
 * `clwriting prepare [书目录]` —— 阶段 3 手动备料门面。
 *
 * 只生成工作区/本章写作材料.md，不调用模型，不改定稿区。
 */

import process from 'node:process'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolveBookRoot } from '../install/books.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { prepareMaterials } from '../process/materials.js'
import { readOutlineLeads } from '../process/materials.js'

export async function prepareCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printPrepareHelp()
    return
  }

  const parsed = parseArgs(args)
  const resolved = resolveBookRoot(parsed.positionals)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }

  const bookRoot = resolved.bookRoot
  const workDir = join(bookRoot, '工作区')
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const rebuilt = rebuild(bookRoot, cachePath)
  if (rebuilt.errors.length > 0) {
    console.error('✗ 源文件解析失败，先修这些文件：')
    for (const e of rebuilt.errors) {
      console.error(`· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
    }
    process.exit(1)
  }

  const chapterLeadIds = parsed.leads ?? readOutlineLeads(workDir)
  const db = new DatabaseSync(cachePath)
  try {
    const result = await prepareMaterials(db, config, {
      bookRoot,
      workDir,
      chapterLeadIds,
      query: parsed.query,
      sampleScene: parsed.scene,
    })
    const outPath = join(workDir, '本章写作材料.md')
    writeFileSync(outPath, result.text, 'utf-8')
    console.log(`✓ 已生成工作区/本章写作材料.md（约 ${result.estimatedTokens} token）`)
    if (result.trimmed) console.log(`· 已裁剪：${result.trimLog.join('、')}`)
    if (result.ragNote) console.log(`· ${result.ragNote}`)
    if (result.styleNote) console.log(`· ${result.styleNote}`)
  } finally {
    db.close()
  }
}

function printPrepareHelp(): void {
  console.log('用法：clwriting prepare [书目录] [--lead A,B] [--scene 场景[,场景]] [--query 文本]')
  console.log('生成工作区/本章写作材料.md；默认从工作区/细纲.md 的「推进」「场景」读取。')
}

function parseArgs(args: string[]): {
  positionals: string[]
  leads?: string[]
  scene?: string | string[]
  query?: string
} {
  const positionals: string[] = []
  let leads: string[] | undefined
  let scene: string | string[] | undefined
  let query: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--lead') {
      leads = splitList(args[++i])
    } else if (a.startsWith('--lead=')) {
      leads = splitList(a.slice('--lead='.length))
    } else if (a === '--scene') {
      scene = normalizeScene(splitList(args[++i]))
    } else if (a.startsWith('--scene=')) {
      scene = normalizeScene(splitList(a.slice('--scene='.length)))
    } else if (a === '--query') {
      query = args[++i]
    } else if (a.startsWith('--query=')) {
      query = a.slice('--query='.length)
    } else {
      positionals.push(a)
    }
  }

  return { positionals, leads, scene, query }
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function normalizeScene(items: string[]): string | string[] | undefined {
  if (items.length === 0) return undefined
  return items.length === 1 ? items[0] : items
}

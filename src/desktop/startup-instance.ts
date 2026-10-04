/**
 * 启动实例定位——多库多窗（同机多库并排）的 pre-setPath 同步解析。
 *
 * `instanceKey` 必须在 `app.setPath('userData')` 之前算出（Electron 原生单实例锁的
 * 作用域 = userData 目录，「同库单实例、异库多实例」即由此成立），而 key 的输入是
 * 启动库路径。本模块把「启动库路径」的解析从 bootstrap 提到模块顶层可复用的纯函数：
 *
 *   `--dir`（主进程参数，先例 `--book`）> `<home>/workdir.json`.current > `findWorkDir(cwd)` > welcome
 *
 * 约束（勿破）：本函数在 app ready 之前同步执行——`workdir.json` 为共享根上本地小文件
 * 直读，库目录本身不做任何可达性探测（失联网络卷上的同步探测会冻启动链，慢盘面加固
 * 同族口径）。`findWorkDir(cwd)` 为既有点位（bootstrap 现行为）的前置镜像。
 *
 * 与 bootstrap 的关系：bootstrap 仍按原链定位（含异步可达性预探与回落），本模块另服务
 * 「算 key」这一件事；main.ts 的 bootstrap 同时消费本模块的解析结果（`--dir` 形态即
 * `source === 'arg'` 时以显式意图优先，见 main.ts launchCandidate 注），两者不一致的
 * 残余形态（current 失效 → bootstrap 回落 cwd 发现库）由 main.ts 记警告留痕，见设计正本 §六。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findWorkDir } from '../install/books.js'
import { parseStore } from './workdir-store.js'

export interface StartupLibraryResolution {
  /** 启动库绝对路径；null = welcome 态 */
  dir: string | null
  /** 解析来源（诊断留痕与测试锚） */
  source: 'arg' | 'current' | 'cwd' | 'welcome'
}

/** 取 `--dir <p>` / `--dir=<p>` 参数值（空白串视为未提供）。 */
export function dirArg(argv: string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith('--dir='))
  if (eq) {
    const v = eq.slice('--dir='.length).trim()
    if (v) return v
  }
  const i = argv.indexOf('--dir')
  const v = i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined
  const t = typeof v === 'string' ? v.trim() : ''
  return t || undefined
}

/** 切库 relaunch 的 argv 清洗：摘掉 `--dir`（及值）。
 *  `app.relaunch()` 默认继承当前实例 argv——不清 `--dir`（解析序里的最高优先级）会把
 *  重启后的实例顶回旧库；切库语义要求重启后按 `<home>/workdir.json`.current（已指向
 *  新库）解析。其余参数（`--book` 等）随行保持原语义。 */
export function stripDirArg(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dir') {
      i++ // 连值一起摘（值缺失时仅摘参数名本身）
      continue
    }
    if (a.startsWith('--dir=')) continue
    out.push(a)
  }
  return out
}

/** 读共享根上的 workdir.json.current（损坏/缺失 → null；零探测、不改状态）。
 *  parseStore 单源（与 workdir-controller/readStore 同款容错口径）。 */
function readStoredCurrent(homeDir: string): string | null {
  try {
    const store = parseStore(readFileSync(join(homeDir, 'workdir.json'), 'utf-8'))
    return store.current
  } catch {
    return null
  }
}

/** 解析启动库路径（见模块头注的解析序）。 */
export function resolveStartupLibraryDir(opts: { argv: string[]; homeDir: string; cwd: string }): StartupLibraryResolution {
  const fromArg = dirArg(opts.argv)
  if (fromArg) return { dir: resolve(fromArg), source: 'arg' }
  const current = readStoredCurrent(opts.homeDir)
  if (current) return { dir: resolve(current), source: 'current' }
  const found = findWorkDir(opts.cwd)
  if (found) return { dir: found, source: 'cwd' }
  return { dir: null, source: 'welcome' }
}

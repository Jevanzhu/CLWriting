/**
 * 重评-0914-三轮 P3-11：EACCES/读写失败注入平台分派助手（test 树 chmodSync 拒绝注入族单源）。
 *
 * 背景：test/ 全树 EACCES/读失败注入族原以 chmodSync(0o000/0o500/0o555) 实现——POSIX
 * 权限位拒绝语义在 win 上不存在（chmodSync 仅切只读位，读照常成功），全族被迫
 * skipIf(win32)：win 生产高发故障形态（杀毒/索引器/句柄占用导致的 EACCES/EPERM）
 * 零注入覆盖、win 本地无反馈。
 *
 * 平台分派（denyFs 内部自动切换）：
 * - POSIX 臂：保持 chmod 注入语义不变——拒绝期 chmod 0o000（或 opts.posixMode），
 *   restore 还原捕获的原始 mode；既有 posix 用例行为逐位不动，家族 chmod 字面量
 *   收编单源。
 * - win32 臂：chmod 拒读物理不可行，改按产品真实读取/写入函数注入——经 vi.mock
 *   包装的 node:fs / node:fs/promises 命名空间查 deny 登记表，命中目标路径即抛
 *   EACCES 形态错误（code/errno/syscall/path 对齐 Node 原生信封，syscall 按操作
 *   分别为 open/scandir/rename/link/mkdir/rm），未命中路径原样直通。
 *
 * 用法（两件套，缺一不可）：
 *  1) 测试文件顶部声明模块包装（vi.mock 提升至文件首；包装后本文件模块图内所有
 *     node:fs 调用都过登记表，登记表为空时零行为差异直通）：
 *       vi.mock('node:fs', async (importOriginal) => {
 *         const actual = await importOriginal<typeof import('node:fs')>()
 *         const { armFsNamespace } = await import('../helpers/fs-deny.js')
 *         return armFsNamespace('fs', actual) as typeof actual
 *       })
 *       vi.mock('node:fs/promises', async (importOriginal) => {
 *         const actual = await importOriginal<typeof import('node:fs/promises')>()
 *         const { armFsNamespace } = await import('../helpers/fs-deny.js')
 *         return armFsNamespace('fsp', actual) as typeof actual
 *       })
 *  2) 用例内以 denyRead / denyDirList / denyWriteUnder（或低层 denyFs）注入，
 *     restore 交由既有 try/finally 或 afterEach——与原 chmodSync/还原成对形态同构。
 *
 * win32 臂若文件未声明对应 ns 的 vi.mock 包装，deny* 立即抛错拒绝注入（拒读失败
 * 会无声失效转假绿，绝不静默）；POSIX 臂不依赖包装，未声明文件的 posix 用例不受影响。
 *
 * 实现纪律（重评-0914-三轮 P3-11 补丁）：本文件**不得静态 import node:fs / node:fs/promises**
 * ——测试文件对本文件的静态导入若先于 node:fs mock 工厂完成，会形成「fs-deny 求值中
 * → import node:fs → mock 工厂 → 工厂内 await import fs-deny（仍求值中）」循环 await，
 * 模块收集期死锁（不受 testTimeout 保护，vitest 静默挂死）。POSIX 臂的 chmod/stat 改经
 * createRequire 运行时取真模块（绕开 mock 注册表——物理 chmod 本就要作用于真文件系统，
 * 取被 mock 的包装反而语义错误）。测试文件对本文件的导入顺序自此不再有约束。
 */
import { createRequire } from 'node:module'
import { isAbsolute, resolve, sep } from 'node:path'

/** 登记的拒绝操作键：'<ns>:<fn>'。win 臂命中即抛 EACCES 形态错误。 */
const SYSCALL_BY_OP: Readonly<Record<string, string>> = {
  'fs:readFileSync': 'open',
  'fs:readdirSync': 'scandir',
  'fs:writeFileSync': 'open',
  'fs:appendFileSync': 'open',
  'fs:openSync': 'open',
  'fs:renameSync': 'rename',
  'fs:linkSync': 'link',
  'fs:rmSync': 'rm',
  'fs:unlinkSync': 'unlink',
  'fs:rmdirSync': 'rmdir',
  'fs:statSync': 'stat',
  'fs:createReadStream': 'open',
  'fsp:readFile': 'open',
  'fsp:readdir': 'scandir',
  'fsp:writeFile': 'open',
  'fsp:appendFile': 'open',
  'fsp:open': 'open',
  'fsp:rename': 'rename',
  'fsp:rm': 'rm',
  'fsp:stat': 'stat',
}

/** 包装的同步命名空间函数集（utimesSync/existsSync 有意不包装：posix chmod 拒读
 *  语义下存在性探测照常成功，多个用例显式依赖「stat/exists 可用、读被拒」形态）。 */
const WRAP_SYNC = [
  'readFileSync',
  'readdirSync',
  'writeFileSync',
  'appendFileSync',
  'openSync',
  'renameSync',
  'linkSync',
  'rmSync',
  'unlinkSync',
  'rmdirSync',
  'statSync',
  'createReadStream',
] as const
/** 包装的 promises 命名空间函数集。 */
const WRAP_FSP = ['readFile', 'readdir', 'writeFile', 'appendFile', 'open', 'rename', 'rm', 'stat'] as const

interface DenyEntry {
  targets: readonly string[]
  children: boolean
  ops: ReadonlySet<string>
}

const registry: DenyEntry[] = []
const armed = new Set<'fs' | 'fsp'>()

/** 供测试文件 vi.mock 工厂调用：返回以登记表拦截指定函数、其余原样的模块替身。 */
export function armFsNamespace<T extends object>(ns: 'fs' | 'fsp', actual: T): T {
  armed.add(ns)
  const names = ns === 'fs' ? WRAP_SYNC : WRAP_FSP
  const source = actual as Record<string, unknown>
  const out: Record<string, unknown> = { ...source }
  for (const name of names) {
    const orig = source[name]
    if (typeof orig !== 'function') continue
    const opKey = `${ns}:${name}`
    out[name] = (...args: unknown[]) => {
      if (registry.length !== 0) {
        for (const entry of registry) {
          if (!entry.ops.has(opKey)) continue
          const hit = hitArg(args, entry)
          if (hit !== null) throw eacces(SYSCALL_BY_OP[opKey] ?? 'io', hit)
        }
      }
      return (orig as (...a: unknown[]) => unknown)(...args)
    }
  }
  return out as T
}

/** 首个命中拒绝目标的字符串参数（绝对路径/Buffer）；未命中返 null。 */
function hitArg(args: readonly unknown[], entry: DenyEntry): string | null {
  for (const arg of args) {
    if (typeof arg !== 'string' && !Buffer.isBuffer(arg)) continue
    const p = typeof arg === 'string' ? arg : arg.toString()
    if (!isAbsolute(p)) continue
    const abs = resolve(p)
    for (const t of entry.targets) {
      if (abs === t || (entry.children && abs.startsWith(t + sep))) return abs
    }
  }
  return null
}

/** EACCES 形态错误（code/errno/syscall/path 对齐 Node 原生权限拒绝信封）。 */
function eacces(syscall: string, p: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, ${syscall} '${p}'`) as NodeJS.ErrnoException
  err.code = 'EACCES'
  err.errno = -13
  err.syscall = syscall
  err.path = p
  return err
}

export interface FsDenyOptions {
  /** 参与拦截的操作键（'<ns>:<fn>' 形态）；省略 = 读族默认。 */
  ops?: readonly string[]
  /** 目录拒绝：目标自身及子路径都算命中（chmod 目录 0o500/0o555 形态）；默认仅精确匹配。 */
  children?: boolean
  /** POSIX 臂 chmod 的拒绝 mode（默认 0o000）。 */
  posixMode?: number
}

export interface FsDenyGuard {
  /** 解除注入：posix 还原 mode；win 摘除登记项（幂等）。 */
  restore(): void
}

/** 低层注入：平台分派——win 臂登记拦截（要求测试文件已声明对应 ns 的 vi.mock 包装，
 *  否则抛错），posix 臂 chmod（语义同既有 chmodSync 家族）。 */
export function denyFs(targets: string | readonly string[], opts: FsDenyOptions = {}): FsDenyGuard {
  const list = (Array.isArray(targets) ? targets : [targets]).map((t) => resolve(t))
  if (process.platform === 'win32') {
    const ops = new Set(opts.ops ?? ['fs:readFileSync', 'fsp:readFile'])
    const missing = [...ops].map((op) => op.split(':')[0] as 'fs' | 'fsp').filter((ns) => !armed.has(ns))
    if (missing.length !== 0) {
      throw new Error(
        `fs-deny: win32 注入要求测试文件先对 [${[...new Set(missing)].join(', ')}] 声明 ` +
          'armFsNamespace 的 vi.mock 包装（见 helpers/fs-deny.ts 头注）——缺包装的注入会无声失效转假绿',
      )
    }
    const entry: DenyEntry = { targets: list, children: opts.children ?? false, ops }
    registry.push(entry)
    return {
      restore() {
        const i = registry.indexOf(entry)
        if (i !== -1) registry.splice(i, 1)
      },
    }
  }
  const realFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')
  // 嵌套目标（父目录+子路径同时拒绝，如 H501 拒 bookRoot 及其父）时 chmod 的路径遍历
  // 依赖祖先 +x：deny 须深先（chmod 子路径时父尚未锁），restore 须浅先（解锁任何路径
  // 前其祖先须已还原）——按路径深度定序，与传入顺序解耦；平坦目标集排序为恒等。
  const depth = (p: string): number => p.split(sep).length
  const saved = list.map((t) => ({ t, mode: realFs.statSync(t).mode & 0o777 })).sort((a, b) => depth(b.t) - depth(a.t))
  const denyMode = opts.posixMode ?? 0o000
  for (const s of saved) realFs.chmodSync(s.t, denyMode)
  return {
    restore() {
      for (const s of [...saved].reverse()) realFs.chmodSync(s.t, s.mode)
    },
  }
}

/** 文件读拒绝（readFileSync + fsp.readFile，产品两套读取形态双覆盖）。 */
export function denyRead(targets: string | readonly string[], opts: FsDenyOptions = {}): FsDenyGuard {
  return denyFs(targets, { ops: ['fs:readFileSync', 'fsp:readFile'], ...opts })
}

/** 目录列举拒绝（readdirSync + fsp.readdir，目标目录自身）。 */
export function denyDirList(dir: string, opts: FsDenyOptions = {}): FsDenyGuard {
  return denyFs(dir, { ops: ['fs:readdirSync', 'fsp:readdir'], ...opts })
}

/** 目录下写拒绝（posix chmod 目录 0o500/0o555 形态；children 命中目录内所有路径）。
 *  mkdir 有意不在默认集：posix 上对已存在目录 recursive mkdir 无需写位，win 臂拒 mkdir
 *  会偏离 posix 语义；确需拒新建子目录的用例经 opts.ops 显式加 'fs:mkdirSync'。 */
export function denyWriteUnder(dir: string, opts: FsDenyOptions = {}): FsDenyGuard {
  return denyFs(dir, {
    ops: [
      'fs:writeFileSync',
      'fs:appendFileSync',
      'fs:openSync',
      'fs:linkSync',
      'fs:renameSync',
      'fsp:writeFile',
      'fsp:open',
      'fsp:rename',
    ],
    children: true,
    ...opts,
  })
}

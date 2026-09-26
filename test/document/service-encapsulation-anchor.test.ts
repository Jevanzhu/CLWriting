/**
 * R0916-7-P3-8（2026-09-25，源码质量评审 P3-8）封装面锚：源级不变量，防「再剥 private」回潮。
 *
 * 评审病灶：为跨文件复用，service.ts 把字段/方法剥 private 并标 `@internal`（约 :205-214、
 * :289、:838、:872、:1078），另在文件头保留 service-guards 的逐名 re-export 转发桥
 * （约 :70-81）——任何模块都能改类内部状态，且同一 import 面双轨（桥 / 正本）。
 *
 * 本文件钉四条不变量（全部为源码级断言，行为面由 doc-context / service-ops-direct /
 * 既有用例族持有）：
 * 1. `@internal` 裸露面归零：src/document/** 代码面（剥注释）不再出现 `@internal`，
 *    service.ts 类体不再有 bookRoot/journalDir/snapshotsDir/manifestPath 四个剥 private 字段；
 * 2. 转发桥已删：service.ts 无任何 `export { ... }` 转发块（原桥形态）；
 * 3. 旧路径已无引用：src（除 web-next 子包）与 test 全量扫描——没有模块再从
 *    document/service.js 取锁档/守卫名（双轨残留 = 0）；
 * 4. 设施单源：DocContext 的每实例可变状态一律 private，journal 路径只经
 *    ctx.journalPathOf 构造（三个操作文件不得再手拼 `.jsonl`），组装点全仓唯一。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')
const DOCUMENT_SERVICE_PATH = join(SRC_ROOT, 'document', 'service.ts')

/** 原转发桥导出的名字（service.ts 曾逐名 re-export）——再从旧路径取即双轨残留。 */
const BRIDGED_NAMES = [
  'isUtf8Bytes',
  'META_SAVE_LOCK_TIMEOUT_MS',
  'getMetaSaveLockTimeoutMs',
  '__setMetaSaveLockTimeoutForTest',
  'getStructSaveLockTimeoutMs',
  '__setStructSaveLockTimeoutForTest',
  'WIRING_SAVE_LOCK_TIMEOUT_MS',
  'getWiringSaveLockTimeoutMs',
  '__setWiringSaveLockTimeoutForTest',
  'SAVE_LOCK_TIMEOUT_MS',
]

/** 逐行剥注释（`//` 起头与块注释延续行；对齐 r38-batch-f 的静态扫描做法）。 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

/** 递归收集 .ts/.vue 源文件（跳过 node_modules、点目录与前端子包 web-next——独立包不在本收编面）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'web-next' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collectSources(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 文件里所有 import 子句（含 type 形态）→ [绑定文本, 解析后目标文件（.js→.ts）]。 */
function importClauses(file: string): { bindings: string; target: string }[] {
  const src = readFileSync(file, 'utf-8')
  if (!src.includes('service.js')) return [] // 早退：绝大多数文件没有该形态的 import
  const out: { bindings: string; target: string }[] = []
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ bindings: m[1]!, target: resolve(dirname(file), m[2]!).replace(/\.js$/, '.ts') })
  }
  return out
}

describe('R0916-7-P3-8: 封装面锚（@internal 裸露 / 转发桥 / 双轨残留）', () => {
  it('@internal 裸露面归零：src/document 无 @internal 标记行、代码面零残留', () => {
    const offenders: string[] = []
    for (const f of collectSources(join(SRC_ROOT, 'document'))) {
      const raw = readFileSync(f, 'utf-8')
      // 标记行形态（注释前缀后紧跟 @internal）——散文里提及 `@internal` 的历史记账不算
      if (raw.split('\n').some((l) => /^\s*(?:\/\*\*|\*|\/\/)\s*@internal\b/.test(l)))
        offenders.push(`${f.replace(REPO_ROOT, '')}: 标记行`)
      if (stripComments(raw).includes('@internal')) offenders.push(`${f.replace(REPO_ROOT, '')}: 代码面`)
    }
    expect(offenders).toEqual([])
  })

  it('service.ts 类体不再有「剥 private」的设施字段（路径四件归 ctx）', () => {
    const code = stripComments(readFileSync(DOCUMENT_SERVICE_PATH, 'utf-8'))
    for (const field of ['bookRoot', 'journalDir', 'snapshotsDir', 'manifestPath']) {
      expect(code, `${field} 字段仍裸露在 service.ts`).not.toMatch(
        new RegExp(`(readonly|public|private|protected)\\s+${field}\\s*:`),
      )
    }
    // 门面只持两件：显式 ctx 与注入队列
    expect(code).toContain('readonly ctx: DocContext')
    expect(code).toContain('private readonly queue: SaveQueue<SaveResult>')
  })

  it('转发桥已删：service.ts 无 `export { ... }` 转发块、无 from 重导出', () => {
    const code = stripComments(readFileSync(DOCUMENT_SERVICE_PATH, 'utf-8'))
    expect(code).not.toMatch(/export\s*\{/)
    expect(code).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from\s*['"]/)
  })

  it('旧路径已无引用：src/test 全量扫描——无人再从 document/service.js 取桥名（双轨残留=0）', () => {
    const offenders: string[] = []
    const files = [...collectSources(SRC_ROOT), ...collectSources(join(REPO_ROOT, 'test'))]
    // 自检：扫描面确实铺开（防路径写错 → 静默空跑，CLAUDE.md 测试分层已记此坑）
    expect(files.length).toBeGreaterThan(1000)
    for (const f of files) {
      for (const { bindings, target } of importClauses(f)) {
        if (target !== DOCUMENT_SERVICE_PATH) continue
        for (const name of BRIDGED_NAMES) {
          if (new RegExp(`\\b${name}\\b`).test(bindings)) offenders.push(`${f.replace(REPO_ROOT, '')}: ${name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('设施单源：journal 路径只经 ctx.journalPathOf（操作文件不再手拼 `.jsonl`）', () => {
    for (const rel of ['service.ts', 'service-meta.ts', 'service-move.ts']) {
      const code = stripComments(readFileSync(join(SRC_ROOT, 'document', rel), 'utf-8'))
      expect(code, `${rel} 手拼 journal 路径（应走 ctx.journalPathOf）`).not.toMatch(
        /encodeDocDirName\([^)]*\)\}\.jsonl/,
      )
      expect(code, `${rel} 缺 ctx.journalPathOf 接线`).toContain('journalPathOf(')
    }
  })

  it('设施单源：DocContext 每实例可变状态一律 private，组装点全仓唯一', () => {
    const ctxCode = stripComments(readFileSync(join(SRC_ROOT, 'document', 'doc-context.ts'), 'utf-8'))
    for (const field of ['globalPolicyCache', 'docWordsCache', 'metaOpChains']) {
      expect(ctxCode, `${field} 未标 private`).toMatch(new RegExp(`private\\s+${field}\\b`))
    }
    const hits = collectSources(SRC_ROOT).filter((f) =>
      /new DocContext\(/.test(stripComments(readFileSync(f, 'utf-8'))),
    )
    expect(hits).toEqual([DOCUMENT_SERVICE_PATH]) // 平台无关比较（win 反斜杠不参与断言）
  })

  it('锁档单源（R0916-7-P3-6）：save/meta/wiring 三档只经 ctx 字段消费，模块级注入口不再存在', () => {
    // 消费面：service.ts / service-meta.ts / service-move.ts 代码面不得再出现已删的
    // META/WIRING/SAVE 钩子与 getter（含裸 saveLockTimeoutMs 别名）——锁档经 ctx 字段。
    const retired = [
      'getMetaSaveLockTimeoutMs',
      '__setMetaSaveLockTimeoutForTest',
      'getWiringSaveLockTimeoutMs',
      '__setWiringSaveLockTimeoutForTest',
    ]
    for (const rel of ['service.ts', 'service-meta.ts', 'service-move.ts']) {
      const code = stripComments(readFileSync(join(SRC_ROOT, 'document', rel), 'utf-8'))
      for (const name of retired) {
        expect(code, `${rel} 仍引用已删锁档缝 ${name}（应读 ctx 锁档字段）`).not.toContain(name)
      }
    }
    expect(
      stripComments(readFileSync(join(SRC_ROOT, 'document', 'service.ts'), 'utf-8')),
      'executeSave 锁档未接 ctx.saveLockTimeoutMs',
    ).toContain('ctx.saveLockTimeoutMs')
    // 定义面：service-guards 不再持有 META/WIRING 的 ForTest 注入口（STRUCT 因 studio
    // 组装点内建 service 消费而保留，见其注——不在本断言面）。
    const guardsCode = stripComments(readFileSync(join(SRC_ROOT, 'document', 'service-guards.ts'), 'utf-8'))
    expect(guardsCode, 'META 注入口应已删（收敛入 DocContext）').not.toContain('__setMetaSaveLockTimeoutForTest')
    expect(guardsCode, 'WIRING 注入口应已删（收敛入 DocContext）').not.toContain('__setWiringSaveLockTimeoutForTest')
    // 生效值持有面：DocContext 三档只读字段在位
    const ctxFields = stripComments(readFileSync(join(SRC_ROOT, 'document', 'doc-context.ts'), 'utf-8'))
    for (const field of ['saveLockTimeoutMs', 'metaSaveLockTimeoutMs', 'wiringSaveLockTimeoutMs']) {
      expect(ctxFields, `DocContext 缺锁档字段 ${field}`).toMatch(new RegExp(`readonly\\s+${field}\\b`))
    }
  })

  it('自检：锚定路径存在且 stripComments 确实剥注释（防锚本身空转）', () => {
    expect(existsSync(DOCUMENT_SERVICE_PATH)).toBe(true)
    expect(stripComments('// x\nconst a = 1\n * y\n/** z */\n')).toBe('const a = 1\n')
  })
})

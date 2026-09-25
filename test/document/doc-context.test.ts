/**
 * R0916-7-P3-8（2026-09-25，源码质量评审 P3-8）回归：DocContext 组装与显式设施直测。
 *
 * 背景：原 service.ts 为让 service-meta.ts 复用锁/清单/路径安全/快照策略，把字段与方法
 * 剥 private 并标 `@internal`，任何模块都能从类实例上摸内部状态。本批改为显式上下文
 * DocContext（doc-context.ts）+ 模块级操作函数 `(ctx, params)`。
 *
 * 覆盖（评审要求的「DocContext 组装与操作函数直测」前半）：
 * 1. 组装：path 四件由 bookRoot 派生（口径逐段钉定）+ userDataPath 缺省 null；
 * 2. journalPathOf 单源：`:`→`_` 编码口径（R68-3）不再散落各操作；
 * 3. resolveSafePath：越界 fail-closed / 书内普通路径放行；
 * 4. withSaveLocks：save 锁 → 布线锁 → body → 逆序释放；holdSaveLock=false 不取锁；
 *    save 锁超时 fail-closed 走调用方回调（不执行 body）；
 * 5. 清单族：lookup（含 legacy 收编）/ upsert / maybeUpdateManifest / updateManifestPath；
 * 6. snapshotPolicy：global.json 覆盖 + 默认档回落（throttleMinutes 恒默认）；
 * 7. 每实例缓存：cachedDocWords/rememberDocWords 的 rev 键控（换版即失效）；
 * 8. chainDocMetaOp：同 docId 串行、跨 docId 不互相阻塞。
 * 9. 锁档容器（R0916-7-P3-6）：save/meta/wiring 三档缺省 = 生产常量（逐位不变）、
 *    注入档构造期生效（per-ctx 组装参数，原模块级 ForTest 钩子收敛入此）。
 *
 * 不覆盖：与既有用例重复的行为面（r30-snapshot-policy-cache 的 stat 缓存、r31c 的 legacy
 * 收编明细）——本文件只锚「显式设施可用且口径不变」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DocContext } from '../../src/document/doc-context.js'
// R0916-7-P3-6：锁档常量（生产默认值单源）——缺省档逐位锚定
import { META_SAVE_LOCK_TIMEOUT_MS, WIRING_SAVE_LOCK_TIMEOUT_MS, SAVE_LOCK_TIMEOUT_MS } from '../../src/document/service-guards.js'
import { DEFAULT_VERSION_POLICY, encodeDocDirName } from '../../src/document/version.js'
import { readManifest, upsertEntry, writeManifest } from '../../src/document/manifest.js'
import { legacyId } from '../../src/document/stable-id.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

describe('R0916-7-P3-8: DocContext 组装与显式设施', () => {
  let root: string
  let ctx: DocContext

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-ctx-'))
    ctx = new DocContext({ bookRoot: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('组装：四路径由 bookRoot 派生，userDataPath 缺省 null', () => {
    expect(ctx.bookRoot).toBe(root)
    expect(ctx.userDataPath).toBeNull()
    expect(ctx.journalDir).toBe(join(root, '工作区', '.journal'))
    expect(ctx.snapshotsDir).toBe(join(root, '工作区', '.版本'))
    expect(ctx.manifestPath).toBe(join(root, '项目', '文档清单.jsonl'))
    // 注入形态（userDataPath 非空）只影响快照策略读侧，不改路径四件
    const ctx2 = new DocContext({ bookRoot: root, userDataPath: join(root, 'ud') })
    expect(ctx2.userDataPath).toBe(join(root, 'ud'))
    expect(ctx2.manifestPath).toBe(ctx.manifestPath)
  })

  it('journalPathOf 单源：R68-3 编码口径（`:`→`_`）', () => {
    expect(ctx.journalPathOf('doc_1')).toBe(join(root, '工作区', '.journal', 'doc_1.jsonl'))
    expect(ctx.journalPathOf('legacy:正文/0001.md')).toBe(
      join(root, '工作区', '.journal', `${encodeDocDirName('legacy:正文/0001.md')}.jsonl`),
    )
    expect(ctx.journalPathOf('legacy:正文/0001.md')).toContain('legacy_正文')
  })

  it('resolveSafePath：越界 fail-closed，书内路径放行', () => {
    expect(ctx.resolveSafePath('../../etc/passwd')).toBeNull()
    expect(ctx.resolveSafePath('写作/正文/0001-开篇.md')).toBe(join(root, '写作', '正文', '0001-开篇.md'))
  })

  it('withSaveLocks：save 锁 → 布线锁 → body 内可见 → finally 逆序释放', async () => {
    const journalPath = ctx.journalPathOf('doc_lock')
    const wiringRel = '布线/悬念/0001-线索.md'
    let sawSaveLock = false
    let sawWiringLock = false
    const out = await ctx.withSaveLocks({
      journalPath,
      saveTimeoutMs: 1_000,
      onSaveLockThrown: () => 'thrown',
      onSaveLockTimeout: () => 'timeout',
      wiring: {
        relPath: wiringRel,
        timeoutMs: 1_000,
        onThrown: () => 'wiring-thrown',
        onTimeout: () => 'wiring-timeout',
      },
      body: async () => {
        sawSaveLock = existsSync(`${journalPath}.save.lock`)
        sawWiringLock = existsSync(ctx.wiringFileLockKey(wiringRel)!)
        return 'body'
      },
    })
    expect(out).toBe('body')
    expect(sawSaveLock).toBe(true)
    expect(sawWiringLock).toBe(true)
    // 释放：两把锁文件均已删除（release 幂等）
    expect(existsSync(`${journalPath}.save.lock`)).toBe(false)
    expect(existsSync(ctx.wiringFileLockKey(wiringRel)!)).toBe(false)
  })

  it('withSaveLocks：holdSaveLock=false 不取 save 锁（调用方已持，防同进程嵌套自锁）', async () => {
    const journalPath = ctx.journalPathOf('doc_hold')
    const out = await ctx.withSaveLocks({
      journalPath,
      holdSaveLock: false,
      saveTimeoutMs: 1_000,
      onSaveLockThrown: () => 'thrown',
      onSaveLockTimeout: () => 'timeout',
      body: async () => {
        expect(existsSync(`${journalPath}.save.lock`)).toBe(false)
        return 'body'
      },
    })
    expect(out).toBe('body')
  })

  it('withSaveLocks：save 锁被活进程占住 → 按超时回调收口，body 不执行', async () => {
    const journalPath = ctx.journalPathOf('doc_busy')
    mkdirSync(dirname(journalPath), { recursive: true })
    // 活 pid 探针锁（与锁基建落盘格式一致，同 r30-timeout-consts 手法）
    writeFileSync(`${journalPath}.save.lock`, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    let ran = false
    const out = await ctx.withSaveLocks({
      journalPath,
      saveTimeoutMs: 0,
      onSaveLockThrown: () => 'thrown',
      onSaveLockTimeout: () => 'timeout',
      body: async () => {
        ran = true
        return 'body'
      },
    })
    expect(out).toBe('timeout')
    expect(ran).toBe(false)
  })

  it('锁档容器：缺省 = 生产常量档，注入档构造期生效（R0916-7-P3-6 per-ctx 收敛）', () => {
    // 缺省逐位不变：save/meta/wiring 三档 = service-guards 生产常量
    expect(ctx.saveLockTimeoutMs).toBe(SAVE_LOCK_TIMEOUT_MS)
    expect(ctx.saveLockTimeoutMs).toBe(5_000)
    expect(ctx.metaSaveLockTimeoutMs).toBe(META_SAVE_LOCK_TIMEOUT_MS)
    expect(ctx.metaSaveLockTimeoutMs).toBe(5_000)
    expect(ctx.wiringSaveLockTimeoutMs).toBe(WIRING_SAVE_LOCK_TIMEOUT_MS)
    expect(ctx.wiringSaveLockTimeoutMs).toBe(5_000)
    // 注入档在构造期生效且实例期内恒定（readonly 字段，无运行期改写通道）
    const short = new DocContext({ bookRoot: root, saveLockTimeoutMs: 1_000, metaSaveLockTimeoutMs: 150, wiringSaveLockTimeoutMs: 80 })
    expect(short.saveLockTimeoutMs).toBe(1_000)
    expect(short.metaSaveLockTimeoutMs).toBe(150)
    expect(short.wiringSaveLockTimeoutMs).toBe(80)
    // 单档注入不影响其余档（缺省回落常量）
    const partial = new DocContext({ bookRoot: root, wiringSaveLockTimeoutMs: 80 })
    expect(partial.saveLockTimeoutMs).toBe(5_000)
    expect(partial.metaSaveLockTimeoutMs).toBe(5_000)
    expect(partial.wiringSaveLockTimeoutMs).toBe(80)
  })

  it('清单族：upsert → lookup 命中；maybeUpdateManifest/updateManifestPath 改 path', async () => {
    mkdirSync(join(root, '项目'), { recursive: true })
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n---\n', 'utf-8')
    await ctx.upsertManifestEntryAsync('doc_m', '写作/正文/0001-开篇.md')
    expect(readManifest(ctx.manifestPath).entries.get('doc_m')?.path).toBe('写作/正文/0001-开篇.md')
    expect(await ctx.lookupPathByDocIdAdoptAsync('doc_m')).toBe('写作/正文/0001-开篇.md')
    // maybeUpdateManifest（保存后清单刷新用的 no-op-on-absent 形态）
    await ctx.maybeUpdateManifest('doc_m', '写作/正文/0002-改名.md')
    expect(readManifest(ctx.manifestPath).entries.get('doc_m')?.path).toBe('写作/正文/0002-改名.md')
    await ctx.updateManifestPath('doc_m', '写作/正文/0003-再改.md')
    expect(readManifest(ctx.manifestPath).entries.get('doc_m')?.path).toBe('写作/正文/0003-再改.md')
    // 未登记且非 legacy → null（不触发收编）
    expect(await ctx.lookupPathByDocIdAdoptAsync('doc_absent')).toBeNull()
  })

  it('清单族：legacy 收编——扫盘反查命中后经清单锁补登记', async () => {
    mkdirSync(join(root, '设定'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeFileSync(join(root, '设定', '世界观.md'), '---\n---\n', 'utf-8')
    const id = legacyId('设定/世界观.md')
    expect(await ctx.lookupPathByDocIdAdoptAsync(id)).toBe('设定/世界观.md')
    expect(readManifest(ctx.manifestPath).entries.get(id)?.path).toBe('设定/世界观.md')
  })

  it('snapshotPolicy：global.json 覆盖 maxDays/maxCount，throttleMinutes 恒默认档', () => {
    const userData = mkdtempSync(join(tmpdir(), 'doc-ctx-ud-'))
    try {
      writeFileSync(join(userData, 'global.json'), '{"snapMaxCount":2,"snapMaxDays":90}')
      const withUd = new DocContext({ bookRoot: root, userDataPath: userData })
      expect(withUd.snapshotPolicy()).toEqual({ maxDays: 90, maxCount: 2, throttleMinutes: DEFAULT_VERSION_POLICY.throttleMinutes })
      // 无 global.json / 无 userDataPath → 全默认档
      expect(ctx.snapshotPolicy()).toEqual(DEFAULT_VERSION_POLICY)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('每实例缓存：cachedDocWords 按 revision 键控（换版即失效）', () => {
    expect(ctx.cachedDocWords('doc_w', 'sha256:a')).toBeUndefined()
    ctx.rememberDocWords('doc_w', 'sha256:a', 42)
    expect(ctx.cachedDocWords('doc_w', 'sha256:a')).toBe(42)
    expect(ctx.cachedDocWords('doc_w', 'sha256:b')).toBeUndefined() // 换版失效
    expect(ctx.cachedDocWords('doc_other', 'sha256:a')).toBeUndefined() // 键隔离
    // 每实例隔离：另一 ctx 看不到本实例缓存
    const other = new DocContext({ bookRoot: root })
    expect(other.cachedDocWords('doc_w', 'sha256:a')).toBeUndefined()
  })

  it('chainDocMetaOp：同 docId 串行（不交错），跨 docId 并行', async () => {
    const order: string[] = []
    const gate = (name: string, ms: number) => async () => {
      order.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`${name}:end`)
    }
    await Promise.all([ctx.chainDocMetaOp('doc_a', gate('a1', 20)), ctx.chainDocMetaOp('doc_a', gate('a2', 0))])
    expect(order).toEqual(['a1:start', 'a1:end', 'a2:start', 'a2:end'])
    order.length = 0
    await Promise.all([ctx.chainDocMetaOp('doc_b', gate('b1', 20)), ctx.chainDocMetaOp('doc_c', gate('c1', 0))])
    expect(order).toEqual(['b1:start', 'c1:start', 'c1:end', 'b1:end'])
  })

  it('清单写入工具与 ctx 同源（readManifest 读到 upsertEntry 之外的手写形态亦不误判）', async () => {
    mkdirSync(join(root, '项目'), { recursive: true })
    const m = { version: 1 as const, entries: new Map() }
    upsertEntry(m, { id: 'doc_raw', nodeType: 'document', path: '写作/正文/0009-手写.md', parentId: null })
    writeManifest(ctx.manifestPath, m)
    expect(await ctx.lookupPathByDocIdAdoptAsync('doc_raw')).toBe('写作/正文/0009-手写.md')
  })
})

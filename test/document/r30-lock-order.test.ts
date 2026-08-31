/**
 * R30-5（三十轮）回归：save↔finalize 锁序统一为「布线锁 → 清单锁」。
 *
 * 旧序对：executeSave 持布线锁后内取清单锁（maybeUpdateManifest），而
 * finalizeRevision 持清单锁（withManifestLock 包裹全段）内由 applyLeadUpdates 再取
 * 同名布线文件锁——双进程对同一布线文件并发时构成 wiring→manifest vs
 * manifest→wiring 的 ABBA 等待（旧靠 5s/2×5s 超时兜底不死锁）。修后定稿入口在进入
 * 清单锁**之前**预取全部目标布线锁（取不到 → LEAD_WRITE_ERROR fail-closed）。
 *
 * 场景（真双进程，spawn + tsx eval，同 workspace-session-race 惯例）：
 * 1. P1 持布线锁（探针锁，pid=父进程，对子进程即「他进程在持」）→ P2 finalize
 *    → LEAD_WRITE_ERROR，且定稿未生效（版本未写、清单基线未落、他人锁未被误删）；
 * 2. 反向：P1（子进程）持清单锁 → P2 finalize 先取布线锁成功（等待清单锁期间，
 *    第三方以 0ms 档抢布线锁必须失败）再等清单锁，P1 释放后 P2 完成，全程有界。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { armWatchdog } from '../helpers/spawn-node.js'
import { finalizeRevision, finalizeRevisionAsync } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry, __setManifestLockTimeoutForTest, type Manifest } from '../../src/document/manifest.js'
import { __setLeadFinalizeLockTimeoutForTest } from '../../src/document/lead-finalize.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { processBootTime, acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { readLead } from '../../src/format/leads.js'
import { VERSIONS_DIR_NAME } from '../../src/document/version.js'

const BODY = '玉佩在火光里泛出微芒。'
const LEAD_REL = join('布线', '悬念', '悬念-001-玉佩.md')

let roots: string[] = []
function makeWiredBook(): { root: string; docId: string; leadAbs: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'r30-lockorder-'))
  roots.push(root)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-开篇.md'),
    `---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY}\n`,
    'utf-8',
  )
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  const leadAbs = join(root, LEAD_REL)
  writeFileSync(leadAbs, '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: 悬念-001\n---\n\n本章细纲。\n', 'utf-8')
  writeFileSync(join(root, '工作区', '账本推进.md'), `- 悬念-001 递进：${BODY}\n`, 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m: Manifest = { version: 1, entries: new Map() }
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, docId, leadAbs, manifestPath }
}

afterEach(() => {
  __setLeadFinalizeLockTimeoutForTest(5_000)
  __setManifestLockTimeoutForTest(5_000)
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

/** 探针锁（pid=本进程，对其他进程即「他进程在持」）。 */
function holdProbeLock(targetAbs: string): void {
  mkdirSync(join(targetAbs, '..'), { recursive: true })
  writeFileSync(`${targetAbs}.lock`, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

/** spawn 子进程跑一段 TS 脚本（--import tsx，同 workspace-session-race 惯例）。
 *  R32-37：看门狗兜底防孤儿进程（挂死子进程 60s 后 SIGKILL）；退出码原样透传
 *  （调用方自断言 code）。 */
function spawnTS(script: string): Promise<{ code: number | null; out: string; stderr: string }> {
  let out = ''
  let stderr = ''
  const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  armWatchdog(child, 60_000)
  child.stdout?.on('data', (c) => (out += c.toString('utf8')))
  child.stderr?.on('data', (c) => (stderr += c.toString('utf8')))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, stderr }))
  })
}

const finalizeSrc = fileURLToPath(new URL('../../src/document/finalize.ts', import.meta.url))

describe('R30-5 / 定稿布线预取锁（布线锁 → 清单锁）', () => {
  it('同步孪生：布线锁被持 → LEAD_WRITE_ERROR，版本未写、清单基线未落、他人锁未删', () => {
    const { root, docId, leadAbs, manifestPath } = makeWiredBook()
    holdProbeLock(leadAbs)
    __setLeadFinalizeLockTimeoutForTest(120) // 注入短档保快（fail-closed 语义不变）
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('LEAD_WRITE_ERROR')
      expect(r.error).toContain('布线锁预取失败')
    }
    // 定稿未生效：pinned 版本未写、清单基线未落
    expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME))).toBe(false)
    expect(readManifest(manifestPath).entries.get(docId)?.finalizedRevision).toBeUndefined()
    // fail-closed 不误删他人在位锁
    expect(existsSync(`${leadAbs}.lock`)).toBe(true)
    // 履历未回写（账本推进原样保留，下次定稿自动重试）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toContain('悬念-001 递进')
  })

  it('双进程：P1 持布线锁 → 子进程 P2 finalize → LEAD_WRITE_ERROR 且清单未被改动', async () => {
    const { root, docId, leadAbs, manifestPath } = makeWiredBook()
    holdProbeLock(leadAbs)
    const leadFinalizeSrc = fileURLToPath(new URL('../../src/document/lead-finalize.ts', import.meta.url))
    const script = `
import { finalizeRevisionAsync } from ${JSON.stringify(pathToFileURL(finalizeSrc).href)}
import { __setLeadFinalizeLockTimeoutForTest } from ${JSON.stringify(pathToFileURL(leadFinalizeSrc).href)}
__setLeadFinalizeLockTimeoutForTest(200)
finalizeRevisionAsync(${JSON.stringify(root)}, ${JSON.stringify(docId)}).then(
  (r) => { console.log('RESULT:' + JSON.stringify(r)); process.exit(0) },
  (e) => { console.error(String(e)); process.exit(1) },
)
`
    const child = await spawnTS(script)
    expect(child.code).toBe(0)
    const line = child.out.split('\n').find((l) => l.startsWith('RESULT:'))!
    const r = JSON.parse(line.slice('RESULT:'.length)) as { ok: boolean; code?: string }
    expect(r.ok).toBe(false)
    expect(r.code).toBe('LEAD_WRITE_ERROR')
    // 清单未被改动（P2 在进清单锁**之前**就被布线锁挡下——旧序会先写 pinned 版本）
    expect(readManifest(manifestPath).entries.get(docId)?.finalizedRevision).toBeUndefined()
    expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME))).toBe(false)
    expect(existsSync(`${leadAbs}.lock`)).toBe(true)
  }, 20_000)

  it('反向有界：P1 持清单锁 → P2 先取布线锁再等清单锁，P1 释放后 P2 完成（全程不死锁）', async () => {
    const { root, docId, leadAbs, manifestPath } = makeWiredBook()
    const crossProcessLockSrc = fileURLToPath(new URL('../../src/fs/cross-process-lock.ts', import.meta.url))
    const marker = join(root, 'p1-held.marker')
    const releaseMarker = join(root, 'p1-release.marker')
    // P1（子进程）：取清单锁 → 落 marker → 等 release marker → 释放退出
    const p1 = spawnTS(`
import { acquireCrossProcessLockWithTimeout } from ${JSON.stringify(pathToFileURL(crossProcessLockSrc).href)}
import { writeFileSync, existsSync } from 'node:fs'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const release = acquireCrossProcessLockWithTimeout(${JSON.stringify(`${manifestPath}.lock`)}, 1000)
  if (!release) { console.log('RESULT:LOCK_FAIL'); process.exit(1) }
  writeFileSync(${JSON.stringify(marker)}, '1', 'utf-8')
  const deadline = Date.now() + 8000
  while (!existsSync(${JSON.stringify(releaseMarker)}) && Date.now() < deadline) await wait(15)
  release()
  console.log('RESULT:P1_DONE')
  process.exit(0)
})().catch((e) => { console.error(String(e)); process.exit(1) })
`)
    // 等 P1 在持清单锁
    const t0 = Date.now()
    while (!existsSync(marker) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 15))
    expect(existsSync(marker)).toBe(true)

    // P2 finalize（本进程）：注入清单锁短档（有界），布线锁应**先**取得
    __setManifestLockTimeoutForTest(400)
    const finalizeP = finalizeRevisionAsync(root, docId)
    await new Promise((r) => setTimeout(r, 120))
    // 关键断言：P2 在等清单锁期间已持有布线锁（旧序此时布线锁空着，0ms 档可立即抢到）
    expect(acquireCrossProcessLockWithTimeout(`${leadAbs}.lock`, 0)).toBeNull()
    // P1 释放 → P2 完成
    writeFileSync(releaseMarker, '1', 'utf-8')
    const r = await finalizeP
    expect(r.ok).toBe(true)
    // 定稿产物齐备：基线 + 履历回写 + 本章源清空
    expect(readManifest(manifestPath).entries.get(docId)?.finalizedRevision).toBeTruthy()
    const lead = readLead(leadAbs)
    expect(lead.ok).toBe(true)
    if (lead.ok) expect(lead.lead.履历).toEqual([{ 章号: 1, 动词: '递进', 证据: BODY }])
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('')
    // P2 完成后布线锁已释放（不残留，第三方可立即取得）
    const postLock = acquireCrossProcessLockWithTimeout(`${leadAbs}.lock`, 0)
    expect(postLock).not.toBeNull()
    postLock?.()

    const p1r = await p1
    expect(p1r.code).toBe(0)
    expect(p1r.out).toContain('P1_DONE')
  }, 20_000)
})

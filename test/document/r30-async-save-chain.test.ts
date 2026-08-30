/**
 * R30-6（三十轮）回归：save 链锁等待异步化——executeSave 的 save 锁 / 布线锁 /
 * 清单锁等待全部走 setTimeout 轮询原语（acquireCrossProcessLockAsync /
 * withManifestLockAsync），双进程争用窗口内服务进程事件循环不被阻塞。
 *
 * 测法（探针锁形态，同 r72-save-lock/r29-doc-wiring-lock 惯例）：预置一把
 * 「活进程」锁文件模拟他进程在临界段内——保存方在等待期启动定时器，断言
 * 定时器在 save 尚未决（仍在等锁）时就已触发（同步 Atomics.wait 形态下主线程
 * 被睡住、定时器不可能先行触发）；随后移除探针锁模拟对方释放，保存须照常完成。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  DocumentService,
  __setWiringSaveLockTimeoutForTest,
  __setMetaSaveLockTimeoutForTest,
} from '../../src/document/service.js'
import { __setManifestLockTimeoutForTest, readManifest, writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

const WIRING_REL = '布线/悬念/悬念-001-灭门.md'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r30-async-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  __setWiringSaveLockTimeoutForTest(5_000)
  __setMetaSaveLockTimeoutForTest(5_000)
  __setManifestLockTimeoutForTest(5_000)
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 预置一把「活进程」探针锁（pid=本进程，必然存活，内容格式与锁基建一致）。 */
function holdProbeLock(targetAbs: string): void {
  mkdirSync(dirname(targetAbs), { recursive: true })
  writeFileSync(`${targetAbs}.lock`, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('R30-6: executeSave 布线锁等待不阻塞事件循环（定时器先行触发）；释放后保存照常完成', async () => {
  const wiringAbs = join(bookRoot, ...WIRING_REL.split('/'))
  holdProbeLock(wiringAbs)
  let timerFired = false
  setTimeout(() => {
    timerFired = true
  }, 50)
  const saveP = svc.save('doc_w1', WIRING_REL, {
    content: '---\n标题: 灭门\n---\n\n新正文',
    expectedRevision: null,
    operationId: 'op1',
    origin: 'manual',
  })
  await delay(150)
  // 事件循环未被锁等待阻塞：50ms 定时器在 save 仍在等锁期间就已触发
  expect(timerFired).toBe(true)
  // save 仍等待布线锁（未以超时/错误提前返回——注入档为默认 5s）
  const settledEarly = await Promise.race([saveP.then(() => true), delay(0).then(() => false)])
  expect(settledEarly).toBe(false)
  // 他进程「释放」→ 保存照常完成（异步轮询拿到锁），且完成后锁不残留
  rmSync(`${wiringAbs}.lock`, { force: true })
  const r = await saveP
  expect(r.ok).toBe(true)
  expect(existsSync(wiringAbs)).toBe(true)
  expect(existsSync(`${wiringAbs}.lock`)).toBe(false)
}, 10_000)

test('R30-6: executeSave 清单锁等待不阻塞事件循环（withManifestLockAsync）；释放后完成', async () => {
  // 登记清单（entry.path 与保存目标一致，避免出队守卫 REVISION_CONFLICT；
  // maybeUpdateManifest 只要清单在盘就会取锁，RMW no-op 不影响本验证）
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  mkdirSync(dirname(manifestPath), { recursive: true })
  const m: Manifest = { version: 1, entries: new Map() }
  upsertEntry(m, { id: 'doc_m1', nodeType: 'document', path: '设定/新位置.md', parentId: null })
  writeManifest(manifestPath, m)
  holdProbeLock(manifestPath) // `<manifest>.lock` —— withManifestLockAsync 的争用点
  let timerFired = false
  setTimeout(() => {
    timerFired = true
  }, 50)
  const saveP = svc.save('doc_m1', '设定/新位置.md', {
    content: '---\n名称: A\n---\n内容',
    expectedRevision: null,
    operationId: 'op1',
    origin: 'manual',
  })
  await delay(150)
  expect(timerFired).toBe(true)
  const settledEarly = await Promise.race([saveP.then(() => true), delay(0).then(() => false)])
  expect(settledEarly).toBe(false)
  rmSync(`${manifestPath}.lock`, { force: true })
  const r = await saveP
  expect(r.ok).toBe(true)
  expect(existsSync(join(bookRoot, '设定/新位置.md'))).toBe(true)
  expect(readManifest(manifestPath).entries.get('doc_m1')?.path).toBe('设定/新位置.md')
}, 10_000)

test('R30-6: 异步等待的 fail-closed 语义逐位不变——布线锁注入 120ms 档超时仍按 WRITE_ERROR 拒绝', async () => {
  __setWiringSaveLockTimeoutForTest(120)
  const wiringAbs = join(bookRoot, ...WIRING_REL.split('/'))
  holdProbeLock(wiringAbs)
  const r = await svc.save('doc_w1', WIRING_REL, {
    content: '---\n标题: 灭门\n---\n\n新正文',
    expectedRevision: null,
    operationId: 'op1',
    origin: 'manual',
  })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('回写此布线文件')
  }
  // fail-closed：文件未落盘；他人锁未被误删
  expect(existsSync(wiringAbs)).toBe(false)
  expect(existsSync(`${wiringAbs}.lock`)).toBe(true)
}, 10_000)

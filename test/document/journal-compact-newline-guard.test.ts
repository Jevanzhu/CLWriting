/**
 * N4（五十九轮）回归：compact 基线 stat 移入锁内 + rename 前重 stat 对比。
 *
 * 真双进程行为级验证（同 test/ai/calls-cross-process 模式）：进程 A 在超阈值
 * journal 上高频 append+settle（每轮 settle 触发 compact 的读→算→整文件替换），
 * 进程 B 并发裸追加 pending 行（模拟锁超时降级裸写的 append 路径）。终态 B 的
 * 全部 pending opId 必须仍可 findUnsettled 找回（compact 不得吞他进程新行）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import { appendPending, appendSettled, findUnsettled, JOURNAL_COMPACT_BYTES } from '../../src/document/journal.js'

const dir = mkdtempSync(join(tmpdir(), 'n4-compact-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const journalPath = fileURLToPath(new URL('../../src/document/journal.ts', import.meta.url))

/** 造超阈值 journal（settled 行灌字节） */
function seedOversized(jp: string): void {
  let text = ''
  for (let i = 0; i < 200; i++) {
    text += `${JSON.stringify({ opId: `seed${i}`, ts: 't', status: 'settled', newRevision: 'sha256:x' })}\n`
  }
  while (text.length < JOURNAL_COMPACT_BYTES + 64 * 1024) text += text
  writeFileSync(jp, text)
}

/** 起子进程跑脚本，resolve stdout（按行） */
function spawnWorker(script: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let stderr = ''
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker 退出码 ${code}：${stderr.slice(0, 800)}`))
      else resolve(out.split('\n').filter((l) => l.trim()))
    })
  })
}

describe('N4 compact 与并发 append 互斥', () => {
  it('A 高频 append+settle（触发压缩）× B 并发 pending → B 的 pending 行零丢失', async () => {
    const jp = join(dir, 'race.jsonl')
    seedOversized(jp)
    const mod = JSON.stringify(pathToFileURL(journalPath).href)
    const scriptA = `
import { appendPending, appendSettled } from ${mod}
const jp = ${JSON.stringify(jp)}
for (let i = 0; i < 60; i++) {
  const op = appendPending(jp, 'docA', null, 'A'.repeat(1024))
  appendSettled(jp, op, 'sha256:a' + i)
}
`
    const scriptB = `
import { appendPending } from ${mod}
const jp = ${JSON.stringify(jp)}
for (let i = 0; i < 40; i++) {
  const op = appendPending(jp, 'docB', null, 'B'.repeat(2048))
  console.log(op)
}
`
    const [, bOps] = await Promise.all([spawnWorker(scriptA), spawnWorker(scriptB)])
    expect(bOps.length).toBe(40)
    // B 的全部 pending opId 必须可找回（compact 吞行 = 丢崩溃恢复依据）
    const unsettled = findUnsettled(jp)
    const ids = new Set(unsettled.map((p) => p.opId))
    for (const op of bOps) expect(ids.has(op)).toBe(true)
  }, 120_000)

  it('N4（静路径）：超阈值 journal 静置后单次 settle 仍正常压缩（守卫不误弃无竞争压缩）', async () => {
    const jp = join(dir, 'quiet.jsonl')
    seedOversized(jp)
    // 留一个未结算 pending（压缩必须保留）；用另一个 op 的 settled 触发压缩
    const opA = appendPending(jp, 'docC', null, '会被结算的内容')
    const keep = appendPending(jp, 'docC', null, '待恢复内容')
    appendSettled(jp, opA, 'sha256:c')
    const unsettled = findUnsettled(jp)
    expect(unsettled.map((p) => p.opId)).toEqual([keep])
  })
})

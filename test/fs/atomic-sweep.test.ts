/**
 * Y-22 / Y-24（第五十七轮）回归——证据短引号兜底 + 崩溃 tmp 清扫。
 *
 * Y-22：extractEvidenceCore 短引号证据（「雪落」3 字，不满 {4,}）走 slice 兜底时
 * 先剥首尾引号——带引号字符 grep 正文整组 miss 会误报 lead-evidence-miss。
 * Y-24：sweepAbandonedTmpFiles 按 tmp 命名模式 + 5 分钟年龄门槛清扫崩溃残留；
 * 在途（年轻）tmp 不动。
 * R63-8（十一轮）：evidenceNeedles 多候选针串——混合短引证据（「雪落」无声）的
 * 内部闭引号留在单针串，正文以无引号形式写同短语时整组 miss；多候选任一命中即算。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { extractEvidenceCore, evidenceNeedles } from '../../src/check/leads.js'
import { leadEvidenceMatchesBody } from '../../src/check/lead-updates.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** R65-37：确定性死 pid——起一个立即退出的子进程取其 pid（原先硬编码 12345 在
 *  pid 恰被占用的机器上会被存活探测判「在途」导致用例随机红）。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const pid = r.pid ?? 0
  return pid > 0 ? pid : 999_999 // spawn 失败兜底：极高位 pid 几乎必死
}

/** R46-48：确定性**他进程活 pid**——起一个存活的子进程取其 pid。R65-37 的「pid 存活
 *  永不清」保护面是**他进程**在途写；此前用 process.pid 冒充「存活 pid」，R46-48 起
 *  自身 pid + 超 5 分钟改判废弃（worker terminate 逃逸 tmp），本测试须用真他进程。 */
function liveOtherPid(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  child.unref()
  return { pid: child.pid ?? deadPid(), stop: () => { try { child.kill() } catch { /* 已退出 */ } } }
}

let root: string
beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-y24-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Y-22: extractEvidenceCore 短引号', () => {
  it('「雪落」→ 雪落（剥引号后截取）', () => {
    expect(extractEvidenceCore('「雪落」')).toBe('雪落')
  })

  it('长引号证据仍走引号内优先（既有行为）', () => {
    expect(extractEvidenceCore('「大雪落满了山冈」')).toBe('大雪落满了山冈')
  })

  it('无引号证据照旧 slice（既有行为）', () => {
    expect(extractEvidenceCore('山门外玉佩轻响，少年抬头')).toBe('山门外玉佩轻响，')
  })
})

describe('R63-8: evidenceNeedles 多候选针串（任一命中即算）', () => {
  it('混合短引证据（「雪落」无声）→ 候选含引号内短串与全剥引号串，不含带闭引号的断链针串', () => {
    const needles = evidenceNeedles('「雪落」无声')
    expect(needles).toContain('雪落') // 引号内短串（Y-22 语义补全，不限 {4,}）
    expect(needles).toContain('雪落无声') // 全剥引号串（正文无引号写法的正身）
    expect(needles).toContain('雪落」无声') // 剥边引号原串（正文连引号写法）
    // 任一命中即算：正文写无引号短语不再整组 miss（修复前单针串 雪落」无人声 恒 miss）
    expect(leadEvidenceMatchesBody('夜里雪落无声，四野俱寂。', '「雪落」无声')).toBe(true)
    // 连引号一起写的正文也命中
    expect(leadEvidenceMatchesBody('他低声道：「雪落」无声胜有声。', '「雪落」无声')).toBe(true)
  })

  it('长引号证据：引号内长串为主候选，命中语义与修复前一致', () => {
    const needles = evidenceNeedles('「他终于看见焦痕背后的掌印。」')
    expect(needles).toContain('他终于看见焦痕背后的掌印。')
    expect(leadEvidenceMatchesBody('尘埃落定，他终于看见焦痕背后的掌印。', '「他终于看见焦痕背后的掌印。」')).toBe(true)
    expect(leadEvidenceMatchesBody('正文完全没有这句。', '「他终于看见焦痕背后的掌印。」')).toBe(false)
  })

  it('空证据/纯引号 → 零候选不误判兑现（includes("") 防线保留）', () => {
    expect(evidenceNeedles('')).toEqual([])
    expect(evidenceNeedles('「」')).toEqual([])
    expect(leadEvidenceMatchesBody('任意正文。', '')).toBe(false)
  })

  it('真正不在正文的证据仍 miss（多候选不是免检通道）', () => {
    expect(leadEvidenceMatchesBody('正文写的是另一件事。', '「雪落」无声')).toBe(false)
  })
})

describe('Y-24: sweepAbandonedTmpFiles', () => {
  it('超龄 tmp 被清、年轻 tmp 与非 tmp 文件不动', () => {
    mkdirSync(join(root, '写作'), { recursive: true })
    const old = join(root, `.ai-calls.json.${deadPid()}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
    // 年轻 tmp 放子目录：同时覆盖递归扫 + 年龄门（pid 已死，纯靠年轻保护）
    const young = join(root, '写作', `.manifest.jsonl.${deadPid()}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
    const normal = join(root, '正文.md')
    writeFileSync(old, 'x')
    writeFileSync(young, 'x')
    writeFileSync(normal, 'x')
    const now = Date.now()
    utimesSync(old, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000))
    const removed = sweepAbandonedTmpFiles(root, { now })
    expect(removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(normal)).toBe(true)
  })

  // R65-37（第六十五轮）：tmp 命名自带 pid 段——**他进程** pid 存活 = 在途写
  //（CLI/GUI 双进程长时间大文件写会超 5 分钟年龄门），永不清；死 pid 才交年龄门清走。
  // R46-48（四十六轮）：自身 pid 例外——worker_threads 与主进程共享 pid，导出 worker
  //  terminate 逃逸的 tmp 对 pid 守卫恒「存活」，会话期内永不清；改判「自身 pid 且
  //  超 5 分钟也废弃」（导出超时上限 120s < 5min，合法写者不可能超龄）。
  it('R65-37: 他进程 pid 存活的超龄 tmp 不清；死 pid 超龄照清', () => {
    const live = liveOtherPid()
    try {
      const alive = join(root, `.大产物.md.${live.pid}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
      const dead = join(root, `.大产物2.md.${deadPid()}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
      writeFileSync(alive, '在途')
      writeFileSync(dead, '残留')
      const now = Date.now()
      utimesSync(alive, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000)) // 远超年龄门
      utimesSync(dead, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000))
      const removed = sweepAbandonedTmpFiles(root, { now })
      expect(removed).toBe(1)
      expect(existsSync(alive)).toBe(true) // 他进程 pid 存活 → 不清（R65-37 语义保持）
      expect(existsSync(dead)).toBe(false) // 死 pid 超龄 → 清
    } finally {
      live.stop()
    }
  })

  it('R46-48: 自身 pid 的超龄 tmp 视为废弃（worker 逃逸）；年轻的自身 pid tmp 仍受年龄门保护', () => {
    const escaped = join(root, `.导出.md.${process.pid}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
    const inFlight = join(root, `.导出2.md.${process.pid}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`)
    writeFileSync(escaped, 'worker terminate 逃逸')
    writeFileSync(inFlight, '在途')
    const now = Date.now()
    utimesSync(escaped, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000)) // 远超 5min 自身门
    utimesSync(inFlight, new Date(now - 60_000), new Date(now - 60_000)) // 1min：低于年龄门
    const removed = sweepAbandonedTmpFiles(root, { now })
    expect(removed).toBe(1)
    expect(existsSync(escaped)).toBe(false) // 自身 pid + 超 5min → 废弃清走
    expect(existsSync(inFlight)).toBe(true) // 年轻（<5min）→ 在途保护不动
  })
})

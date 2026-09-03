/**
 * R43-7（四十三轮）回归：布线回写 writeLead 落位前的旧路径 existsSync 复核。
 *
 * 缺陷面：跨进程结构性移动（doMoveOrRename 的 link+rm）恰在「持锁读到 C0 → writeLead」
 * 毫秒窗内搬走线索源文件时，writeLead → atomicWriteFile 的 mkdir recursive 会在旧路径
 * 复活幽灵线索文件（同编号双文件：新路径真身 + 旧路径复活壳）。修后：复核不存在 →
 * 放弃该条按既有 not-found 分支处理（留源不写，下次定稿重解析自动重试）。
 *
 * 夹具：node:fs 注入（r42-doc-domain.test.ts 同款手法）——existsSync 对指定线索文件
 * 路径条件性返 false（模拟「读到 C0 成功、复核点盘面已无源文件」的竞态时序），
 * readFileSync 等其余全部透传真 fs（读到 C0 成功的前提）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const ghost = vi.hoisted(() => ({ absentPath: null as string | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => {
      if (typeof p === 'string' && p === ghost.absentPath) return false
      return actual.existsSync(p)
    },
  }
})

import { resolveLeadUpdateTargets, applyLeadUpdatesLocked } from '../../src/document/lead-finalize.js'

const LEAD_REL = '布线/悬念/悬念-001-灭门真凶.md'

/** 造一本带布线的短书 + 一条悬念线 + 账本推进.md（真 fs，不开 mock 旗） */
function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r43-lead-ghost-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, LEAD_REL),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n', 'utf-8')
  return root
}

describe('R43-7: writeLead 落位前旧路径复核（幽灵复活守卫）', () => {
  it('读到 C0 后源文件被搬走（复核 existsSync=false）→ 放弃本条：不复活幽灵、留源不写', () => {
    const root = makeBook()
    const leadPath = join(root, LEAD_REL)
    const targets = resolveLeadUpdateTargets(root, 3) // 锁外预取（真 fs，解析到目标文件）
    expect(targets.updates.length).toBe(1)
    expect(targets.files.get('悬念-001')).toBe(leadPath)
    // 竞态时序注入：readFileSync 读到 C0 成功、writeLead 落位前复核点盘面已无源文件
    //（模拟 doMoveOrRename 的 link+rm 恰在毫秒窗内搬走源文件）
    ghost.absentPath = leadPath
    try {
      const n = applyLeadUpdatesLocked(3, targets)
      expect(n).toBe(0) // 放弃本条（not-found 通道），不 writeLead
    } finally {
      ghost.absentPath = null
    }
    // 线索文件内容原样：修复前 writeLead → atomicWriteFile（mkdir recursive + rename）
    // 会在旧路径复活含新履历行的幽灵文件（内容会出现「第003章」——履历行章号按
    // M-4 补零口径 3 位）
    const after = readFileSync(leadPath, 'utf-8')
    expect(after).not.toContain('第003章')
    expect(after).not.toContain('递进')
    // 本章源未动（applied=0 不清空——条目留源，下次定稿自动重试）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('- 悬念-001 递进：焦痕在烛火下泛着暗红。\n')
  })

  it('对照：复核通过（文件仍在）→ 正常回写履历（mock 旗关闭，守卫不误伤 happy path）', () => {
    const root = makeBook()
    const leadPath = join(root, LEAD_REL)
    const targets = resolveLeadUpdateTargets(root, 3)
    expect(applyLeadUpdatesLocked(3, targets)).toBe(1)
    const after = readFileSync(leadPath, 'utf-8')
    expect(after).toContain('第003章')
    expect(after).toContain('递进：焦痕在烛火下泛着暗红。')
  })
})

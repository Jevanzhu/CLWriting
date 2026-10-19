/**
 * F1-P1 事件库存取层单测：建库/写入/读取/清空/启动修复。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  openSessionStore,
  bookHash,
  checkEventStreamIntegrity,
  readAutoVacuumMode,
  AUTO_VACUUM_NONE,
  AUTO_VACUUM_INCREMENTAL,
  runSessionDbMaintenanceAsync,
  __setEventRetentionMsForTest,
  __setPruneMinIntervalMsForTest,
} from '../../src/events/store.js'
import { sessionMigrateLockPathForDb } from '../../src/events/store-migrate.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { log } from '../../src/log/index.js'
import { tempDirTracked } from '../helpers/temp-dir.js'
import { rmDirRetry } from '../helpers/rm-dir-retry.js'
import { waitFor } from '../helpers/wait-for.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = tempDirTracked('f1-store-')
  dirs.push(d)
  return d
}

/** 收尾预算 ≈ (attempts-1)×delayMs = 10s：库连接与后台维护任务收尾期的句柄释放迟滞
 *  窗口（win 腿 EPERM 间歇红的现场族）。超限即上抛——真句柄泄漏照旧红，不吞故障。 */
const CLEANUP_RETRY = { attempts: 400, delayMs: 25 } as const

afterEach(() => {
  for (const d of dirs.splice(0)) rmDirRetry(d, CLEANUP_RETRY)
})

describe('F1-P1 bookHash', () => {
  it('稳定且不同路径不同', () => {
    const a = bookHash('/books/a')
    expect(bookHash('/books/a')).toBe(a)
    expect(bookHash('/books/b')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('F1-P1 store 存取', () => {
  it('userDataPath 为空 → null（退化内存模式）', () => {
    expect(openSessionStore(null, '/books/a')).toBeNull()
    expect(openSessionStore(undefined, '/books/a')).toBeNull()
  })

  it('appendEvents 落库且 seq 连续；listEvents 按 seq 升序返回', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A', { book: '书A' })
    store.appendEvents(sid, [
      { type: 'session/start', data: { book: '书A' } },
      { type: 'user/message', data: { message: 'hi' }, surfaceOp: 'append' },
    ])
    expect(store.lastSeq()).toBe(2)
    const evs = store.listEvents('书A')
    expect(evs.map((e) => e.seq)).toEqual([1, 2])
    expect(evs[0]!.type).toBe('session/start')
    expect(evs[1]!.type).toBe('user/message')
    expect(evs[1]!.data['message']).toBe('hi')
    store.close()
  })

  it('listEvents 可按 sessionId 过滤', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const s1 = store.createSession('书A')
    const s2 = store.createSession('书A')
    store.appendEvents(s1, [{ type: 'user/message', data: { message: 'm1' }, surfaceOp: 'append' }])
    store.appendEvents(s2, [{ type: 'user/message', data: { message: 'm2' }, surfaceOp: 'append' }])
    expect(store.listEvents('书A', s1).map((e) => e.data['message'])).toEqual(['m1'])
    expect(store.listEvents('书A').map((e) => e.data['message'])).toEqual(['m1', 'm2'])
    store.close()
  })

  it('O-2（第十三轮）listEvents limit 限量通道：seq 升序取前 N；非法 limit 归全量', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'session/start', data: {} },
      ...[1, 2, 3, 4].map((i) => ({
        type: 'user/message' as const,
        data: { message: `m${i}` },
        surfaceOp: 'append' as const,
      })),
    ])
    // 书维度限量：取 seq 升序前 3
    expect(store.listEvents('书A', undefined, 3).map((e) => e.seq)).toEqual([1, 2, 3])
    // 会话维度限量
    expect(store.listEvents('书A', sid, 2).map((e) => e.seq)).toEqual([1, 2])
    // 非法 limit（0/负/NaN/Infinity）归全量——与 normalizeMaxMessages 同口径，绝不猜
    for (const bad of [0, -3, NaN, Infinity]) {
      expect(store.listEvents('书A', undefined, bad)).toHaveLength(5)
    }
    // 小数向下取整
    expect(store.listEvents('书A', undefined, 2.5)).toHaveLength(2)
    store.close()
  })

  it('B1（2026-08-24）listEvents type 下推：书/会话两维只返回指定类型行，与 limit 可组合', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'session/start', data: {} },
      { type: 'user/message', data: { message: 'm1' }, surfaceOp: 'append' },
      { type: 'llm/call', data: { task: 't' } },
      { type: 'user/message', data: { message: 'm2' }, surfaceOp: 'append' },
    ])
    // 书维度 type 下推（trace/cost 聚合路径）
    expect(store.listEvents('书A', undefined, undefined, 'llm/call').map((e) => e.type)).toEqual(['llm/call'])
    expect(store.listEvents('书A', undefined, undefined, 'user/message').map((e) => e.seq)).toEqual([2, 4])
    // 会话维度同推 + type/limit 组合
    expect(store.listEvents('书A', sid, undefined, 'user/message')).toHaveLength(2)
    expect(store.listEvents('书A', undefined, 1, 'user/message').map((e) => e.seq)).toEqual([2])
    store.close()
  })

  it('B3（2026-08-24）打开期抛错（库损坏）→ 上抛不滞留；修复后同路径重开可用', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    store.close()
    const dbPath = join(ud, 'clwriting', 'session', bookHash('/books/a') + '.db')
    writeFileSync(dbPath, Buffer.from('not a sqlite database at all'.repeat(10)))
    expect(() => openSessionStore(ud, '/books/a')).toThrow()
    // 坏库清走后同路径可开可写——openStores 无残留登记/句柄阻塞
    rmSync(dbPath, { force: true })
    const store2 = openSessionStore(ud, '/books/a')!
    store2.appendEvents(store2.createSession('书A'), [{ type: 'session/start', data: {} }])
    store2.close()
  })

  it('clearBook 清空本书事件与 session', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' }])
    expect(store.lastSeq()).toBe(1)
    store.clearBook('书A')
    expect(store.listEvents('书A')).toHaveLength(0)
    expect(store.lastSeq()).toBe(0)
    store.close()
  })

  it('RB-IF-P2-1: clearBook 原子——第二条 DELETE 失败时第一条整体回滚（不留孤儿 events）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '审计数据' }, surfaceOp: 'append' }])
    // 用触发器让第二条 DELETE（sessions）必然失败——验证第一条（events）随之回滚
    const other = new DatabaseSync(store.dbPath)
    other.exec(
      `CREATE TRIGGER block_sessions_delete BEFORE DELETE ON sessions BEGIN
         SELECT RAISE(ABORT, 'blocked');
       END`,
    )
    try {
      expect(() => store.clearBook('书A')).toThrow()
      // 修复前：第一条 DELETE 已生效 → 孤儿 events（无 sessions 行）永久查不到
      expect(store.listEvents('书A')).toHaveLength(1)
    } finally {
      other.exec('DROP TRIGGER block_sessions_delete')
      other.close()
      store.close()
    }
  })

  it('P5-服务端（第七轮）：clearBooks 原子——第二键 DELETE 失败时第一键整体回滚', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    // 双钥匙两 book 键，各挂一条事件
    const s1 = store.createSession('书A')
    store.appendEvents(s1, [{ type: 'user/message', data: { message: '对话侧' }, surfaceOp: 'append' }])
    const s2 = store.createSession('书A#hash')
    store.appendEvents(s2, [{ type: 'user/message', data: { message: '工作流侧' }, surfaceOp: 'append' }])
    // 触发器让 sessions 的 DELETE 必然失败——第一键已删、第二键炸 → 全回滚
    const other = new DatabaseSync(store.dbPath)
    other.exec(
      `CREATE TRIGGER block_sessions_delete2 BEFORE DELETE ON sessions BEGIN
         SELECT RAISE(ABORT, 'blocked');
       END`,
    )
    try {
      expect(() => store.clearBooks(['书A', '书A#hash'])).toThrow()
      expect(store.listEvents('书A')).toHaveLength(1)
      expect(store.listEvents('书A#hash')).toHaveLength(1)
    } finally {
      other.exec('DROP TRIGGER block_sessions_delete2')
      other.close()
      store.close()
    }
  })

  it('失败事务回滚——appendEvents 抛错后无部分写入', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    // 触发错误：未知 type 不报错（SQLite 不校验），改用 data 为不可序列化对象
    const bad: Record<string, unknown> = {}
    const cyc: Record<string, unknown> = {}
    cyc['self'] = cyc
    expect(() => store.appendEvents(sid, [{ type: 'user/message', data: cyc, surfaceOp: 'append' }])).toThrow()
    expect(store.listEvents('书A')).toHaveLength(0)
    void bad
    store.close()
  })
})

/** 把库内全部事件 created_at 回拨到 now - ms（模拟「最后活动已超过宽限期」的陈旧孤儿） */
function backdateEvents(ud: string, bookRoot: string, ms: number): void {
  const db = new DatabaseSync(join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db'))
  db.prepare('UPDATE events SET created_at = ?').run(Date.now() - ms)
  db.close()
}

function backdateSessions(ud: string, bookRoot: string, ms: number): void {
  const db = new DatabaseSync(join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db'))
  db.prepare('UPDATE sessions SET updated_at = ?').run(Date.now() - ms)
  db.close()
}

describe('F1-P1 启动修复', () => {
  it('陈旧孤儿 session（最后活动已过宽限期）重开库时补 session/end{interrupted}', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: { book: '书A' } }])
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'crash' }, surfaceOp: 'append' }])
    store.close()
    backdateEvents(ud, '/books/a', 33 * 60 * 1000) // 超过 32 分钟宽限期（R65-19 对齐 AGENT_DEADLINE_MS）
    // 重开库（模拟崩溃后重启）
    const store2 = openSessionStore(ud, '/books/a')!
    const evs = store2.listEvents('书A')
    const ends = evs.filter((e) => e.type === 'session/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data['reason']).toBe('interrupted')
    store2.close()
  })

  it('O-7（第十三轮）孤儿修复补 end 时同步 touch sessions.updated_at（不被 latestSession 当新会话选中恢复）', () => {
    const ud = tmpRoot()
    const t0 = Date.now()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: {} }])
    store.close()
    // 事件与 sessions 双双回拨：修复前 updated_at 停留在创建时刻（t0-11min）
    backdateEvents(ud, '/books/a', 33 * 60 * 1000)
    backdateSessions(ud, '/books/a', 33 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!
    const ends = store2.listEvents('书A').filter((e) => e.type === 'session/end')
    expect(ends).toHaveLength(1) // 修复生效
    // R64-9（十二轮）：补 end 与 touch 解耦——end 事件落修复时刻（≥ t0），
    // sessions.updated_at 则保持真实最后活动（回拨的 t0-11min）：修复时刻不冒充
    // 活动时刻，latestSession 排序始终按真实活动（touch=now 会让死会话压过
    // 期间更活跃的会话）
    expect(ends[0]!.createdAt).toBeGreaterThanOrEqual(t0)
    const row = store2.latestSession('书A')!
    expect(row.updated_at).toBeLessThan(t0)
    store2.close()
  })

  it('N-5（第五十四轮）: 补 end 的第二步（touch）失败时整体回滚——不留「补了 end 但 updated_at 未刷」半态', () => {
    // 用 BEFORE UPDATE 触发器 RAISE(ABORT) 模拟第二步抛错：修复事务内
    // INSERT（补 end）成功后 UPDATE 触发 ABORT → ROLLBACK，INSERT 一并回滚
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: {} }])
    store.close()
    backdateEvents(ud, '/books/a', 33 * 60 * 1000)
    backdateSessions(ud, '/books/a', 33 * 60 * 1000)
    const dbPath = join(ud, 'clwriting', 'session', bookHash('/books/a') + '.db')
    const before = new DatabaseSync(dbPath)
    before.exec(
      "CREATE TRIGGER mock_touch_fail BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'mock touch fail'); END",
    )
    const updatedAtBefore = (
      before.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(sid) as { updated_at: number }
    ).updated_at
    before.close()
    // 重开库触发修复：touch 抛错 → 事务回滚 → 开库抛出（不静默半态）
    expect(() => openSessionStore(ud, '/books/a')).toThrow('mock touch fail')
    // 半态校验：end 未补（INSERT 已回滚），updated_at 未刷
    const probe = new DatabaseSync(dbPath)
    const ends = probe
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'session/end'")
      .get(sid) as { n: number }
    const updatedAtAfter = (
      probe.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(sid) as { updated_at: number }
    ).updated_at
    probe.exec('DROP TRIGGER mock_touch_fail')
    probe.close()
    expect(ends.n).toBe(0)
    expect(updatedAtAfter).toBe(updatedAtBefore)
    // 撤除模拟故障后重开：修复正常补齐（两步同事务原子上线）
    const store2 = openSessionStore(ud, '/books/a')!
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    store2.close()
  })

  it('RB-IF-P2-2: 新近活跃的孤儿（伪孤儿，跨进程进行中）不补虚假 end', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: { book: '书A' } }])
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '另一进程进行中' }, surfaceOp: 'append' }])
    store.close()
    // 不回拨：最后活动就在此刻（宽限期内）
    const store2 = openSessionStore(ud, '/books/a')!
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
    store2.close()
  })

  it('RB-IF-P2-2: 恰在宽限期边界内（31 分钟前）仍不补（R65-19 窗口随宽限对齐）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: {} }])
    store.close()
    backdateEvents(ud, '/books/a', 31 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
    store2.close()
  })

  it('正常收尾的 session 不补 closers', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'session/start', data: {} }])
    store.appendEvents(sid, [{ type: 'session/end', data: { reason: 'completed' } }])
    store.close()
    backdateEvents(ud, '/books/a', 33 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    store2.close()
  })

  it('打开时仍在宽限期内的孤儿：长跑进程不重开库，写路径按 TTL 惰性补 end', () => {
    // 原缺陷：孤儿修复只在 openSessionStore 首次打开跑一次——崩溃残留若打开时
    // 距最后活动 <32min 被宽限期跳过，此后单例连接长开（refs>0）不再触发修复，
    // 孤儿 end 永远补不上（审计流缺收尾），除非进程重启。
    const ud = tmpRoot()
    const t0 = Date.now()
    vi.useFakeTimers({ now: t0 })
    try {
      const store = openSessionStore(ud, '/books/a')!
      const sid = store.createSession('书A')
      store.appendEvents(sid, [{ type: 'session/start', data: {} }])
      store.close()
      // 重开：孤儿最后活动 = t0（宽限期内）→ 打开修复跳过
      const store2 = openSessionStore(ud, '/books/a')!
      expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
      // 宽限期过后（库保持打开，长跑进程）：写路径（createSession）触发 TTL 惰性修复
      vi.setSystemTime(t0 + 33 * 60 * 1000)
      store2.createSession('书A')
      const ends = store2.listEvents('书A').filter((e) => e.type === 'session/end')
      expect(ends).toHaveLength(1)
      expect(ends[0]!.sessionId).toBe(sid)
      expect(ends[0]!.data['reason']).toBe('interrupted')
      store2.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('R53-B-3: appendEvents 热路径不再触发孤儿修复（TTL 过期也不扫，只随 createSession 走）', () => {
    // 修复前：TTL 到期后任意一笔事件写入都要先扛完整的分页扫描 + 逐孤儿事务（热路径
    // 写放大）——本现场旧代码会在 sidB 的 appendEvents 里顺手把超宽限的 sidA 补 end。
    // 修复后修复触发点收敛到 createSession：appendEvents 只写事件不扫描。
    const ud = tmpRoot()
    const t0 = Date.now()
    vi.useFakeTimers({ now: t0 })
    try {
      const store = openSessionStore(ud, '/books/a')!
      const sidA = store.createSession('书A')
      const sidB = store.createSession('书A')
      store.appendEvents(sidA, [{ type: 'session/start', data: {} }])
      store.appendEvents(sidB, [{ type: 'session/start', data: {} }])
      store.close()
      // 重开：两会话最后活动 = t0（宽限期内）→ 打开修复跳过；TTL 基线 = 重开时刻
      const store2 = openSessionStore(ud, '/books/a')!
      vi.setSystemTime(t0 + 33 * 60 * 1000)
      const endsOf = (sid: string) =>
        store2.listEvents('书A').filter((e) => e.type === 'session/end' && e.sessionId === sid)
      // 核心断言：向 sidB 追加事件（刷新 sidB 自身 last_at，不影响 sidA）——sidA 超
      // 宽限且不在活跃集，修复前此处会被顺手补 end；修复后 appendEvents 不触发修复
      store2.appendEvents(sidB, [{ type: 'user/message', data: {}, surfaceOp: 'append' }])
      expect(endsOf(sidA)).toHaveLength(0)
      // 自愈对照：createSession 仍触发惰性修复 → sidA 补上 interrupted end；
      // sidB 刚被 append 刷新（last_at = now）仍在宽限期内不被补
      store2.createSession('书A')
      expect(endsOf(sidA)).toHaveLength(1)
      expect(endsOf(sidA)[0]!.data['reason']).toBe('interrupted')
      expect(endsOf(sidB)).toHaveLength(0)
      store2.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R65-20（批 B）：listEvents 坏行降级', () => {
  it('单行 data 坏 JSON → 跳过该行 + warn 留 seq，其余行完整返回不抛', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'user/message', data: { message: '好行1' }, surfaceOp: 'append' },
      { type: 'user/message', data: { message: '好行2' }, surfaceOp: 'append' },
      { type: 'user/message', data: { message: '好行3' }, surfaceOp: 'append' },
    ])
    store.close()
    // 外部腐蚀：把 seq=2 的 data 改成坏 JSON（模拟跨版本写坏/盘损）
    const dbPath = join(ud, 'clwriting', 'session', bookHash('/books/a') + '.db')
    const db = new DatabaseSync(dbPath)
    db.prepare("UPDATE events SET data = '{oops' WHERE seq = 2").run()
    db.close()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store2 = openSessionStore(ud, '/books/a')!
      const evs = store2.listEvents('书A')
      expect(evs.map((e) => e.seq)).toEqual([1, 3]) // 坏行跳过，好行完整
      expect(evs.map((e) => (e.data as { message?: string })['message'])).toEqual(['好行1', '好行3'])
      // 会话维度同口径
      expect(store2.listEvents('书A', sid)).toHaveLength(2)
      store2.close()
      // warn 带行 seq（诊断入口）
      const msg = String(warn.mock.calls.find((c) => String(c[0]).includes('seq=2'))?.[0] ?? '')
      expect(msg).toContain('listEvents 跳过坏行 seq=2')
    } finally {
      warn.mockRestore()
    }
  })
})

// P1-16：maskSelfCheckData 降为开关档（默认关）——自检查询为 events 全表扫
// （O(N)，无可用索引），只在 close 写 compaction 前跑一次；诊断/复现时设
// CLWRITING_EVENTS_SELF_CHECK=1 启用。未启用返回 null（调用方跳过告警，防空结果误报）。
describe('P1-16 maskSelfCheckData 自检开关', () => {
  it('默认关 → null（自检未跑）；env 开启 → 返回区间/表面类行（查询面不变）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'hi' }, surfaceOp: 'append' }])
    delete process.env.CLWRITING_EVENTS_SELF_CHECK
    expect(store.maskSelfCheckData(1, 1)).toBeNull()
    process.env.CLWRITING_EVENTS_SELF_CHECK = '1'
    try {
      const chk = store.maskSelfCheckData(1, 1)
      expect(chk).not.toBeNull()
      expect(chk!.intervals).toEqual([])
      expect(chk!.rows.map((r) => r.seq)).toEqual([1])
    } finally {
      delete process.env.CLWRITING_EVENTS_SELF_CHECK
    }
    store.close()
  })
})

// ── 保留策略与空间回收 ──────────────────────────────────────────────────────
// 判据：白名单三族（llm/retry、retry/attempt、check/report）零读取方故可裁；surface/
// 边界/血缘/成本各族的读取方见 src/events/store-retention.ts 头注的逐个核对。

/** 造事件：created_at 统一回拨到 ageMs 前（保留窗口内的行传 0）。 */
function seedBackdated(
  store: ReturnType<typeof openSessionStore>,
  book: string,
  rows: Array<{ type: string; data: Record<string, unknown>; ageMs: number }>,
): string {
  const sid = store!.createSession(book)
  const db = new DatabaseSync(store!.dbPath)
  try {
    for (const r of rows) {
      store!.appendEvents(sid, [{ type: r.type as never, data: r.data, surfaceOp: 'append' as never }])
    }
    // created_at 由 appendEvents 统一写 now——按需逐条回拨（seq 升序对应 rows 顺序）
    const seqs = store!.listEvents(book, sid).map((e) => e.seq)
    seqs.forEach((seq, i) => {
      db.prepare('UPDATE events SET created_at = ? WHERE seq = ?').run(Date.now() - rows[i]!.ageMs, seq)
    })
  } finally {
    db.close()
  }
  return sid
}

/** 按类型计数（读侧可观察面）。 */
function countByType(store: ReturnType<typeof openSessionStore>, book: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of store!.listEvents(book)) out[e.type] = (out[e.type] ?? 0) + 1
  return out
}

/** 逐行签名（seq + 类型 + 载荷原文）：prune 前后整表对拍用——只计数分不出「删错行、留错行」。 */
function rowSignatures(store: ReturnType<typeof openSessionStore>, book: string): string[] {
  return store!.listEvents(book).map((e) => `${e.seq}:${e.type}:${JSON.stringify(e.data)}`)
}

const DAY = 24 * 60 * 60 * 1000

describe('事件库保留策略（观测类裁剪）', () => {
  it('超窗的观测类族被裁剪、禁删族逐条仍在；重复执行零副作用', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/retain')!
    const old = 40 * DAY // 越过 30 天缺省窗口
    seedBackdated(store, '留痕书', [
      { type: 'session/start', data: { book: '留痕书' }, ageMs: old },
      { type: 'llm/retry', data: { attempt: 1, delayMs: 10 }, ageMs: old },
      { type: 'user/message', data: { message: '旧对话正文' }, ageMs: old },
      { type: 'retry/attempt', data: { attempt: 1, maxAttempts: 3 }, ageMs: old },
      { type: 'assistant/message', data: { message: '旧回复' }, ageMs: old },
      { type: 'check/report', data: { chapter: 1, reds: [] }, ageMs: old },
      { type: 'llm/call', data: { task: 'chat', ok: true }, ageMs: old },
      { type: 'tool/result', data: { callId: 'c1', content: '旧工具结果' }, ageMs: old },
      { type: 'session/end', data: { reason: 'completed' }, ageMs: old },
    ])
    // 保留窗口内的观测行：不得被裁（同族同库两条，窗口是唯一分界）
    seedBackdated(store, '留痕书', [
      { type: 'llm/retry', data: { attempt: 2, delayMs: 10 }, ageMs: 1 * DAY },
      { type: 'check/report', data: { chapter: 2, reds: [] }, ageMs: 0 },
    ])
    // 逐行对拍基线：prune 之后应为「基线减去超窗的三条白名单行」，其余行逐字不动
    // （只比计数分不出「删错行、留错行」；seq 因删行留空洞，故按行签名对拍而非重算序号）
    const before = rowSignatures(store, '留痕书')
    const prunableTypes = new Set(['llm/retry', 'retry/attempt', 'check/report'])
    const expectedKept = before.filter((sig) => {
      const type = sig.slice(sig.indexOf(':') + 1, sig.indexOf(':', sig.indexOf(':') + 1))
      if (!prunableTypes.has(type)) return true
      // 白名单族里窗口内的两条（载荷可辨）保留：only 超窗那一条会消失
      return sig.includes('"attempt":2') || sig.includes('"chapter":2')
    })
    expect(expectedKept).toHaveLength(before.length - 3)

    const first = await runSessionDbMaintenanceAsync(store.dbPath)
    expect(first?.pruned).not.toBeNull()
    expect(first!.pruned!.deleted).toBe(3) // llm/retry + retry/attempt + check/report 各一条
    // 逐行对拍：残留行与期望逐条一致（顺序、seq、载荷全等）——禁删族一条不少，窗口内观测族一条不丢
    expect(rowSignatures(store, '留痕书')).toEqual(expectedKept)
    const after = countByType(store, '留痕书')
    // 禁删族逐条仍在（正文/审计/成本/边界/工具各族）
    expect(after['session/start']).toBe(1)
    expect(after['session/end']).toBe(1)
    expect(after['user/message']).toBe(1)
    expect(after['assistant/message']).toBe(1)
    expect(after['tool/result']).toBe(1)
    expect(after['llm/call']).toBe(1)
    // 窗口内的观测族保留，超窗的三族只剩窗口内那一条/清零
    expect(after['llm/retry']).toBe(1)
    expect(after['check/report']).toBe(1)
    expect(after['retry/attempt']).toBeUndefined()
    // 正文原样可读（裁剪不碰载荷）
    expect(store.listEvents('留痕书').find((e) => e.type === 'user/message')!.data['message']).toBe('旧对话正文')

    // 幂等：重复跑零副作用（无到期白名单行 → deleted=0，行数不变；逐行签名同前）
    const again = await runSessionDbMaintenanceAsync(store.dbPath)
    expect(again?.pruned?.deleted ?? 0).toBe(0)
    expect(rowSignatures(store, '留痕书')).toEqual(expectedKept)
    store.close()
  })

  it('窗口内的行不裁：把保留窗口设到 365 天，则 40 天前的观测行原样保留', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/fresh')!
    seedBackdated(store, '新书', [
      { type: 'llm/retry', data: { attempt: 1, delayMs: 1 }, ageMs: 40 * DAY },
      { type: 'user/message', data: { message: 'hi' }, ageMs: 0 },
    ])
    __setEventRetentionMsForTest(365 * DAY)
    try {
      const out = await runSessionDbMaintenanceAsync(store.dbPath)
      // 未到期且空闲页未过阈 → 整轮维护不开工（返回 null = 连写事务都没开）
      expect(out).toBeNull()
      expect(countByType(store, '新书')['llm/retry']).toBe(1)
      expect(countByType(store, '新书')['user/message']).toBe(1)
    } finally {
      __setEventRetentionMsForTest(30 * DAY)
      store.close()
    }
  })

  it('清库后 seq 重新分配 → 游标不越界：新落库的超窗观测行照常被裁', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/cursor')!
    // 第一轮：把游标推到旧区段末尾（清库前跑过一次裁剪）
    seedBackdated(store, '游标书', [{ type: 'llm/retry', data: { attempt: 1, delayMs: 1 }, ageMs: 40 * DAY }])
    expect((await runSessionDbMaintenanceAsync(store.dbPath))!.pruned!.deleted).toBe(1)
    __setPruneMinIntervalMsForTest(0) // 间隔闸放到 0：本用例要在同一进程内连跑两轮
    try {
      // 清库：行删空后主键从 1 重新分配，而游标停在旧的高位（进程内存态不回退）
      store.clearBooks(['游标书'])
      store.createSession('游标书')
      seedBackdated(store, '游标书', [{ type: 'llm/retry', data: { attempt: 9, delayMs: 1 }, ageMs: 40 * DAY }])
      const out = await runSessionDbMaintenanceAsync(store.dbPath)
      expect(out!.pruned!.deleted).toBe(1) // 新行 seq 落在旧游标之前也必须被扫到
      expect(countByType(store, '游标书')['llm/retry']).toBeUndefined()
    } finally {
      __setPruneMinIntervalMsForTest(6 * 60 * 60 * 1000)
      store.close()
    }
  })
})

describe('事件库空间回收', () => {
  // 120s 帽：CI 满载下 300×6KB 灌库 + 整库 VACUUM 曾超全局 30s 兜底；空间回收无断言语义，
  // 放宽不弱化守卫。
  it('存量库（auto_vacuum=0）空闲页充裕 → 整库重写转增量档，mode=vacuum', async () => {
    const ud = tmpRoot()
    mkdirSync(join(ud, 'session'), { recursive: true })
    const dbPath = join(ud, 'session', `${bookHash('/books/legacy')}.db`)
    // 造存量库形态：不经首开流程建库（跳开 applyOpenPragmas 的 auto_vacuum=INCREMENTAL），
    // 直接按老形态建表灌数据再删空——删空的页进空闲表，高水位不回落
    const seed = new DatabaseSync(dbPath)
    try {
      seed.exec('PRAGMA auto_vacuum = 0')
      seed.exec(
        'CREATE TABLE events (seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, surface_op TEXT, shadow_start INTEGER, shadow_end INTEGER, source_seqs TEXT, replace_generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      )
      const ins = seed.prepare(
        `INSERT INTO events (session_id, type, data, replace_generation, created_at) VALUES (?, 'user/message', ?, 0, ?)`,
      )
      const payload = '正'.repeat(2000) // 每行约 6KB → 积累 400+ 页
      for (let i = 0; i < 300; i++) ins.run('s1', JSON.stringify({ message: payload }), Date.now())
      seed.exec('DELETE FROM events')
    } finally {
      seed.close()
    }
    const db = new DatabaseSync(dbPath)
    try {
      expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_NONE)
    } finally {
      db.close()
    }
    const out = await runSessionDbMaintenanceAsync(dbPath)
    expect(out!.reclaimed!.mode).toBe('vacuum')
    // 转换落库：档位已改增量（后续删除即自动回收，不必再整库重写）
    const after = new DatabaseSync(dbPath)
    try {
      expect(readAutoVacuumMode(after)).toBe(AUTO_VACUUM_INCREMENTAL)
      expect(after.prepare('PRAGMA freelist_count').get()).toMatchObject({ freelist_count: 0 })
    } finally {
      after.close()
    }
  }, 120_000)

  it('强制档：空闲页未到阈仍回收（清库路径要空间回落）；机会档同现场则不动', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/forced')!
    const sid = store.createSession('强制书')
    // 灌一批再删大半：留下少量空闲页（低于 RELEASE_MIN_FREE_PAGES=64 的机会档阈）
    for (let i = 0; i < 60; i++) {
      store.appendEvents(sid, [{ type: 'user/message', data: { message: '正'.repeat(300) }, surfaceOp: 'append' }])
    }
    const db = new DatabaseSync(store.dbPath)
    let freeAfterDelete = 0
    try {
      db.exec('DELETE FROM events WHERE seq > 5')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      freeAfterDelete = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    } finally {
      db.close()
    }
    // 现场前提成立才有区分度：有空闲页但未到机会档阈
    expect(freeAfterDelete).toBeGreaterThan(0)
    expect(freeAfterDelete).toBeLessThan(64)
    // 机会档：到期未至且空闲页未到阈 → 整轮不动工（返回 null，连回收都没进）
    const idle = await runSessionDbMaintenanceAsync(store.dbPath, 'idle')
    expect(idle).toBeNull()
    // 强制档：同一现场照收（清库刚删完行，等阈会让空间回落落空）
    const forced = await runSessionDbMaintenanceAsync(store.dbPath, 'force')
    expect(forced!.reclaimed!.mode).toBe('incremental')
    const after = new DatabaseSync(store.dbPath)
    try {
      expect((after.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBe(0)
    } finally {
      after.close()
    }
    store.close()
  })

  it('清空对话后回收被触发：库 + WAL 的落盘字节回落（不是只删行）', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/shrink')!
    const sid = store.createSession('胖书')
    const payload = '正'.repeat(400)
    /** 库与两个侧车的落盘字节合计——写入先进 WAL 侧车，只看主库文件量不到峰值。 */
    const onDisk = (): number => {
      let total = 0
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          total += statSync(store.dbPath + suffix).size
        } catch {
          /* 侧车不存在即不计 */
        }
      }
      return total
    }
    for (let i = 0; i < 200; i++) {
      store.appendEvents(sid, [{ type: 'assistant/message', data: { message: `${payload}${i}` }, surfaceOp: 'append' }])
    }
    const peak = onDisk()
    expect(peak).toBeGreaterThan(0)
    // 清空对话（clearBooks 双键形态，与 chat 清史/audit 清除同路径）→ 后台回收被调度
    store.clearBooks(['胖书'])
    await waitFor(() => onDisk() < peak / 2, 5000, 20, '事件库回收')
    // 字节回落不等于维护任务已收尾：它自开连接、块间让出，收尾期仍持库句柄（实测 20/20
    // 命中「字节已回落但目录仍被持有」）。等它落定再收尾——复用在途任务，不叠第二个连接。
    await runSessionDbMaintenanceAsync(store.dbPath)
    store.close()
  })
})

// ── 维护任务的「不动手」现场 ────────────────────────────────────────────────
// 判据：库不在位 / 幽灵库 / 迁移锁被占三种现场都静默跳过（返回 null），不抛错、不留痕、
// 更不留孤儿空壳——维护是让利路径，三类现场分别是删书（先清行再删文件）、他进程刚建文件
// 未跑 DDL、首开与迁移段进行中，都属常态而非故障。

describe('事件库维护：不动手的现场', () => {
  it('库路径不存在 → 静默跳过，且不新建空壳文件', async () => {
    const ud = tmpRoot()
    const missing = join(ud, 'session', 'gone.db')
    expect(await runSessionDbMaintenanceAsync(missing)).toBeNull()
    // DatabaseSync 打开不存在的路径会新建空文件——跳过必须发生在此之前，否则删书路径留孤儿
    expect(existsSync(missing)).toBe(false)
  })

  it('幽灵库（有文件无 events 表）→ 静默跳过，不建表', async () => {
    const ud = tmpRoot()
    mkdirSync(join(ud, 'session'), { recursive: true })
    const ghost = join(ud, 'session', 'ghost.db')
    const seed = new DatabaseSync(ghost)
    try {
      seed.exec('CREATE TABLE unrelated(x INTEGER)')
    } finally {
      seed.close()
    }
    expect(await runSessionDbMaintenanceAsync(ghost)).toBeNull()
    const after = new DatabaseSync(ghost)
    try {
      const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
      expect(tables.map((t) => t.name)).toEqual(['unrelated'])
    } finally {
      after.close()
    }
  })

  it('迁移锁在他手 → 本轮跳过（不排队等待，一行不动）', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/locked')!
    seedBackdated(store, '锁占书', [{ type: 'llm/retry', data: { attempt: 1 }, ageMs: 40 * DAY }])
    const release = await acquireCrossProcessLockAsync(sessionMigrateLockPathForDb(store.dbPath), 50)
    expect(release).not.toBeNull()
    try {
      expect(await runSessionDbMaintenanceAsync(store.dbPath)).toBeNull()
      expect(countByType(store, '锁占书')['llm/retry']).toBe(1)
    } finally {
      release!()
      store.close()
    }
  })

  it('游标越界自愈：库被删后重建致 seq 回落 → 游标夹回起点，新行照裁', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/clamp')!
    // 三条超窗观测行：首轮把游标推到 seq 3
    seedBackdated(store, '夹书', [
      { type: 'llm/retry', data: { attempt: 1 }, ageMs: 40 * DAY },
      { type: 'llm/retry', data: { attempt: 2 }, ageMs: 40 * DAY },
      { type: 'llm/retry', data: { attempt: 3 }, ageMs: 40 * DAY },
    ])
    __setPruneMinIntervalMsForTest(0)
    try {
      expect((await runSessionDbMaintenanceAsync(store.dbPath))!.pruned!.deleted).toBe(3)
      // 库文件被删后重建的形态：行清空（seq 从 1 重新分配）后再落一条超窗行——
      // 游标停在旧高位 3，新行的 seq 落在它之前，不夹回就永久漏裁
      const db = new DatabaseSync(store.dbPath)
      try {
        db.exec('DELETE FROM events')
        db.prepare(
          `INSERT INTO events (session_id, type, data, replace_generation, created_at)
           VALUES ('夹书', 'llm/retry', '{}', 0, ?)`,
        ).run(Date.now() - 40 * DAY)
      } finally {
        db.close()
      }
      const out = await runSessionDbMaintenanceAsync(store.dbPath)
      expect(out!.pruned!.deleted).toBe(1)
    } finally {
      __setPruneMinIntervalMsForTest(6 * 60 * 60 * 1000)
      store.close()
    }
  })
})

// ── 关闭路径的在线条数一致性自检 ────────────────────────────────────────────
// 判据：遮蔽区间内的条数与投影可见条数守恒（复用 projection.shadowCoverageStep 的
// 判词与差异数）、session/start 与 session/end 配对计数一致。默认开（廉价尾窗查询），
// env 强制档 '0' 关 / '1' 开；自检自身异常只降级留痕，不影响关闭流程。

/** 区间守恒造盘：user/message(seq 1) + 中间 seq 被删的空洞 + compaction/end 遮蔽 [1,3]
 *  ——区间内只剩 seq 1 可见，区间跨度 3，差 2。 */
function seedBrokenShadow(store: ReturnType<typeof openSessionStore>): { sid: string; dbPath: string } {
  const sid = store!.createSession('坏遮蔽书')
  store!.appendEvents(sid, [
    { type: 'session/start', data: { book: '坏遮蔽书' } },
    { type: 'user/message', data: { message: '可见一' }, surfaceOp: 'append' },
    { type: 'user/message', data: { message: '即将消失' }, surfaceOp: 'append' },
    { type: 'user/message', data: { message: '也会消失' }, surfaceOp: 'append' },
  ])
  store!.appendEvents(sid, [
    {
      type: 'compaction/end',
      data: { reason: 'completed' },
      surfaceOp: 'replace',
      shadowStart: 2,
      shadowEnd: 4,
      sourceSeqs: [2, 3, 4],
    },
  ])
  // 外力把区间内的两行抹掉（模拟写坏/外部改写）：区间 [2,4] 只剩 seq 2 可见 → 差 2
  const db = new DatabaseSync(store!.dbPath)
  try {
    db.prepare('DELETE FROM events WHERE seq IN (3, 4)').run()
  } finally {
    db.close()
  }
  return { sid, dbPath: store!.dbPath }
}

describe('关闭路径事件流自检', () => {
  it('区间端点缺失 / 区间倒置 → 各自成一条不一致判词（判词含 seq 与端点）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/malformed')!
    const sid = store.createSession('坏端点书')
    store.appendEvents(sid, [
      { type: 'session/start', data: { book: '坏端点书' } },
      { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' },
    ])
    // 直接落两条畸形载体：appendEvents 的类型面收窄不让 shadowStart 缺席，故走原表写
    // （自检读的就是盘上行，此处模拟外力改坏/旧版写坏形态）
    const db = new DatabaseSync(store.dbPath)
    try {
      db.prepare(
        `INSERT INTO events (session_id, type, data, surface_op, shadow_start, shadow_end, replace_generation, created_at)
         VALUES (?, 'compaction/end', '{"reason":"completed"}', 'replace', NULL, NULL, 0, ?)`,
      ).run(sid, Date.now())
      db.prepare(
        `INSERT INTO events (session_id, type, data, surface_op, shadow_start, shadow_end, replace_generation, created_at)
         VALUES (?, 'compaction/end', '{"reason":"completed"}', 'replace', 5, 3, 0, ?)`,
      ).run(sid, Date.now())
    } finally {
      db.close()
    }
    // 探针句柄显式关：win 下未关的 sqlite 文件删不掉——afterEach 的 rm-retry 预算耗尽即整档红
    const probe = new DatabaseSync(store.dbPath)
    const out = checkEventStreamIntegrity(probe)
    probe.close()
    const msgs = out.issues.map((i) => i.message)
    expect(msgs.some((m) => m.includes('缺 shadowStart/shadowEnd 端点'))).toBe(true)
    expect(msgs.some((m) => m.includes('区间倒置'))).toBe(true)
    expect(out.issues.every((i) => i.sessionId === sid)).toBe(true)
    store.close()
  })

  it('会话配对失衡（差 < 0 重复 end / 差 > 1 重复 start）→ 逐会话报一条', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/pairing')!
    const sidA = store.createSession('重尾书')
    // 差 < 0：一个 start 配两个 end（重复 end / 缺 start 同族）
    store.appendEvents(sidA, [
      { type: 'session/start', data: { book: '重尾书' } },
      { type: 'session/end', data: { reason: 'completed' } },
      { type: 'session/end', data: { reason: 'completed' } },
    ])
    const sidB = store.createSession('重头书')
    // 差 > 1：两个 start 无 end（重复 start）
    store.appendEvents(sidB, [
      { type: 'session/start', data: { book: '重头书' } },
      { type: 'session/start', data: { book: '重头书' } },
    ])
    const db = new DatabaseSync(store.dbPath)
    let out: ReturnType<typeof checkEventStreamIntegrity>
    try {
      out = checkEventStreamIntegrity(db)
    } finally {
      db.close()
    }
    const bySession = new Map(out.issues.map((i) => [i.sessionId, i.message]))
    expect(bySession.get(sidA)).toContain('配对失衡')
    expect(bySession.get(sidA)).toContain('差 -1')
    expect(bySession.get(sidB)).toContain('差 2')
    store.close()
  })

  it('会话首行被尾窗切走 → 不判配对（宁可漏报不误报）；窗口内首行是 start 才判', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/window')!
    const sid = store.createSession('窗切书')
    // 会话首行（start）之后垫一条 session/end，再垫到超过窗口：start 被切在窗外时
    // 窗内计数只剩 end — 若不看首行形态就会误报「差 -1」
    store.appendEvents(sid, [
      { type: 'session/start', data: { book: '窗切书' } },
      { type: 'session/end', data: { reason: 'completed' } },
    ])
    for (let i = 0; i < 6; i++) {
      store.appendEvents(sid, [{ type: 'user/message', data: { message: `填充${i}` }, surfaceOp: 'append' }])
    }
    const db = new DatabaseSync(store.dbPath)
    let out: ReturnType<typeof checkEventStreamIntegrity>
    try {
      // 尾窗只取 3 行：start/end 都被切走，窗内首行是 user/message → 该会话不判配对
      out = checkEventStreamIntegrity(db, 3)
    } finally {
      db.close()
    }
    expect(out.tailRows).toBe(3)
    expect(out.issues.filter((i) => i.sessionId === sid)).toEqual([])
    store.close()
  })

  it('遮蔽区间起点落在窗口之外 → 跳过该载体（窗内守恒判定不成立）', async () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/floor')!
    const sid = store.createSession('窗外书')
    store.appendEvents(sid, [{ type: 'session/start', data: { book: '窗外书' } }])
    store.appendEvents(sid, [
      { type: 'user/message', data: { message: 'a' }, surfaceOp: 'append' },
      { type: 'user/message', data: { message: 'b' }, surfaceOp: 'append' },
    ])
    store.appendEvents(sid, [
      {
        type: 'compaction/end',
        data: { reason: 'completed' },
        surfaceOp: 'replace',
        shadowStart: 2,
        shadowEnd: 3,
        sourceSeqs: [2, 3],
      },
    ])
    const db = new DatabaseSync(store.dbPath)
    let out: ReturnType<typeof checkEventStreamIntegrity>
    try {
      // 尾窗只取 1 行（就是那条载体）：区间起点 2 < 窗内最旧 seq → 跳过，intervals 为 0
      out = checkEventStreamIntegrity(db, 1)
    } finally {
      db.close()
    }
    expect(out.intervals).toBe(0)
    expect(out.issues).toEqual([])
    store.close()
  })

  it('遮蔽区间不一致 → 关闭时 warn 留痕（含会话键与差异数）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/selfcheck')!
    seedBrokenShadow(store)
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    try {
      store.close()
      const msgs = warn.mock.calls.map((c) => String(c[1]))
      const hit = msgs.find((m) => m.includes('事件流自检发现'))
      expect(hit).toBeDefined()
      expect(hit).toContain('可见仅') // 判词来自 projection 的守恒步（含区间与可见条数）
      expect(hit).toContain(store.dbPath) // 留痕带库路径
    } finally {
      warn.mockRestore()
    }
  })

  it('数据一致 → 关闭时零告警（对照组，防误报刷屏）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/ok')!
    const sid = store.createSession('好遮蔽书')
    store.appendEvents(sid, [
      { type: 'session/start', data: { book: '好遮蔽书' } },
      { type: 'user/message', data: { message: '一' }, surfaceOp: 'append' },
      { type: 'user/message', data: { message: '二' }, surfaceOp: 'append' },
    ])
    store.appendEvents(sid, [
      {
        type: 'compaction/end',
        data: { reason: 'completed' },
        surfaceOp: 'replace',
        shadowStart: 2,
        shadowEnd: 3,
        sourceSeqs: [2, 3],
      },
    ])
    store.appendEvents(sid, [{ type: 'session/end', data: { reason: 'completed' } }])
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    try {
      store.close()
      expect(warn.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('事件流自检'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('env 强制档：置 0 强制关（不一致也不告警）；置 1 强制开', () => {
    const ud = tmpRoot()
    const off = openSessionStore(ud, '/books/off')!
    seedBrokenShadow(off)
    process.env.CLWRITING_EVENTS_SELF_CHECK = '0'
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    try {
      off.close()
      expect(warn.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('事件流自检'))).toEqual([])
    } finally {
      warn.mockRestore()
      delete process.env.CLWRITING_EVENTS_SELF_CHECK
    }
    const on = openSessionStore(ud, '/books/on')!
    seedBrokenShadow(on)
    process.env.CLWRITING_EVENTS_SELF_CHECK = '1'
    const warn2 = vi.spyOn(log, 'warn').mockReturnValue()
    try {
      on.close()
      expect(warn2.mock.calls.map((c) => String(c[1])).some((m) => m.includes('事件流自检发现'))).toBe(true)
    } finally {
      warn2.mockRestore()
      delete process.env.CLWRITING_EVENTS_SELF_CHECK
    }
  })

  it('校验自身抛错 → 降级留痕，关闭流程照常完成（句柄收口、标记注销）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/errors')!
    const sid = store.createSession('查询失败书')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' }])
    // 让 events 名下的查询必抛：真表改名让位，同名视图指向不存在的表（只在自检取行时炸，
    // 关闭流程的其余段落不碰 events）
    const db = new DatabaseSync(store.dbPath)
    try {
      db.exec('ALTER TABLE events RENAME TO events_bak')
      db.exec('CREATE VIEW events AS SELECT * FROM events_missing')
    } finally {
      db.close()
    }
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    try {
      expect(() => store.close()).not.toThrow()
      expect(warn.mock.calls.map((c) => String(c[1])).some((m) => m.includes('事件流自检降级'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
    // 关闭流程照常收口：开口标记已注销
    expect(existsSync(store.dbPath + '.open-' + process.pid)).toBe(false)
    // 还原真表 → 同路径重开读到原数据（关闭把句柄收干净了）
    const restore = new DatabaseSync(store.dbPath)
    try {
      restore.exec('DROP VIEW events')
      restore.exec('ALTER TABLE events_bak RENAME TO events')
    } finally {
      restore.close()
    }
    const reopened = openSessionStore(ud, '/books/errors')
    expect(reopened).not.toBeNull()
    expect(reopened!.listEvents('查询失败书')).toHaveLength(1)
    reopened!.close()
  })
})

// ── A1：事件库体积/行数只读观测 + 超阈告警（不改保留语义）──────────────

describe('事件库体积观测', () => {
  it('行数超阈 → warn 留痕；观测只读、幂等且不改任何保留语义', async () => {
    const { observeEventStoreSize, __setEventStoreRowWarnThresholdForTest } = await import(
      '../../src/events/store-retention.js'
    )
    const dbPath = join(tmpRoot(), 'footprint.db')
    const db = new DatabaseSync(dbPath)
    db.exec(
      'CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)',
    )
    db.exec("INSERT INTO events VALUES (1, 'llm/call', 1, '{}'), (2, 'llm/call', 2, '{}')")
    const spy = vi.spyOn(log, 'warn')
    __setEventStoreRowWarnThresholdForTest(200_000)
    try {
      // 阈内：零留痕（观测不因读数本身说话）
      expect(observeEventStoreSize(db, dbPath).rows).toBe(2)
      expect(spy).not.toHaveBeenCalled()
      __setEventStoreRowWarnThresholdForTest(1)
      expect(observeEventStoreSize(db, dbPath).rows).toBe(2)
      expect(spy.mock.calls.some((c) => String(c[1]).includes('体积/行数超阈'))).toBe(true)
      // 幂等：同库不重复留痕（按库节流），且行仍在（只读观测不删数据）
      const calls = spy.mock.calls.length
      observeEventStoreSize(db, dbPath)
      expect(spy.mock.calls.length).toBe(calls)
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(2)
    } finally {
      __setEventStoreRowWarnThresholdForTest(200_000)
      spy.mockRestore()
      db.close()
    }
  })
})
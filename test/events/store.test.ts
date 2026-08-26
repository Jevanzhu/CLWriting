/**
 * F1-P1 事件库存取层单测：建库/写入/读取/清空/启动修复。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'f1-store-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('F1-P1 bookHash', () => {
  it('稳定且不同路径不同', () => {
    const a = bookHash('/books/a')
    expect(bookHash('/books/a')).toBe(a)
    expect(bookHash('/books/b')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
});

describe('F1-P1 store 存取', () => {
  it('userDataPath 为空 → null（退化内存模式）', () => {
    expect(openSessionStore(null, '/books/a')).toBeNull()
    expect(openSessionStore(undefined, '/books/a')).toBeNull()
  })

  it('appendEvents 落库且 seq 连续；listEvents 按 seq 升序返回', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
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
    const store = openSessionStore(ud, '/books/a')!;
    const s1 = store.createSession('书A')
    const s2 = store.createSession('书A')
    store.appendEvent(s1, { type: 'user/message', data: { message: 'm1' }, surfaceOp: 'append' })
    store.appendEvent(s2, { type: 'user/message', data: { message: 'm2' }, surfaceOp: 'append' })
    expect(store.listEvents('书A', s1).map((e) => e.data['message'])).toEqual(['m1'])
    expect(store.listEvents('书A').map((e) => e.data['message'])).toEqual(['m1', 'm2'])
    store.close()
  })

  it('O-2（第十三轮）listEvents limit 限量通道：seq 升序取前 N；非法 limit 归全量', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'session/start', data: {} },
      ...[1, 2, 3, 4].map((i) => ({ type: 'user/message' as const, data: { message: `m${i}` }, surfaceOp: 'append' as const })),
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
    const store = openSessionStore(ud, '/books/a')!;
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
    const store = openSessionStore(ud, '/books/a')!;
    store.close()
    const dbPath = join(ud, 'clwriting', 'session', bookHash('/books/a') + '.db')
    writeFileSync(dbPath, Buffer.from('not a sqlite database at all'.repeat(10)))
    expect(() => openSessionStore(ud, '/books/a')).toThrow()
    // 坏库清走后同路径可开可写——openStores 无残留登记/句柄阻塞
    rmSync(dbPath, { force: true })
    const store2 = openSessionStore(ud, '/books/a')!;
    store2.appendEvent(store2.createSession('书A'), { type: 'session/start', data: {} })
    store2.close()
  })

  it('clearBook 清空本书事件与 session', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    expect(store.lastSeq()).toBe(1)
    store.clearBook('书A')
    expect(store.listEvents('书A')).toHaveLength(0)
    expect(store.lastSeq()).toBe(0)
    store.close()
  })

  it('RB-IF-P2-1: clearBook 原子——第二条 DELETE 失败时第一条整体回滚（不留孤儿 events）', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'user/message', data: { message: '审计数据' }, surfaceOp: 'append' })
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
    const store = openSessionStore(ud, '/books/a')!;
    // 双钥匙两 book 键，各挂一条事件
    const s1 = store.createSession('书A')
    store.appendEvent(s1, { type: 'user/message', data: { message: '对话侧' }, surfaceOp: 'append' })
    const s2 = store.createSession('书A#hash')
    store.appendEvent(s2, { type: 'user/message', data: { message: '工作流侧' }, surfaceOp: 'append' })
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
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    // 触发错误：未知 type 不报错（SQLite 不校验），改用 data 为不可序列化对象
    const bad: Record<string, unknown> = {}
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => store.appendEvents(sid, [{ type: 'user/message', data: cyc, surfaceOp: 'append' }])).toThrow()
    expect(store.listEvents('书A')).toHaveLength(0)
    void bad;
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
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: { book: '书A' } })
    store.appendEvent(sid, { type: 'user/message', data: { message: 'crash' }, surfaceOp: 'append' })
    store.close()
    backdateEvents(ud, '/books/a', 11 * 60 * 1000) // 超过 10 分钟宽限期
    // 重开库（模拟崩溃后重启）
    const store2 = openSessionStore(ud, '/books/a')!;
    const evs = store2.listEvents('书A')
    const ends = evs.filter((e) => e.type === 'session/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data['reason']).toBe('interrupted')
    store2.close()
  })

  it('O-7（第十三轮）孤儿修复补 end 时同步 touch sessions.updated_at（不被 latestSession 当新会话选中恢复）', () => {
    const ud = tmpRoot()
    const t0 = Date.now()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: {} })
    store.close()
    // 事件与 sessions 双双回拨：修复前 updated_at 停留在创建时刻（t0-11min）
    backdateEvents(ud, '/books/a', 11 * 60 * 1000)
    backdateSessions(ud, '/books/a', 11 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!;
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
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: {} })
    store.close()
    backdateEvents(ud, '/books/a', 11 * 60 * 1000)
    backdateSessions(ud, '/books/a', 11 * 60 * 1000)
    const dbPath = join(ud, 'clwriting', 'session', bookHash('/books/a') + '.db')
    const before = new DatabaseSync(dbPath)
    before.exec("CREATE TRIGGER mock_touch_fail BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'mock touch fail'); END")
    const updatedAtBefore = (before.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(sid) as { updated_at: number }).updated_at
    before.close()
    // 重开库触发修复：touch 抛错 → 事务回滚 → 开库抛出（不静默半态）
    expect(() => openSessionStore(ud, '/books/a')).toThrow('mock touch fail')
    // 半态校验：end 未补（INSERT 已回滚），updated_at 未刷
    const probe = new DatabaseSync(dbPath)
    const ends = probe.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'session/end'").get(sid) as { n: number }
    const updatedAtAfter = (probe.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get(sid) as { updated_at: number }).updated_at
    probe.exec('DROP TRIGGER mock_touch_fail')
    probe.close()
    expect(ends.n).toBe(0)
    expect(updatedAtAfter).toBe(updatedAtBefore)
    // 撤除模拟故障后重开：修复正常补齐（两步同事务原子上线）
    const store2 = openSessionStore(ud, '/books/a')!;
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    store2.close()
  })

  it('RB-IF-P2-2: 新近活跃的孤儿（伪孤儿，跨进程进行中）不补虚假 end', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: { book: '书A' } })
    store.appendEvent(sid, { type: 'user/message', data: { message: '另一进程进行中' }, surfaceOp: 'append' })
    store.close()
    // 不回拨：最后活动就在此刻（宽限期内）
    const store2 = openSessionStore(ud, '/books/a')!;
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
    store2.close()
  })

  it('RB-IF-P2-2: 恰在宽限期边界内（9 分钟前）仍不补', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: {} })
    store.close()
    backdateEvents(ud, '/books/a', 9 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!;
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
    store2.close()
  })

  it('正常收尾的 session 不补 closers', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: {} })
    store.appendEvent(sid, { type: 'session/end', data: { reason: 'completed' } })
    store.close()
    backdateEvents(ud, '/books/a', 11 * 60 * 1000)
    const store2 = openSessionStore(ud, '/books/a')!;
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    store2.close()
  })

  it('打开时仍在宽限期内的孤儿：长跑进程不重开库，写路径按 TTL 惰性补 end', () => {
    // 原缺陷：孤儿修复只在 openSessionStore 首次打开跑一次——崩溃残留若打开时
    // 距最后活动 <10min 被宽限期跳过，此后单例连接长开（refs>0）不再触发修复，
    // 孤儿 end 永远补不上（审计流缺收尾），除非进程重启。
    const ud = tmpRoot()
    const t0 = Date.now()
    vi.useFakeTimers({ now: t0 })
    try {
      const store = openSessionStore(ud, '/books/a')!;
      const sid = store.createSession('书A')
      store.appendEvent(sid, { type: 'session/start', data: {} })
      store.close()
      // 重开：孤儿最后活动 = t0（宽限期内）→ 打开修复跳过
      const store2 = openSessionStore(ud, '/books/a')!;
      expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
      // 宽限期过后（库保持打开，长跑进程）：写路径（createSession）触发 TTL 惰性修复
      vi.setSystemTime(t0 + 11 * 60 * 1000)
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
})


/**
 * F5 goal 状态机 + todo 快照单测：foldGoals（last-write-wins + clear tombstone）、
 * foldTodos（整表替换 + 空表清空）、构造器、validateEventStream 校验。
 */
import { describe, expect, it } from 'vitest'
import type { ChatEvent, GoalSnapshot, Todo } from '../../src/events/types.js'
import { foldGoals, foldTodos, getGoal, inSeqOrder } from '../../src/events/goal-state.js'
import { goalChangeEvent, todoWriteEvent } from '../../src/events/chain-bridge.js'
import { validateEventStream } from '../../src/events/projection.js'

let nextSeq = 1
function ev(type: ChatEvent['type'], data: Record<string, unknown>): ChatEvent {
  const s = nextSeq++
  return { seq: s, sessionId: 's', type, data, replaceGeneration: 1, createdAt: Date.now() }
}

function goal(partial: Partial<GoalSnapshot> & { id: string; title: string }): GoalSnapshot {
  return {
    description: undefined,
    state: 'active',
    roundsStarted: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  }
}

function todo(text: string, state: Todo['state']): Todo {
  return { text, state }
}

describe('F5 foldGoals', () => {
  it('create → 当前列表含该 goal；edit 覆盖快照（last-write-wins）', () => {
    nextSeq = 1
    const events = [
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g1', title: '修完第三章红项' }) }),
      ev('goal/change', { operation: 'edit', goal: goal({ id: 'g1', title: '修完第三章红项（含黄项）', roundsStarted: 1 }) }),
    ]
    const goals = foldGoals(events)
    expect(goals).toHaveLength(1)
    expect(goals[0]!.title).toBe('修完第三章红项（含黄项）')
    expect(goals[0]!.roundsStarted).toBe(1)
  })

  it('状态机：create → pause → resume → block → complete 按序覆盖 state', () => {
    nextSeq = 1
    const mk = (state: GoalSnapshot['state']): ChatEvent =>
      ev('goal/change', { operation: state === 'active' ? 'create' : state === 'paused' ? 'pause' : state === 'blocked' ? 'block' : 'resume', goal: goal({ id: 'g1', title: 't', state }) })
    const events = [
      mk('active'),
      mk('paused'),
      mk('active'), // resume
      mk('blocked'),
      mk('complete'),
    ]
    const goals = foldGoals(events)
    expect(goals[0]!.state).toBe('complete')
  })

  it('clear 是 tombstone——目标从结果移除', () => {
    nextSeq = 1
    const events = [
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g1', title: 't' }) }),
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g2', title: 't2' }) }),
      ev('goal/change', { operation: 'clear', goal: goal({ id: 'g1', title: 't' }) }),
    ]
    const goals = foldGoals(events)
    expect(goals.map((g) => g.id)).toEqual(['g2'])
    expect(getGoal(events, 'g1')).toBeNull()
  })

  it('脏载荷（非法 operation / 缺 id）静默跳过，不炸重放', () => {
    nextSeq = 1
    const events = [
      ev('goal/change', { operation: 'bogus', goal: goal({ id: 'g1', title: 't' }) }),
      ev('goal/change', { operation: 'create', goal: { title: 'no-id' } }),
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g2', title: 'ok' }) }),
    ]
    expect(foldGoals(events).map((g) => g.id)).toEqual(['g2'])
  })

  it('非 goal/change 事件不影响 fold', () => {
    nextSeq = 1
    const events = [
      ev('todo/write', { todos: [] }),
      ev('step/start', { task: 'x', layer: 'draft' }),
    ]
    expect(foldGoals(events)).toEqual([])
  })
})

describe('F5 foldTodos', () => {
  it('最后一个 todo/write 整表生效（last-write-wins）', () => {
    nextSeq = 1
    const events = [
      ev('todo/write', { todos: [todo('写首稿', 'pending'), todo('机检', 'pending')] }),
      ev('todo/write', { todos: [todo('写首稿', 'completed'), todo('机检', 'in_progress'), todo('修复红项', 'pending')] }),
    ]
    const todos = foldTodos(events)
    expect(todos.map((t) => t.text)).toEqual(['写首稿', '机检', '修复红项'])
    expect(todos.find((t) => t.text === '机检')!.state).toBe('in_progress')
  })

  it('空表 = 清空', () => {
    nextSeq = 1
    const events = [
      ev('todo/write', { todos: [todo('写首稿', 'pending')] }),
      ev('todo/write', { todos: [] }),
    ]
    expect(foldTodos(events)).toEqual([])
  })

  it('脏条目（缺 state / 非法 state）被过滤', () => {
    nextSeq = 1
    const events = [
      ev('todo/write', {
        todos: [
          todo('好的', 'pending'),
          { text: '缺状态' },
          { text: '坏状态', state: 'done' },
          { state: 'completed' },
        ],
      }),
    ]
    const todos = foldTodos(events)
    expect(todos.map((t) => t.text)).toEqual(['好的'])
  })
})

describe('F5 构造器 + 校验', () => {
  it('goalChangeEvent / todoWriteEvent 载荷形状正确', () => {
    const g = goal({ id: 'g1', title: 't' })
    const ge = goalChangeEvent({ operation: 'create', goal: g })
    expect(ge.type).toBe('goal/change')
    expect(ge.data['operation']).toBe('create')
    expect((ge.data['goal'] as GoalSnapshot).id).toBe('g1')

    const te = todoWriteEvent({ todos: [todo('a', 'pending')] })
    expect(te.type).toBe('todo/write')
    expect((te.data['todos'] as Todo[])).toHaveLength(1)
  })

  it('validateEventStream：合法 goal/todo 通过；非法 operation / 缺快照 / 坏条目报问题', () => {
    nextSeq = 1
    const good = [
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g1', title: 't' }) }),
      ev('todo/write', { todos: [todo('a', 'pending')] }),
    ]
    expect(validateEventStream(good)).toEqual([])

    const bad = [
      ev('goal/change', { operation: 'bogus', goal: goal({ id: 'g1', title: 't' }) }),
      ev('goal/change', { operation: 'create', goal: { title: 'no-id' } }),
      ev('todo/write', { todos: [{ text: 'x', state: 'done' }] }),
    ]
    expect(validateEventStream(bad).some((i) => i.message.includes('非法 operation'))).toBe(true)
    expect(validateEventStream(bad).some((i) => i.message.includes('缺 id/title'))).toBe(true)
    expect(validateEventStream(bad).some((i) => i.message.includes('含非法条目'))).toBe(true)
  })
})

// ── R66-17（十四轮）：fold 输入零拷贝有序检测 ──────────────────
// 修法见 src/events/goal-state.ts inSeqOrder：listEvents 产物已 ORDER BY seq 升序，
// 生产链每请求 foldGoals+foldTodos 不再各做一次全量复制排序（audit 长书两 fold 同数组）。
describe('R66-17: fold 输入 seq 有序化（零拷贝有序检测）', () => {
  it('升序输入（listEvents 生产口径）→ inSeqOrder 原引用直用（零拷贝）', () => {
    const ordered = [
      ev('goal/change', { operation: 'create', goal: goal({ id: 'g1', title: 't1' }) }),
      ev('todo/write', { todos: [todo('a', 'pending')] }),
    ]
    expect(inSeqOrder(ordered)).toBe(ordered) // 同引用——未复制未排序
  })

  it('乱序输入 → 排序副本（原数组不动；fold 结果与喂有序数组一致）', () => {
    const e1 = ev('todo/write', { todos: [todo('旧表', 'pending')] })
    const e2 = ev('todo/write', { todos: [todo('新表', 'in_progress')] })
    const scrambled = [e2, e1] // seq 降序
    const fixed = inSeqOrder(scrambled)
    expect(fixed).not.toBe(scrambled) // 复制
    expect(fixed.map((e) => e.seq)).toEqual([e1.seq, e2.seq])
    expect(scrambled.map((e) => e.seq)).toEqual([e2.seq, e1.seq]) // 原数组不动
    // last-write-wins 语义在乱序输入下仍按 seq 定序（高 seq 整表胜出）
    expect(foldTodos(scrambled)).toEqual([todo('新表', 'in_progress')])
    expect(foldTodos(scrambled)).toEqual(foldTodos(fixed))
  })
})

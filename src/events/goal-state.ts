/**
 * F5 goal 状态机 + todo 快照重放纯函数（DSH-11/DSH-12，第5.2/5.3节）。
 *
 * - foldGoals：按 seq 顺序重放 goal/change 事件 → 当前 goal 列表。
 *   每次变更整快照落库（last-write-wins，无增量对账）；clear 是 tombstone——
 *   从结果移除目标；终态（complete）保留但状态不变。
 * - foldTodos：取最后一个 todo/write 的整表（last-write-wins；空表 = 清空）。
 *
 * 纯函数，不依赖 DB——单测直接喂事件数组。
 */
import type { ChatEvent, GoalSnapshot, Todo } from './types.js'

/** goal/change 事件载荷的轻量读取（避免依赖 ChatEvent 泛型字段） */
interface GoalChangePayload {
  operation?: unknown
  goal?: unknown
}

interface TodoWritePayload {
  todos?: unknown
}

/** 校验 goal 快照形状（脏数据不炸重放——观测层纪律） */
function asGoal(raw: unknown): GoalSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (typeof g['id'] !== 'string' || typeof g['title'] !== 'string') return null
  const state = g['state']
  if (state !== 'active' && state !== 'paused' && state !== 'blocked' && state !== 'complete') return null
  return {
    id: g['id'] as string,
    title: g['title'] as string,
    ...(typeof g['description'] === 'string' ? { description: g['description'] as string } : {}),
    state,
    roundsStarted: typeof g['roundsStarted'] === 'number' ? (g['roundsStarted'] as number) : 0,
    ...(typeof g['maxGoalRounds'] === 'number' ? { maxGoalRounds: g['maxGoalRounds'] as number } : {}),
    ...(typeof g['blockedReason'] === 'string' ? { blockedReason: g['blockedReason'] as string } : {}),
    createdAt: typeof g['createdAt'] === 'number' ? (g['createdAt'] as number) : 0,
    updatedAt: typeof g['updatedAt'] === 'number' ? (g['updatedAt'] as number) : 0,
  }
}

function asTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t['text'] !== 'string') return null
  const state = t['state']
  if (state !== 'pending' && state !== 'in_progress' && state !== 'completed') return null
  return { text: t['text'] as string, state }
}

/**
 * 重放 goal/change 事件 → 当前 goal 列表（按 seq 顺序，last-write-wins）。
 * - create/edit：覆盖该 id 的快照
 * - pause/resume/complete/block：更新 state（完整快照仍在事件里，直接覆盖）
 * - clear：移除（tombstone）
 * 脏载荷静默跳过（不炸重放）。
 */
export function foldGoals(events: ChatEvent[]): GoalSnapshot[] {
  const goals = new Map<string, GoalSnapshot>()
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const ev of sorted) {
    if (ev.type !== 'goal/change') continue
    const d = ev.data as GoalChangePayload
    const op = d['operation']
    if (op !== 'create' && op !== 'edit' && op !== 'pause' && op !== 'resume' && op !== 'complete' && op !== 'block' && op !== 'clear') continue
    const goal = asGoal(d['goal'])
    if (!goal) continue
    if (op === 'clear') {
      goals.delete(goal.id)
      continue
    }
    goals.set(goal.id, goal)
  }
  return [...goals.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 重放 todo/write 事件 → 当前任务清单（最后一个整表，last-write-wins；空表 = 清空） */
export function foldTodos(events: ChatEvent[]): Todo[] {
  let todos: Todo[] = []
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  for (const ev of sorted) {
    if (ev.type !== 'todo/write') continue
    const d = ev.data as TodoWritePayload
    if (!Array.isArray(d['todos'])) continue
    todos = d['todos'].map(asTodo).filter((t): t is Todo => t !== null)
  }
  return todos
}

/** 单个 goal 快照的当前状态（无事件 → null） */
export function getGoal(events: ChatEvent[], goalId: string): GoalSnapshot | null {
  return foldGoals(events).find((g) => g.id === goalId) ?? null
}

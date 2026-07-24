import { apiJson } from './client'

// 工作台 HTTP 端点（细案 §2.2）。AI 类（spawn/outline）阻塞数十秒，调用方防重复提交。

// GET /state → 当前态机状态（状态卡）
export interface BookState {
  state: number
  stateName: string
  humanMsg: string
  action: string
  nextChapter?: number
  kind?: string
}
export async function getState(name: string): Promise<BookState> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/state`)
}

// POST /spawn {role?, prompt?, mode?} —— 起角色生成（AI 阻塞）
export async function spawnRole(
  name: string,
  body: { role?: string; prompt?: string; mode?: 'spawnRole' | 'send' },
): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// POST /interrupt —— 中断当前生成
export async function interrupt(name: string): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/interrupt`, { method: 'POST' })
}

// POST /draft-save {chapter, content}
export async function saveDraft(name: string, chapter: number, content: string): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/draft-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter, content }),
  })
}

// GET /draft-prompt?chapter= → {prompt}
export async function getDraftPrompt(name: string, chapter: number): Promise<{ prompt: string }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/draft-prompt?chapter=${chapter}`)
}

// POST /cli {step, chapter?, yes?} —— 确定性 CLI 步骤（prepare/confirm/check/finalize/enter/hand/rebook）
export interface CliResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}
export async function runCli(
  name: string,
  body: { step: string; chapter?: number; yes?: boolean },
): Promise<CliResult> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// POST /outline {chapter} —— 大纲生成（AI 阻塞，多源合成）
export async function generateOutline(name: string, chapter: number): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/outline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter }),
  })
}

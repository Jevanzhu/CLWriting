/** 书架 + 单书 API（对接 /api/books 系列） */
import type {
  BookMeta,
  BookOverview,
  CharacterCard,
  BookConfigLoose,
  DiffLine,
  FileEntry,
  LeadsData,
  MetricsReport,
  OnboardStepKey,
  PieceDetailData,
  PieceSummary,
  Rhythm,
  RewriteResult,
  SettingsData,
  StyleTrend,
  RealmSystem,
} from '../types'
import { apiJson } from './http'

function requireOk<T extends { ok?: boolean; error?: string }>(r: T): T {
  if (r.ok === false) throw new Error(r.error ?? '操作失败')
  return r
}

/** GET /api/books 响应 */
export interface ListBooksResponse {
  books: BookMeta[]
  workDir: boolean
  hint?: string
}

/** 书架列表（读 books.jsonl；workDir 为 null 时 books 空 + hint） */
export async function listBooks(): Promise<ListBooksResponse> {
  return apiJson<ListBooksResponse>('/api/books')
}

export function bookPath(name: string, suffix: string): string {
  return `/api/books/${encodeURIComponent(name)}${suffix}`
}

export async function getOverview(name: string): Promise<BookOverview> {
  return apiJson<BookOverview>(bookPath(name, '/overview'))
}

export async function getRhythm(name: string): Promise<Rhythm> {
  return apiJson<Rhythm>(bookPath(name, '/rhythm'))
}

export async function getLeads(name: string): Promise<LeadsData> {
  return apiJson<LeadsData>(bookPath(name, '/leads'))
}

export async function getPiece(name: string, no: number): Promise<PieceDetailData> {
  return apiJson<PieceDetailData>(bookPath(name, `/piece/${no}`))
}

export async function listPieces(name: string): Promise<PieceSummary[]> {
  const r = await apiJson<{ pieces?: PieceSummary[] }>(bookPath(name, '/pieces'))
  return r.pieces ?? []
}

export async function getSettings(name: string): Promise<SettingsData> {
  return apiJson<SettingsData>(bookPath(name, '/settings'))
}

export async function updateCharacter(name: string, card: CharacterCard): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(bookPath(name, '/settings/character'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(card),
  }))
}

export async function updateRealm(
  name: string,
  body: { 体系: RealmSystem[]; 正文?: string },
): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(bookPath(name, '/settings/realm'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export async function getHealth(name: string): Promise<{
  metrics: MetricsReport
  style: StyleTrend
}> {
  const [metrics, style] = await Promise.all([
    apiJson<MetricsReport>(bookPath(name, '/health/metrics')),
    apiJson<StyleTrend>(bookPath(name, '/health/style')),
  ])
  return { metrics, style }
}

export interface CreateBookRequest {
  name: string
  genre: string
  kind: 'long' | 'short'
  host: 'cc' | 'codex'
  leads?: string[]
  targetWords?: number
  brief?: string
}

export async function createBook(body: CreateBookRequest): Promise<{ name?: string }> {
  return apiJson<{ name?: string }>('/api/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function runOnboardStep(
  name: string,
  step: OnboardStepKey,
  discussionContext?: string,
): Promise<{ path: string; words: number; content: string }> {
  const r = await apiJson<{ ok?: boolean; path?: string; words?: number; content?: string }>(
    bookPath(name, '/onboard-ai'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(discussionContext ? { step, discussionContext } : { step }),
    },
  )
  requireOk(r)
  return { path: r.path ?? '', words: r.words ?? 0, content: r.content ?? '' }
}

export async function saveOnboardStep(
  name: string,
  step: OnboardStepKey,
  content: string,
): Promise<{ words?: number }> {
  return requireOk(await apiJson<{ ok?: boolean; words?: number; error?: string }>(bookPath(name, '/onboard-save'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step, content }),
  }))
}

export async function getConfig(name: string): Promise<BookConfigLoose> {
  const r = await apiJson<{ config: BookConfigLoose }>(bookPath(name, '/config'))
  return r.config
}

export async function putConfig(name: string, config: BookConfigLoose): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(bookPath(name, '/config'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config }),
  }))
}

export async function listFiles(name: string): Promise<FileEntry[]> {
  const r = await apiJson<{ files?: FileEntry[] }>(bookPath(name, '/files'))
  return r.files ?? []
}

export async function readFile(name: string, file: string): Promise<string> {
  const r = await apiJson<{ content?: string }>(
    `${bookPath(name, '/file')}?file=${encodeURIComponent(file)}`,
  )
  return r.content ?? ''
}

export async function writeFile(name: string, file: string, content: string): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(`${bookPath(name, '/file')}?file=${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  }))
}

export interface CliTextResult {
  stdout?: string
  stderr?: string
  error?: string
}

export async function exportBook(
  name: string,
  body: { format: string; platform: string },
): Promise<CliTextResult> {
  return apiJson<CliTextResult>(bookPath(name, '/export'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function importBook(body: Record<string, unknown>): Promise<CliTextResult> {
  return apiJson<CliTextResult>('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function enableRag(
  name: string,
  body: Record<string, unknown>,
): Promise<CliTextResult> {
  return apiJson<CliTextResult>(bookPath(name, '/enable-rag'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export interface LearnSampleCandidate {
  场景: string
  正文: string
  出处: string
  章号: number
  打分: number
  技法指令?: string
}

export interface LearnQuoteCandidate {
  场景: string
  正文: string
  出处: string
  章号: number
}

export interface LearnCandidates {
  samples: LearnSampleCandidate[]
  quotes: LearnQuoteCandidate[]
}

export async function knowledgeCheck(name: string): Promise<CliTextResult> {
  return apiJson<CliTextResult>(bookPath(name, '/knowledge-check'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
}

export async function learnStyle(name: string): Promise<LearnCandidates> {
  const r = await apiJson<{ samples?: LearnSampleCandidate[]; quotes?: LearnQuoteCandidate[]; error?: string }>(
    bookPath(name, '/learn'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
  )
  if (r.error) throw new Error(r.error)
  return { samples: r.samples ?? [], quotes: r.quotes ?? [] }
}

export async function commitLearnedStyle(
  name: string,
  body: LearnCandidates,
): Promise<{ sampleFiles?: string[]; quoteFiles?: string[] }> {
  return requireOk(await apiJson<{ ok?: boolean; sampleFiles?: string[]; quoteFiles?: string[]; error?: string }>(
    bookPath(name, '/learn-commit'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ))
}

export async function revertBook(name: string, chapter: number): Promise<{ message?: string }> {
  return requireOk(await apiJson<{ ok?: boolean; message?: string; error?: string }>(bookPath(name, '/revert'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapter }),
  }))
}

export async function rewriteDraft(
  name: string,
  body: { chapter: number; mode: 'local' | 'whole'; instruction: string; selection?: string },
): Promise<RewriteResult> {
  const r = await apiJson<{
    ok?: boolean
    mode?: 'local' | 'whole'
    original?: string
    rewritten?: string
    diff?: DiffLine[]
  }>(bookPath(name, '/rewrite'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  requireOk(r)
  return {
    mode: r.mode ?? body.mode,
    original: r.original ?? '',
    rewritten: r.rewritten ?? '',
    diff: r.diff ?? [],
  }
}

export async function applyRewrite(
  name: string,
  body: { chapter: number; content: string; accept: boolean },
): Promise<{ applied?: boolean }> {
  return requireOk(await apiJson<{ ok?: boolean; applied?: boolean; error?: string }>(bookPath(name, '/rewrite-apply'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export async function runCli(
  name: string,
  body: { step: 'confirm' | 'prepare' | 'check' | 'finalize' | 'hand'; chapter: number },
): Promise<{ ok?: boolean; stdout?: string; stderr?: string }> {
  return apiJson<{ ok?: boolean; stdout?: string; stderr?: string }>(bookPath(name, '/cli'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function generateOutline(
  name: string,
  chapter: number,
): Promise<{ path: string; words: number }> {
  const r = await apiJson<{ ok?: boolean; path?: string; words?: number }>(
    bookPath(name, '/outline'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter }),
    },
  )
  requireOk(r)
  return { path: r.path ?? '', words: r.words ?? 0 }
}

export async function getDraftPrompt(name: string, chapter: number): Promise<string> {
  const r = await apiJson<{ prompt?: string }>(
    `${bookPath(name, '/draft-prompt')}?chapter=${chapter}`,
  )
  return r.prompt ?? ''
}

export async function spawnRole(
  name: string,
  body: { role: string; prompt: string; mode: string },
): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(bookPath(name, '/spawn'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export async function interruptBook(name: string): Promise<void> {
  requireOk(await apiJson<{ ok?: boolean; error?: string }>(bookPath(name, '/interrupt'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }))
}

export async function runReview(
  name: string,
  chapter: number,
): Promise<{ lenses?: string[]; report?: string }> {
  return requireOk(await apiJson<{ ok?: boolean; lenses?: string[]; report?: string; error?: string }>(bookPath(name, '/review'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapter }),
  }))
}

export async function approveReview(name: string): Promise<{ approved?: boolean }> {
  return requireOk(await apiJson<{ ok?: boolean; approved?: boolean; error?: string }>(bookPath(name, '/review-verdict'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  }))
}

export async function saveDraft(
  name: string,
  body: { chapter: number; content: string },
): Promise<{ path: string; words: number }> {
  const r = await apiJson<{ ok?: boolean; path?: string; words?: number }>(
    bookPath(name, '/draft-save'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  requireOk(r)
  return { path: r.path ?? '', words: r.words ?? 0 }
}

export async function getState(name: string): Promise<{
  nextChapter?: number
  stateName?: string
  humanMsg?: string
}> {
  return apiJson<{ nextChapter?: number; stateName?: string; humanMsg?: string }>(
    bookPath(name, '/state'),
  )
}

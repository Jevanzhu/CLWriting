import { apiJson } from './client'

// 设定问答（问书）：POST /api/books/:name/ask → { ok, answer }
export async function askBook(
  bookName: string,
  question: string,
): Promise<{ ok: boolean; answer: string }> {
  return apiJson(`/api/books/${encodeURIComponent(bookName)}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  })
}

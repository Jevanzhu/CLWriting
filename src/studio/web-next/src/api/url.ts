// （全库源码质量评审修复批）：书级 URL 单源。
//
// 此前 `/api/books/${encodeURIComponent(name)}/…` 模板在 api/ 层 78 处、api 层之外
// （useHeartbeat / useSse）另有 5 处各自手拼——端点多一段、书名/ID 的编码口径改动时
// 只改一处即漂移（漏改点只表现为 404/编码错，编译期不可见）。收编为单一出口后，
// 调用方只给「书名 + 路径段」，编码与前缀形状只在本文件定义一次。
//
// 为什么段与查询分离：查询串（`?file=…`、`?refresh=1`、URLSearchParams）的编码口径
// 与路径段不同（前者是整值编码、含 `&`/`=` 分隔），一律由调用方在 bookUrl 之外拼接：
// `${bookUrl(name, 'file')}?file=${encodeURIComponent(path)}`——与收编前模板逐字一致。
//
// 为什么逐段编码而不是拼接后整串编码：段内可能含 `/`（书名/ID 均可），整串编码会把
// 路径分隔符也编掉。空 segment 会被编成空路径段（`/a//b`），调用方不要传空串。

/** 书级端点 URL：`/api/books/<书名>/<段…>`，书名与每段各自 encodeURIComponent。
 *  无段 = 书根端点（`/api/books/<书名>`，如 DELETE 删书）。 */
export function bookUrl(name: string, ...segments: string[]): string {
  let url = `/api/books/${encodeURIComponent(name)}`
  for (const seg of segments) url += `/${encodeURIComponent(seg)}`
  return url
}

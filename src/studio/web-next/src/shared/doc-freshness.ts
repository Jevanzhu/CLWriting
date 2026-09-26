/**
 * AI 落盘后 doc 缓存新鲜度——正文已写进磁盘，若该 docId 已在
 * doc 缓存（clean），openTab 命中旧内容。refresh 异步重拉对齐磁盘，不必 await（打开
 * 后编辑器内容随响应式 entry 自然更新）；dirty 不刷：本地有未保存编辑优先（
 * 本地优先口径，refresh 自身也保护 dirty 正文）；未缓存则 open 全新拉取，无需处理。
 *
 * 原为 WorkbenchView 本地 helper——healResult 消费面上移
 * WorkspaceShell（常驻层）后存草稿与收工跳转两处共用，单源收编本文件。
 */
import type { useDocStore } from '../stores/doc'

type DocStore = ReturnType<typeof useDocStore>

export function refreshCachedDoc(doc: DocStore, docId: string): void {
  const cached = doc.get(docId)
  if (cached && !cached.dirty) void doc.refresh(docId)
}

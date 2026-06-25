/** 文件树与读写（对接 GET /api/books/:name/files、GET/PUT /file）*/

/** 文件模式：text 纯文本 / md Markdown 高亮 */
export type FileMode = 'text' | 'md'

/** 可编辑文件条目（GET /files） */
export interface FileEntry {
  path: string
  mode: FileMode
}

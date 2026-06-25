/** 书籍元数据与总览（对接 GET /api/books、GET /api/books/:name/overview）*/

/** 书籍类型：long 长篇 / short 短篇集 */
export type BookKind = 'long' | 'short'

/** 书架单行（GET /api/books → books[]） */
export interface BookMeta {
  name: string
  path: string
  kind: BookKind
  created_at?: string
}

/** 书库（v5 LIBRARIES；当前单 workDir，currentLibId 接口预留） */
export interface Library {
  id: string
  name: string
  path: string
}

/** 单书总览（GET /api/books/:name/overview） */
export interface BookOverview {
  identity: {
    name: string
    kind: BookKind
    path: string
    created_at?: string
    title: string
    genre: string
    host: string
  }
  progress: {
    chapters: number
    words: number
    targetWords?: number
    percent?: number
  }
  state: {
    state: number
    name: string
    detail: unknown
  }
  volumes: { name: string; path: string }[]
  timeline: { date: string; count: number }[]
}

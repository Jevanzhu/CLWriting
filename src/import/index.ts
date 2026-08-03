/**
 * 轻量导入 —— 依据 M7 #36 spec。
 *
 * 把 v0.2 正文导入 v1 书仓库：复用 scaffold 建书 + 落定稿正文。
 * 统一导入入口 + length-routing 分流（长篇走本模块，短篇走 M8）。
 *
 * 复用边界（#36 第 3.2/5 节）：
 * - 建书复用 scaffoldBookRepo（M5 #30 同款 6.2 目录 + git + 文风铁律 + AGENTS.md）
 * - 落正文复用 writeChapter
 * - 登记复用 appendBook/writeActive
 *
 * 红线：短篇分流 M8；v0.2 无 v1 机检元数据 → 钩子/情绪填占位默认 + 诚实标注，不伪装。
 */

/** 净化文件名用字符串:剥离路径分隔符/连续点/控制字符,防落盘路径穿越 */
export function sanitizeName(s: string): string {
  const cleaned = s.replace(/[/\\]/g, '').replace(/\.{2,}/g, '.').replace(/[\x00-\x1f]/g, '').trim()
  // 净化后仅剩点('.' = 当前目录)或空 → 占位,防落盘成当前目录(如 '../' 折叠为 '.')
  return cleaned && cleaned !== '.' ? cleaned : '未命名'
}

export interface ImportOptions {
  /** v0.2 正文路径（文件） */
  sourcePath: string
  /** 工作目录（必填，由 CLI 层传入，逻辑层不碰 process.cwd） */
  workDir: string
  /** 书名（可选，从文件名推导） */
  name?: string
  /** 长短篇（可选，由 length-routing 判定） */
  kind?: 'long' | 'short'
  /** 题材（可选，驱动 leads） */
  genre?: string
}

export interface ImportResult {
  ok: boolean
  bookRoot?: string
  bookName?: string
  chapterCount?: number
  kind?: 'long' | 'short'
  error?: string
}

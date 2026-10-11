/**
 * web-next 语义树节点 fixture 单源（TreeNode 造件）。
 *
 * 收编 test/studio/webnext/** 里逐字复制的三款 makeNode：此前 18 档各持一份
 * 同体函数，差异只在「节点路径是否取自参数」。构造是纯函数、无副作用、无跨档
 * 状态——分档隔离（每档 setActivePinia / vi.mock）不受影响，故可安全单源。
 *
 * 三款形态对应三类既有盘面，名字即形态，避免合并成「什么都可配」的万能工厂：
 * - makeChapterNode：路径由 docId 推出（写作/正文/<docId>.md）——树形状驱动类用例；
 * - makeChapterNodeAt：路径显式传入——需要固定/异常路径的用例；
 * - makeDraftChapterNode：正文草稿节点（status: 'draft'）——草稿态/字数徽标类用例。
 */
import type { TreeNode } from '../../../../src/studio/web-next/src/types/tree'

/** 章节节点：路径与显示名都由 docId 推出（写作/正文/<docId>.md）。 */
export function makeChapterNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

/** 章节节点：路径显式传入（显示名取路径末段）。 */
export function makeChapterNodeAt(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

/** 正文草稿节点：status=draft，路径缺省为「写作/正文/第1章-标题.md」（显示名取路径末段）。 */
export function makeDraftChapterNode(docId: string, path = '写作/正文/第1章-标题.md'): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

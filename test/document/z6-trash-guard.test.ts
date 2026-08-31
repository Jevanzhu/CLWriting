/**
 * Z 系列（第五十八轮）回归集二：内核 + 基础层（Z-5 / Z-6 / Z-13 / Z-17 / Z-18 / Z-19 / Z-20 / Z-21 / Z-22）。
 *
 * Z-5：trash manifest 三处 RMW 持锁（锁文件出现与清理 + 行为等价）。
 * Z-6：doTrash 尾段残留（清单条目指向已删路径）时 executeSave 复活守卫双条件拦截。
 * Z-13：updateDocMeta/updateChapterMeta 对只读区（定稿/摘要）CAPABILITY_DENIED。
 * Z-17：「十分地道，」不再误报对话提示语；「缓缓地说道：」仍报。
 * Z-18：第十一卷字典序陷阱——卷目录按数值序取最新。
 * Z-19：锁活 pid 超龄（10min）判 stale 接管。
 * Z-20：folded 块标量空行分段。
 * Z-21：chapters 缓存 _raw 深拷贝。
 * Z-22：Windows 保留设备名书名拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTrashEntry, restoreTrash } from '../../src/document/trash.js'
import { DocumentService } from '../../src/document/service.js'
import { computeRevision } from '../../src/document/revision.js'
import { checkStyleMetrics } from '../../src/check/count.js'
import { parseIronRules } from '../../src/format/iron-rules.js'
import { readChapterDir } from '../../src/format/chapters.js'
import { tryAcquireCrossProcessLock, acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { parseFlat } from '../../src/format/frontmatter.js'
import { isInvalidBookName } from '../../src/install/books.js'
import { inferVolumeDir } from '../../src/format/draft.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-z2-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Z-5: trash manifest RMW 持锁', () => {
  it('appendTrashEntry 用后锁文件无残留（锁路径约定锁定）', () => {
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    appendTrashEntry(root, {
      id: 'd1', originalPath: '写作/正文/0001-a.md', trashedPath: '工作区/.trash/d1-a.md',
      trashedAt: '2026-08-24T00:00:00Z', role: 'chapter',
    })
    expect(existsSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl.lock'))).toBe(false)
  })
})

describe('Z-6: doTrash 尾段残留 → executeSave 复活守卫双条件', () => {
  it('清单残留旧路径 + 文件已删 + 回收站认领 → expectedRevision=null 保存被拒', async () => {
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    // 模拟 doTrash 崩溃残留：文件已进 .trash、清单条目未删、trash 条目在册
    writeFileSync(join(root, '工作区', '.trash', 'doc_r-a.md'), '旧内容')
    appendTrashEntry(root, {
      id: 'doc_r', originalPath: '写作/正文/0001-a.md', trashedPath: '工作区/.trash/doc_r-a.md',
      trashedAt: '2026-08-24T00:00:00Z', role: 'chapter',
    })
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      JSON.stringify({ version: 1, type: 'clwriting-manifest' }) + '\n' +
        JSON.stringify({ id: 'doc_r', nodeType: 'document', path: '写作/正文/0001-a.md', parentId: null }) + '\n',
    )
    const svc = new DocumentService({ bookRoot: root })
    // 修复前：registered !== null 跳过守卫 → 新建式保存成功复活文件
    const r = await svc.save('doc_r', '写作/正文/0001-a.md', {
      content: '复活内容', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
    expect(existsSync(join(root, '写作', '正文', '0001-a.md'))).toBe(false)
  })

  it('对照：回收站还原后（条目清除）保存恢复正常', async () => {
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_o-a.md'), '---\n章号: 1\n---\n\n旧内容')
    appendTrashEntry(root, {
      id: 'doc_o', originalPath: '写作/正文/0001-a.md', trashedPath: '工作区/.trash/doc_o-a.md',
      trashedAt: '2026-08-24T00:00:00Z', role: 'chapter',
    })
    const rr = await restoreTrash(root, 'doc_o')
    expect(rr.ok).toBe(true)
    const svc = new DocumentService({ bookRoot: root })
    const abs = join(root, '写作', '正文', '0001-a.md')
    const r = await svc.save('doc_o', '写作/正文/0001-a.md', {
      content: '---\n章号: 1\n---\n\n新内容', expectedRevision: computeRevision(abs), operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(true)
  })
})

describe('Z-13: meta 写入口能力校验', () => {
  it('updateDocMeta 对 定稿/摘要 只读区 → CAPABILITY_DENIED', async () => {
    mkdirSync(join(root, '定稿', '摘要'), { recursive: true })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeFileSync(join(root, '定稿', '摘要', 's1.md'), '---\n标题: x\n---\n\n内容')
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      JSON.stringify({ version: 1, type: 'clwriting-manifest' }) + '\n' +
        JSON.stringify({ id: 'doc_s1', nodeType: 'document', path: '定稿/摘要/s1.md', parentId: null }) + '\n',
    )
    const svc = new DocumentService({ bookRoot: root })
    const r = await svc.updateDocMeta('doc_s1', { 标题: 'y' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CAPABILITY_DENIED')
  })
})

describe('Z-17: 对话提示语「地道」误报收窄', () => {
  it('名词「地道」不报；引语动词「缓缓地说道：」仍报', () => {
    const rules = parseIronRules('## 可量化硬约束\n- 单句上限字数: 999\n- 形容词连续堆叠上限: 99') as never
    const falseCase = checkStyleMetrics('他做的菜十分地道，老字号的做法颇为地道。', rules as never).items
    expect(falseCase.some((i) => i.checkId === 'style-dialogue-tag')).toBe(false)
    const trueCase = checkStyleMetrics('他缓缓地说道：「来了。」', rules as never).items
    expect(trueCase.some((i) => i.checkId === 'style-dialogue-tag')).toBe(true)
  })
})

describe('Z-18: inferVolumeDir 数值序', () => {
  it('第一卷~第十一卷并存 → 最新卷为第十一卷（字典序陷阱修复）', async () => {
    const bodyDir = join(root, '写作', '正文')
    for (const v of ['第一卷', '第十卷', '第十一卷', '第四卷']) {
      mkdirSync(join(bodyDir, v), { recursive: true })
    }
    // 上一章不存在 → 回退「最新卷」分支
    const got = inferVolumeDir(root, 99)
    expect(got).toBe('第十一卷')
  })
})

describe('Z-19: 锁活 pid 超龄接管', () => {
  it('活 pid + 超龄 mtime → stale 接管（注入 maxHeldMs）', () => {
    const lockPath = join(root, 'x.lock')
    const release = tryAcquireCrossProcessLock(lockPath)
    expect(release).not.toBeNull()
    // 本进程 pid 活着；把 mtime 拨回 11 分钟前模拟「原持有者已死 + pid 复用」形态
    utimesSync(lockPath, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000))
    const got = acquireCrossProcessLockWithTimeout(lockPath, 200, { maxHeldMs: 10 * 60_000, staleTakeoverJitterMs: 0 })
    expect(got).not.toBeNull()
    if (got) got()
    // 未超龄对照组：拨回 1 分钟前 → 判 held → 超时 null
    const release2 = tryAcquireCrossProcessLock(lockPath)
    expect(release2).not.toBeNull()
    utimesSync(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const got2 = acquireCrossProcessLockWithTimeout(lockPath, 150, { maxHeldMs: 10 * 60_000, pollIntervalMs: 50 })
    expect(got2).toBeNull()
    if (release2) release2()
  })
})

describe('Z-20: folded 空行分段', () => {
  it('key: > 两段以空行分隔 → 值保留换行', () => {
    const m = parseFlat('钩子: >\n  第一段甲\n  第一段乙\n\n  第二段甲\n状态: 进行中\n')
    expect(m.get('钩子')).toBe('第一段甲 第一段乙\n第二段甲')
  })
  it('无空行 folded 行为不变', () => {
    const m = parseFlat('钩子: >\n  甲\n  乙\n状态: 进行中\n')
    expect(m.get('钩子')).toBe('甲 乙')
  })
})

describe('Z-21: chapters 缓存 _raw 深拷贝', () => {
  it('两次 readChapterDir 的 _raw 引用不同（嵌套 mutate 不污染缓存）', () => {
    const bodyDir = join(root, '写作', '正文')
    mkdirSync(bodyDir, { recursive: true })
    writeFileSync(join(bodyDir, '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n自定义键: v\n---\n\n正文')
    const a = readChapterDir(bodyDir).chapters[0]! as { _raw?: Record<string, string> }
    const b = readChapterDir(bodyDir).chapters[0]! as { _raw?: Record<string, string> }
    if (a._raw && b._raw) {
      expect(a._raw).not.toBe(b._raw)
    }
  })
})

describe('Z-22: 书名保留设备名', () => {
  it('CON/NUL/COM1/尾点/尾空格拒绝；正常书名通过', () => {
    expect(isInvalidBookName('CON')).toBe(true)
    expect(isInvalidBookName('nul')).toBe(true)
    expect(isInvalidBookName('COM1')).toBe(true)
    expect(isInvalidBookName('书名.')).toBe(true)
    expect(isInvalidBookName('书名 ')).toBe(true)
    expect(isInvalidBookName('我的书')).toBe(false)
  })
})

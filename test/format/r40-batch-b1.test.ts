/**
 * R40 B1 域（核心数据）修复批回归：四十轮主审收编件。
 *
 * - R40-9：writeBookConfig 全量重生成行尾口径（批一翻转：保真→规范形 LF）
 * - R40-10/11：.MD 大写扩展名口径统一（words.stripMd / leads.parseLeadFileName /
 *   readLeadDir 扫描侧，mac 敏感卷 + win 手工改名形态）
 * - R40-14：事件库 bookHash win32 大小写漂移归一（realpathSync 真实大小写）
 * - R40-15：lead-finalize 布线锁键 win32 折叠（与 service 侧 wiringFileLockKey 对称）
 * - R40-18/19：rmWithRetry 瞬时锁退避原语（EPERM/EBUSY 3×50ms；确定性错误直抛）
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, readBookConfig } from '../../src/format/yaml.js'
import { parseLeadFileName } from '../../src/format/leads.js'
import { parseChapterFileName } from '../../src/format/words.js'
import { bookHash } from '../../src/events/store.js'
import { wiringFileLockKeyOf } from '../../src/document/lead-finalize.js'
import { rmWithRetry } from '../../src/fs/atomic.js'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

describe('R40-9: writeBookConfig 行尾规范形（批一翻转）', () => {
  it('CRLF 书全量重生成归一 LF；LF 新文件缺省不变', () => {
    const root = tempDir('clw-r40-yaml-')
    const fp = join(root, 'book.yaml')
    // LF 新文件缺省（回归锚）
    const first = readBookConfig(fp).config
    writeBookConfig(fp, first)
    const lf = readFileSync(fp, 'utf-8')
    expect(lf.includes('\r\n')).toBe(false)

    // 手工把书改为 CRLF 形态（win 记事本/autocrlf），再走全量重生成——R40-9 曾锚定
    // 「仍 CRLF」保真；平台规范化批一（2026-09-03）推翻为规范形 LF：重生成归一 LF。
    writeFileSync(fp, lf.replace(/\n/g, '\r\n'), 'utf-8')
    const cfg = readBookConfig(fp).config
    writeBookConfig(fp, cfg)
    const out = readFileSync(fp, 'utf-8')
    expect(out.includes('\r')).toBe(false) // 无 \r 残留（含孤立 \r）
  })
})

describe('R40-10/11: .MD 大写扩展名口径', () => {
  it('parseChapterFileName：.MD 章文件名标题不残留扩展名尾', () => {
    expect(parseChapterFileName('152-北境的雪.MD')).toEqual({ 章号: 152, 标题: '北境的雪' })
    expect(parseChapterFileName('152-北境的雪.md')).toEqual({ 章号: 152, 标题: '北境的雪' })
  })

  it('parseLeadFileName：.MD 账本条目标题不残留扩展名尾', () => {
    expect(parseLeadFileName('悬念-031-雪夜伏笔.MD')).toEqual({ 编号: '悬念-031', 标题: '雪夜伏笔' })
    expect(parseLeadFileName('悬念-031-雪夜伏笔.md')).toEqual({ 编号: '悬念-031', 标题: '雪夜伏笔' })
  })

  it('readLeadDir 扫描侧认 .MD（isMdFileName 单源）', async () => {
    const root = tempDir('clw-r40-leads-')
    const dir = join(root, '伏笔')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '悬念-001-首条.MD'), '---\n编号: 悬念-001\n状态: 进行中\n---\n\n内容\n', 'utf-8')
    const { readLeadDir } = await import('../../src/format/leads.js')
    const r = readLeadDir(dir)
    expect(r.errors).toEqual([])
    expect(r.leads.length).toBe(1)
  })
})

describe('R40-14: bookHash win32 大小写漂移归一', () => {
  it.skipIf(process.platform !== 'win32')('真实目录的大小写变体同哈希（realpathSync 归一）', () => {
    const root = tempDir('clw-r40-hash-')
    // mkdtemp 尾段为真实盘上大小写；变体改最后一段大小写 → realpath 归一同键
    const seg = root.split(/[\\/]/).pop()!
    const drifted = root.slice(0, root.length - seg.length) + seg.toUpperCase()
    // mkdtemp 尾段可能本就含大写（hex 小写字母数字，toUpperCase 恒变化）——变体必须真的不同形
    expect(drifted.toLowerCase()).toBe(root.toLowerCase())
    expect(bookHash(drifted)).toBe(bookHash(root))
  })

  it('不存在路径不抛（回落词法形态）', () => {
    expect(typeof bookHash(join(tempDir('clw-r40-miss-'), '不存在的书'))).toBe('string')
  })
})

describe('R40-15: wiringFileLockKeyOf 平台折叠', () => {
  it('win32：小写折叠 + .lock；posix：原样 + .lock', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(wiringFileLockKeyOf('C:\\Book\\写作\\A.md')).toBe('c:\\book\\写作\\a.md.lock')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(wiringFileLockKeyOf('/book/写作/A.md')).toBe('/book/写作/A.md.lock')
  })
})

describe('R40-18/19: rmWithRetry 退避原语', () => {
  function eperm(): Error {
    return Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  }
  function enoent(): Error {
    return Object.assign(new Error('no such file'), { code: 'ENOENT' })
  }

  it('EPERM×2 后成功 → 重试两次、不抛', () => {
    let calls = 0
    const sleeps: number[] = []
    rmWithRetry('x.md', {
      rm: () => {
        if (++calls <= 2) throw eperm()
      },
      sleep: (ms) => sleeps.push(ms),
    })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([50, 100])
  })

  it('确定性错误（ENOENT）立即上抛、零重试', () => {
    let calls = 0
    let slept = 0
    let caught: unknown
    try {
      rmWithRetry('x.md', {
        rm: () => {
          calls++
          throw enoent()
        },
        sleep: () => slept++,
      })
    } catch (e) {
      caught = e
    }
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(calls).toBe(1)
    expect(slept).toBe(0)
  })

  it('退避 3 次仍 EPERM → 上抛（交调用方 WRITE_ERROR 收口）', () => {
    expect(() =>
      rmWithRetry('x.md', {
        rm: () => {
          throw eperm()
        },
        sleep: () => {},
      }),
    ).toThrow(/operation not permitted/)
  })
})

/**
 * 知识层更新入口（阶段 23 批 4）：双步 script 的模块语义 + 恒等红线。
 *
 * 红线：①update 产草稿不动 manifest；②commit 登记后存量条目逐字节不变
 * （B-18 bookHash 同款口径——仅 generated_at 与新增条目变化）；③commit 拒绝
 * 重复登记 / 路径越界 / 文件不在盘；④登记后对账（validateKnowledgeManifest）必须过。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeFalsePositives,
  renderFalsePositiveDraft,
  writeFalsePositiveDraft,
  commitKnowledgeFile,
  localIsoTimestamp,
} from '../../src/knowledge/update.js'
import { hashFileSha256, validateKnowledgeManifest } from '../../src/knowledge/manifest.js'

function fixture(): { root: string; corpusDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-update-'))
  const corpusDir = join(root, 'corpus')
  mkdirSync(join(root, '知识层'), { recursive: true })
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(
    join(corpusDir, 'body-parts.json'),
    JSON.stringify([
      { excerpt: '她的眼睛望着他，眼睛里映着火光。', expect: 'fire' },
      { excerpt: '山门外落了整夜的风雪。', expect: 'silent' },
      { excerpt: '钟声一声比一声沉。', expect: 'silent' },
    ]),
    'utf8',
  )
  writeFileSync(join(corpusDir, 'repetition.json'), JSON.stringify([{ excerpt: '重复排比。', expect: 'fire' }]), 'utf8')
  return { root, corpusDir }
}

function baseManifest(root: string, withExisting = true): void {
  writeFileSync(join(root, '知识层', '存量.md'), '---\nsource: 旧来源\nlicense: MIT\n---\n\n# 存量\n', 'utf8')
  const entries = withExisting
    ? [{
        target: '知识层/存量.md', source: '旧来源', license: 'MIT',
        sha256: hashFileSha256(join(root, '知识层', '存量.md')), category: '索引' as const,
      }]
    : []
  writeFileSync(
    join(root, '知识层', '_manifest.json'),
    JSON.stringify({ version: 1, generated_at: '2026-08-15T00:00:00+08:00', summary: { migrated: 1, deferred: 0, review_assets: 0 }, entries }, null, 2) + '\n',
    'utf8',
  )
}

describe('知识层更新：summarize + 草稿', () => {
  it('扫语料回归域：silent/fire 计数正确，纯 fire 与坏 JSON 文件跳过', () => {
    const { root, corpusDir } = fixture()
    try {
      writeFileSync(join(corpusDir, 'bad.json'), '{oops', 'utf8')
      const s = summarizeFalsePositives(corpusDir)
      expect(s).toHaveLength(1)
      expect(s[0]!.checkId).toBe('body-parts')
      expect(s[0]!.silent).toBe(2)
      expect(s[0]!.fire).toBe(1)
      expect(s[0]!.excerpts).toEqual(['山门外落了整夜的风雪。', '钟声一声比一声沉。'])
      expect(summarizeFalsePositives(join(root, '不存在'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('草稿渲染含 checkId 段与摘录；空语料出说明行', () => {
    const text = renderFalsePositiveDraft(
      [{ checkId: 'body-parts', silent: 2, fire: 1, excerpts: ['山门外落了整夜的风雪。'] }],
      '2026-08-24',
    )
    expect(text).toContain('## body-parts')
    expect(text).toContain('误报 2 条 / 真命中 1 条')
    expect(text).toContain('山门外落了整夜的风雪。')
    expect(text).toContain('未经作者审核不得入库')
    expect(renderFalsePositiveDraft([], '2026-08-24')).toContain('无 expect:"silent" 条目')
  })

  it('writeFalsePositiveDraft：草稿落 知识层/，manifest 逐字节不动', () => {
    const { root, corpusDir } = fixture()
    try {
      baseManifest(root)
      const before = readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')
      const rel = writeFalsePositiveDraft(root, corpusDir, '2026-08-24')
      expect(rel).toBe('知识层/机检误报-草稿-2026-08-24.md')
      expect(readFileSync(join(root, rel), 'utf8')).toContain('## body-parts')
      expect(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')).toBe(before) // 红线①
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('知识层更新：commit 登记', () => {
  it('登记新条目：sha256 实算、存量条目恒等、generated_at 更新、对账过', () => {
    const { root, corpusDir } = fixture()
    try {
      baseManifest(root)
      const finalRel = '知识层/机检误报规律.md'
      writeFalsePositiveDraft(root, corpusDir, '2026-08-24')
      writeFileSync(join(root, finalRel), '# 机检误报规律\n## body-parts\n作者归纳……\n', 'utf8')

      const before = JSON.parse(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8'))
      const report = commitKnowledgeFile(root, { target: finalRel, sourceRef: 'test/corpus/checks/body-parts.json', now: '2026-08-24T12:00:00+08:00' })
      expect(report.ok, report.issues.map((i) => i.message).join(';')).toBe(true)

      const after = JSON.parse(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8'))
      expect(after.entries).toHaveLength(2)
      expect(after.entries[0]).toEqual(before.entries[0]) // 红线②：存量逐字节（对象级）恒等
      expect(after.generated_at).toBe('2026-08-24T12:00:00+08:00')
      const added = after.entries[1]!
      expect(added.target).toBe(finalRel)
      expect(added.source).toBe('语料回归域')
      expect(added.sha256).toBe(hashFileSha256(join(root, finalRel)))
      expect(added.category).toBe('方法论')
      // 写回形态：2 空格 + 尾换行（与真实 _manifest.json 往返字节恒等口径一致）
      expect(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8').endsWith('\n')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('拒绝：重复登记 / target 越出 知识层/ / 定稿文件不在盘', () => {
    const { root } = fixture()
    try {
      baseManifest(root)
      expect(commitKnowledgeFile(root, { target: '知识层/存量.md' }).ok).toBe(false) // 已登记
      expect(commitKnowledgeFile(root, { target: 'README.md' }).ok).toBe(false) // 越界
      expect(commitKnowledgeFile(root, { target: '知识层/不存在.md' }).ok).toBe(false) // 不在盘
      // 三次拒绝后 manifest 不应被写入任何变化
      expect(validateKnowledgeManifest(root).ok).toBe(true)
      const m = JSON.parse(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8'))
      expect(m.entries).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R62-1：写盘走原子通道——草稿+登记后 知识层/ 无 .tmp 残留，manifest 字节口径不变', () => {
    // 修复前 writeFileSync 直写：中断留下半截 _manifest.json 会让下次读取校验整体失败
    const { root, corpusDir } = fixture()
    try {
      baseManifest(root)
      writeFalsePositiveDraft(root, corpusDir, '2026-08-25')
      const finalRel = '知识层/机检误报规律-R62.md'
      writeFileSync(join(root, finalRel), '# 机检误报规律\n## body-parts\n作者归纳……\n', 'utf8')
      const report = commitKnowledgeFile(root, { target: finalRel, now: '2026-08-25T10:00:00+08:00' })
      expect(report.ok, report.issues.map((i) => i.message).join(';')).toBe(true)

      // 同目录 tmp + rename：正常路径不留 .tmp 残留（sweep 兼容命名 `.<name>.<pid>.<uuid>.tmp`）
      const residue = readdirSync(join(root, '知识层')).filter((n) => n.endsWith('.tmp'))
      expect(residue).toEqual([])
      // 字节口径不变：2 空格缩进 JSON.stringify + 尾换行，与现 _manifest.json 往返恒等
      const raw = readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')
      expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R61-2：前缀穿透变体拒绝（../ 逃逸 / 绝对路径 / symlink 指库外），manifest 零写入', () => {
    const { root } = fixture()
    try {
      baseManifest(root)
      // `知识层/../` 前缀判穿透变体：解析后落 知识层 外（文件真实在盘也不得登记）
      writeFileSync(join(root, '库外定稿.md'), '# 库外\n', 'utf8')
      expect(commitKnowledgeFile(root, { target: '知识层/../库外定稿.md' }).ok).toBe(false)
      expect(commitKnowledgeFile(root, { target: join(root, '知识层', '存量.md') }).ok).toBe(false) // 绝对路径
      // symlink 指库外：resolveWithinRoot fail-closed（realpath 逃出 root）
      // win 需开发者模式才能建链接（EPERM）——该守卫语义由 mac/linux CI 腿覆盖
      if (process.platform !== 'win32') {
        symlinkSync(join(root, '库外定稿.md'), join(root, '知识层', '链.md'))
        expect(commitKnowledgeFile(root, { target: '知识层/链.md' }).ok).toBe(false)
      }
      // 全部拒绝后 manifest 零变化、库外文件未被注入 fm（仍是原文）
      const m = JSON.parse(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8'))
      expect(m.entries).toHaveLength(1)
      expect(readFileSync(join(root, '库外定稿.md'), 'utf8')).toBe('# 库外\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R65-14（总六十五轮）：generated_at 真实时区偏移（去硬编码 +08:00） ──
describe('R65-14：本地时区 ISO 时间戳', () => {
  const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/

  it('localIsoTimestamp：注入偏移的形态（正/负/半小时）与墙钟换算正确', () => {
    // UTC+8（旧口径的宿主形态，保持 2026-08-27T12:00:00.000+08:00 形态不变）
    expect(localIsoTimestamp(Date.UTC(2026, 7, 27, 4, 0, 0, 123), 480)).toBe('2026-08-27T12:00:00.123+08:00')
    // UTC-5（负偏移形态：-05:00；墙钟 = UTC - 5h）
    expect(localIsoTimestamp(Date.UTC(2026, 7, 27, 2, 0, 0, 0), -300)).toBe('2026-08-26T21:00:00.000-05:00')
    // UTC+5:30（半小时偏移：+05:30）
    expect(localIsoTimestamp(Date.UTC(2026, 7, 27, 0, 0, 0, 0), 330)).toBe('2026-08-27T05:30:00.000+05:30')
    // UTC+0 → +00:00（不再伪装 Z）
    expect(localIsoTimestamp(Date.UTC(2026, 7, 27, 0, 0, 0, 0), 0)).toBe('2026-08-27T00:00:00.000+00:00')
  })

  it('缺省偏移取宿主真实时区且形态合法（含负偏移形态的正则）', () => {
    const ts = localIsoTimestamp(Date.UTC(2026, 7, 27, 4, 0, 0, 0))
    expect(ts).toMatch(ISO_WITH_OFFSET)
    // 与注入宿主偏移的调用一致（缺省 = -getTimezoneOffset()）
    expect(ts).toBe(localIsoTimestamp(Date.UTC(2026, 7, 27, 4, 0, 0, 0), -new Date(Date.UTC(2026, 7, 27, 4, 0, 0, 0)).getTimezoneOffset()))
  })

  it('commit 不注入 now → generated_at 带宿主真实偏移的 ISO 形态（非硬编码 +08:00）', () => {
    const { root, corpusDir } = fixture()
    try {
      baseManifest(root)
      const finalRel = '知识层/机检误报规律2.md'
      writeFalsePositiveDraft(root, corpusDir, '2026-08-27')
      writeFileSync(join(root, finalRel), '# 规律\n## body-parts\n作者归纳……\n', 'utf8')
      const report = commitKnowledgeFile(root, { target: finalRel, sourceRef: 'test/corpus/checks/body-parts.json' })
      expect(report.ok, report.issues.map((i) => i.message).join(';')).toBe(true)
      const after = JSON.parse(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8'))
      expect(after.generated_at).toMatch(ISO_WITH_OFFSET)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * 生成端点覆盖写前快照留底（snapshotBeforeOverwrite）——按被测行为归并的单文件。
 *
 * 合并自两份同壳回归（2026-09-26 测试资产行为化批；原文件名记档：
 * r71-onboard-snapshot.test.ts（R71-9 + R26-59，2 describe 3 用例）+
 * r74-outline-snapshot.test.ts（R74-4，1 describe 2 用例）→ 5 用例零去重平移，
 * 双 harness 并为一书一服——两类生成端点（onboard/outline）共用同一快照机制；
 * R74-4 首例原「.版本 为空」前置断言随合并删去（同书前序用例已产快照，前置不再
 * 成立；断言主体「覆盖既有文件才留底」由本 describe 两用例完整保留）：
 *
 * 共同行为：AI 生成是分钟级窗口，作者可在窗口内手改目标文件（onboard-ai 与
 * onboard-save 闸键不同互不阻挡；PUT /file 白名单恰含 细纲.md 且与 outline 闸互不
 * 相查），生成完成的 atomicWriteFile 覆盖写此前把手改静默丢失（这些域无版本链）。
 * 修复后覆盖前经 draft 侧 snapshotBeforeOverwrite 把旧内容写进
 * 工作区/.版本/<docId>/<ULID>.md。留底失败分诊见文末 P2-2 段（onboard 两面 fail-closed；
 * outline 不在本批射程，仍 fail-open 不阻断主流程）。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { log } from '../../../src/log/index.js'

const BOOK = '生成快照书'
const ONBOARD_OLD = '# 作者手改版总纲\n\n主角第三章已死，AI 别再写活他。'
const OUTLINE_OLD = '# 作者手改版细纲\n\n本章改成双线并行，别按旧纲写。'
let studio: StudioHarness

/** 递归收集目录下全部文件绝对路径 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

beforeAll(async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'clw-gen-snapshot-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-gen-snapshot-',
    dirs: ['大纲', '工作区', '写作/正文'],
    // 模拟「生成期间作者已手改落盘」的现场（两域目标文件各一）
    files: [
      { rel: '大纲/总纲.md', content: ONBOARD_OLD },
      { rel: '工作区/细纲.md', content: OUTLINE_OLD },
    ],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 生成快照书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    userDataPath,
    env: { CLWRITING_DRIVER: 'mock' },
  })
})

afterAll(() => studio.close())

describe('R71-9: onboard-ai 覆盖既有文件前快照留底', () => {
  it('AI 产出覆盖前 → .版本 内生成含旧内容的快照 + 响应 snapshotted 留痕', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    expect(listFiles(versionsDir)).toHaveLength(0) // 前置：无版本链

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean; content: string }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBe(true) // 响应留痕

    // 快照存在且内容 = 作者手改的旧内容（mock 产出与之必然不同）
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(0)
    const snapContents = snaps.map((p) => readFileSync(p, 'utf8'))
    expect(snapContents.some((c) => c.includes(ONBOARD_OLD))).toBe(true)

    // 主流程不受影响：目标文件被 AI 产出覆盖
    const after = readFileSync(join(studio.bookRoot, '大纲', '总纲.md'), 'utf8')
    expect(after).toBe(body.content)
    expect(after).not.toContain(ONBOARD_OLD)
  })

  it('目标文件不存在（首次生成）→ 无快照、snapshotted 缺省', async () => {
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'characters' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBeUndefined()
    expect(existsSync(join(studio.bookRoot, '设定', '名册.md'))).toBe(true)
  })
})

// ── R26-59（二十六轮）：onboard-save 覆盖写前快照留底回归 ──────
// onboard-save 直接 atomicWriteFile 覆盖目标文件，作者对既有文件的手改此前无版本链；
// 修复后与 onboard-ai（R71-9）同口径接入 snapshotBeforeOverwrite（留底失败分诊见文末 P2-2 段）。

describe('R26-59: onboard-save 覆盖既有文件前快照留底', () => {
  it('覆盖已有文件 → .版本 新增含旧内容的快照 + 响应 snapshotted 留痕', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    const count = (dir: string): number => listFiles(dir).length
    const before = count(versionsDir)
    // 前置：世界观.md 尚不存在——先用 onboard-save 创建，再覆盖
    const create = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'world',
      content: '作者手写的世界观底稿',
    })
    expect(create.status).toBe(200)
    expect((create.json as { snapshotted?: boolean }).snapshotted).toBeUndefined() // 首次创建不触发
    expect(count(versionsDir)).toBe(before)

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'world',
      content: '保存按钮覆盖后的世界观',
    })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean; snapshotted?: boolean }).snapshotted).toBe(true) // 响应留痕

    // 快照存在且内容 = 覆盖前的旧内容
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(before)
    expect(snaps.some((p) => readFileSync(p, 'utf8').includes('作者手写的世界观底稿'))).toBe(true)
    // 主流程不受影响：新内容落盘
    expect(readFileSync(join(studio.bookRoot, '设定', '世界观.md'), 'utf8')).toBe('保存按钮覆盖后的世界观')
  })
})

// ── R74-4（二十二轮）：outline 覆盖前快照留底（对齐 R71-9 onboard 先例）──────
// 修复后落盘前 snapshotBeforeOverwrite 留底（标签 outline-overwrite → 快照 fm
// 「来源:」行），fail-open：快照失败不阻断主流程（log.warn 留痕）。

describe('R74-4: outline 覆盖既有 细纲.md 前快照留底', () => {
  it('AI 产出覆盖前 → .版本 内生成含旧内容、标签 outline-overwrite 的快照', async () => {
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean }
    expect(body.ok).toBe(true)

    // 快照存在且内容 = 作者手改的旧内容；标签经 fm「来源:」行可回溯（mock 产出必不相同）
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(0)
    const hit = snaps.map((p) => readFileSync(p, 'utf8')).find((c) => c.includes(OUTLINE_OLD))
    expect(hit).toBeDefined()
    expect(hit).toContain('来源: outline-overwrite')

    // 主流程不受影响：细纲被 AI 产出覆盖（fm 前置章号 + mock 文本）
    const after = readFileSync(join(studio.bookRoot, '工作区', '细纲.md'), 'utf8')
    expect(after).toContain('章号: 1')
    expect(after).toContain('mock 细纲')
    expect(after).not.toContain(OUTLINE_OLD)
  })

  it('细纲不存在（首次生成）→ 无快照（留底只在覆盖既有文件时发生）', async () => {
    rmSync(join(studio.bookRoot, '工作区', '细纲.md'))
    const versionsDir = join(studio.bookRoot, '工作区', '.版本')
    const before = listFiles(versionsDir).length
    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 2 })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(existsSync(join(studio.bookRoot, '工作区', '细纲.md'))).toBe(true)
    expect(listFiles(versionsDir)).toHaveLength(before) // 首次生成零留底
  })
})

// ── 评审-2026-10-11 §2.3 P2-2：onboard 两面覆盖留底失败 fail-closed ──────────
// 修复前两处 catch 一律 fail-open 照常落盘：非 UTF-8 存量书稿（GBK/Big5 旧稿 = 中文
// 网文现实高频形态）被 AI 产出/表单值覆盖，而留底自身是含 U+FFFD 的失真快照——原字节
// 不可恢复且返 200 假成功。修复后对齐 files.ts PUT /file 先例（同函数、同分诊）：
// NonUtf8TargetError → 400 NOT_UTF8_TARGET + 转码指引；其余留底 IO 失败 → 409
// WRITE_ERROR（未覆盖原稿，可重试）。
// 「无需留底」两态（目标不存在=首次创建 / 新旧内容相同）不设闸、照常放行——前态由上方
// R71-9 次例与 R26-59 首例钉住，后态由文末「内容相同」用例钉住（闸不得误伤幂等保存）。

/** GBK「你好」——合法 GBK 双字、非法 UTF-8 字节序列（isUtf8Bytes 判 false） */
const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])

describe('评审-2026-10-11 P2-2: onboard 覆盖留底失败 fail-closed（拒写，原稿未动）', () => {
  // beforeAll 后才可读 studio.bookRoot（describe 体在收集期即执行，直取会取到 undefined）
  const versionsDir = (): string => join(studio.bookRoot, '工作区', '.版本')

  it('onboard-ai 覆盖非 UTF-8 存量 → 400 NOT_UTF8_TARGET：产出不落盘、原字节逐位不变、零留底', async () => {
    const abs = join(studio.bookRoot, '文风', '金句库.md')
    const gbk = Buffer.concat([Buffer.from('# 作者手改的金句库\n', 'utf8'), GBK_HELLO, Buffer.from('\n', 'utf8')])
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, gbk)
    const before = listFiles(versionsDir()).length

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'style-quotes' })
    expect(r.status).toBe(400)
    const env = r.json as { code?: string; error?: string }
    expect(env.code).toBe('NOT_UTF8_TARGET')
    expect(env.error).toContain('未覆盖，原稿未动')
    expect(env.error).toContain('转码为 UTF-8') // 转码指引透传（NonUtf8TargetError.message 单源）
    // 修复前：fail-open 吞掉拒绝后照写 AI 产出并返 200——原稿唯一副本被摧毁
    expect(readFileSync(abs)).toEqual(gbk)
    expect(listFiles(versionsDir())).toHaveLength(before) // 拒绝先于写版本：零半程态
  })

  it('onboard-save 覆盖非 UTF-8 存量 → 400 NOT_UTF8_TARGET：未覆盖、原字节逐位不变', async () => {
    const abs = join(studio.bookRoot, '大纲', '账本种子.md')
    const gbk = Buffer.concat([Buffer.from('# 作者手改的账本种子\n', 'utf8'), GBK_HELLO, Buffer.from('\n', 'utf8')])
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, gbk)
    const before = listFiles(versionsDir()).length

    const r = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'leads-seed',
      content: '作者在编辑器里改后的账本种子',
    })
    expect(r.status).toBe(400)
    const env = r.json as { code?: string; error?: string }
    expect(env.code).toBe('NOT_UTF8_TARGET')
    expect(env.error).toContain('未覆盖，原稿未动')
    expect(readFileSync(abs)).toEqual(gbk)
    expect(listFiles(versionsDir())).toHaveLength(before)
  })

  it('留底 IO 失败（.版本 被占位成同名文件）→ 两处均 409 WRITE_ERROR 拒写 + warn 留痕', async () => {
    // 前置：两目标为 UTF-8 存量且内容与待写不同（否则落「内容相同」免留底态而放行）
    const relSave = join('文风', '文风铁律.md')
    const relAi = join('大纲', '卷纲', '卷纲_第1卷.md')
    for (const rel of [relSave, relAi]) {
      const abs = join(studio.bookRoot, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, '作者手写的底稿（与待写内容必不相同）。\n')
    }
    // 令留底写入的 mkdir 确定性失败（ENOTDIR）——模拟留底持续 IO 故障
    rmSync(versionsDir(), { recursive: true, force: true })
    writeFileSync(versionsDir(), 'blocked')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const save = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
        step: 'style-rules',
        content: '作者在编辑器里改后的文风铁律',
      })
      expect(save.status).toBe(409)
      const saveEnv = save.json as { code?: string; error?: string }
      expect(saveEnv.code).toBe('WRITE_ERROR')
      expect(saveEnv.error).toContain('未覆盖原稿')
      expect(saveEnv.error).toContain('可重试')

      const ai = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'volume' })
      expect(ai.status).toBe(409)
      expect((ai.json as { code?: string }).code).toBe('WRITE_ERROR')
      expect((ai.json as { error?: string }).error).toContain('未覆盖原稿')

      // 盘面零改动：两份原稿逐字节原样（修复前 AI 产出/表单值照写覆盖）
      expect(readFileSync(join(studio.bookRoot, relSave), 'utf8')).toBe('作者手写的底稿（与待写内容必不相同）。\n')
      expect(readFileSync(join(studio.bookRoot, relAi), 'utf8')).toBe('作者手写的底稿（与待写内容必不相同）。\n')
      // 留痕（诊断可定位）
      const hit = warnSpy.mock.calls.find((c) => String(c[1]).includes('fail-closed 拒绝写盘'))
      expect(hit, 'log.warn 应收到留底失败留痕').toBeTruthy()
      expect(hit![0]).toBe('api')
    } finally {
      warnSpy.mockRestore()
      rmSync(versionsDir(), { force: true })
      mkdirSync(versionsDir(), { recursive: true }) // 复原目录（后续用例/收尾依赖）
    }
  })

  it('新旧内容相同（无覆盖面）→ 免留底照常 200：闸不误伤幂等保存', async () => {
    const abs = join(studio.bookRoot, '大纲', '首章细纲.md')
    const body = '作者不改内容，原样再存一次。'
    const first = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'first-outline',
      content: body,
    })
    expect(first.status).toBe(200)
    expect((first.json as { snapshotted?: boolean }).snapshotted).toBeUndefined() // 首次创建：无留底面
    const before = listFiles(versionsDir()).length

    const again = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'first-outline',
      content: body,
    })
    expect(again.status).toBe(200)
    expect((again.json as { ok?: boolean }).ok).toBe(true)
    expect((again.json as { snapshotted?: boolean }).snapshotted).toBeUndefined() // 内容相同：无需留底
    expect(readFileSync(abs, 'utf8')).toBe(body)
    expect(listFiles(versionsDir())).toHaveLength(before)
  })
})

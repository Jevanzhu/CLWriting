/**
 * 重评-0912-4 P1-1（2026-09-12 全量重评修复批）回归：PUT /file 覆盖前快照 catch 分诊。
 *
 * 修复前：快照 catch 把**全部**留底失败一并 fail-open 吞掉继续覆盖写——其中 R66-1 非
 * UTF-8 确定性拒绝被吞 = GBK/Big5 存量书（中文网文旧稿现实高频形态）在编辑器保存即
 * 无快照覆盖丢原稿且返 200（本轮评审唯一 P1）。修复后：
 * - NonUtf8TargetError → 400 NOT_UTF8_TARGET + 转码指引，盘上字节不动；
 * - 其余留底 IO 失败 → 409 WRITE_ERROR（未执行保存，可重试）——对齐同函数在 saveDraft
 *   侧 Y-3 的现行口径「留底失败上抛拒绝覆写」；
 * GET 侧同批补编码探测（encodingSuspect/encodingHint），闭合「乱码零披露」打开面。
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '编码防线测试书'
/** GBK「你好」——合法 GBK 双字、非法 UTF-8 字节序列（isUtf8Bytes 判 false） */
const GBK = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-4-utf8-',
    dirs: ['设定'],
    files: [{ rel: '设定/总纲.md', content: '合法 UTF-8 内容' }],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 编码防线测试书\n  genre: 玄幻\nhost: cc\n',
  })
  // 播种 GBK 存量文件（bootStudio files 只收字符串，非 UTF-8 字节直写）
  writeFileSync(join(studio.bookRoot, '设定', '旧稿.md'), GBK)
})

afterAll(() => studio.close())

describe('重评-0912-4 P1-1: PUT /file 非 UTF-8 覆写防线 fail-closed', () => {
  const gbkPath = `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/旧稿.md')}`

  it('GET → encodingSuspect + encodingHint（乱码打开面不再零披露）', async () => {
    const r = await studio.req('GET', gbkPath)
    expect(r.status).toBe(200)
    const j = r.json as { encodingSuspect?: boolean; encodingHint?: string; content: string }
    expect(j.encodingSuspect).toBe(true)
    expect(j.encodingHint).toContain('UTF-8')
    expect(j.content).toContain('\uFFFD') // 解码失真如实呈现（编辑器可见乱码）
  })

  it('PUT 覆盖 GBK 存量 → 400 NOT_UTF8_TARGET，盘上字节逐位原样（原稿不丢）', async () => {
    const r = await studio.req('PUT', gbkPath, { content: '编辑器里的乱码改稿' })
    expect(r.status).toBe(400)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('NOT_UTF8_TARGET')
    expect(j.error).toContain('转码为 UTF-8') // 转码指引文案透传
    // 修复前此处被 fail-open 覆盖成 UTF-8 新内容且返 200——原稿唯一副本被摧毁
    expect(readFileSync(join(studio.bookRoot, '设定', '旧稿.md'))).toEqual(GBK)
  })

  it('覆盖后留底目录零新增（拒绝保存不产生半程态）', async () => {
    // 快照在 R66-1 校验点抛出，先于任何 writeVersion/atomicWrite——无版本目录即证
    expect(readFileSync(join(studio.bookRoot, '设定', '旧稿.md'))).toEqual(GBK)
  })

  it('GET 合法 UTF-8 文件 → 无编码告警字段（探测不误报）', async () => {
    const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/总纲.md')}`)
    expect(r.status).toBe(200)
    const j = r.json as { encodingSuspect?: boolean }
    expect(j.encodingSuspect).toBeFalsy()
  })

  it('PUT 合法 UTF-8 文件 → 200 正常保存（防线不误伤主流程）', async () => {
    const r = await studio.req('PUT', `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/总纲.md')}`, { content: '新总纲内容' })
    expect(r.status).toBe(200)
    expect(readFileSync(join(studio.bookRoot, '设定', '总纲.md'), 'utf-8')).toBe('新总纲内容')
  })
})

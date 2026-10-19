/**
 * 阶段 55：便携包解压（`src/update/extract`）——真 zip + 真落盘。
 *
 * 夹具自造 zip（`buildZip`）：本模块的输入是**远端包**，测试要造的正是常规写入器不愿
 * 造的形态——deflate 条目、越界条目名、符号链接条目——故夹具独立于诊断包写入器。
 *
 * 判据锚在盘面：合规包逐条目落盘；任何越界/链接条目 → 抛错，且**目标目录之外零写入**。
 */
import { crc32, deflateRawSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDirTracked } from '../helpers/temp-dir.js'
import { extractZipTo, resolveEntryPath } from '../../src/update/extract.js'

interface FixtureEntry {
  name: string
  /** 条目内容（符号链接条目 = 链接目标文本） */
  data: string
  /** true = deflate（method 8），缺省 store（method 0） */
  deflate?: boolean
  /** unix 模式位（落 externalFileAttributes 高 16 位；缺省常规文件 0o644） */
  unixMode?: number
}

/** 单卷 zip 写入器（本地段 + 中央目录 + EOCD；名字一律 UTF-8 标志位） */
function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const raw = Buffer.from(e.data, 'utf-8')
    const stored = e.deflate ? deflateRawSync(raw) : raw
    const method = e.deflate ? 8 : 0
    const crc = crc32(raw) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, stored)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // 宿主 UNIX → 模式位可信
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + stored.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

function scene(): { root: string; dest: string; zipOf: (entries: FixtureEntry[]) => string } {
  const root = tempDirTracked('clw-extract-')
  const dest = join(root, 'dest')
  return {
    root,
    dest,
    zipOf: (entries) => {
      const p = join(root, `包-${Math.random().toString(36).slice(2)}.zip`)
      writeFileSync(p, buildZip(entries))
      return p
    },
  }
}

describe('resolveEntryPath（条目名 → 目标内绝对路径）', () => {
  it('常规/子目录名放行；越界、盘符、空名、NUL 拒绝', () => {
    const dest = '/tmp/clw-extract-x'
    // 实现按 resolve(destDir) 锚定根且返回绝对路径——期望值同口径派生，不写死平台形态
    //（win 真机实测：join('/tmp',…) 不带盘符、resolve 会归到 cwd 所在盘，两者不同形）
    const rooted = resolve(dest)
    expect(resolveEntryPath(dest, 'CLWriting.exe')).toBe(join(rooted, 'CLWriting.exe'))
    expect(resolveEntryPath(dest, 'resources/app.asar')).toBe(join(rooted, 'resources/app.asar'))
    expect(resolveEntryPath(dest, 'resources\\app.asar')).toBe(join(rooted, 'resources/app.asar'))
    expect(resolveEntryPath(dest, './a/./b.txt')).toBe(join(rooted, 'a/b.txt'))
    expect(resolveEntryPath(dest, '../evil.txt')).toBeNull()
    expect(resolveEntryPath(dest, 'a/../../evil.txt')).toBeNull()
    expect(resolveEntryPath(dest, '..\\evil.txt')).toBeNull()
    expect(resolveEntryPath(dest, 'C:/Windows/evil.txt')).toBeNull()
    expect(resolveEntryPath(dest, '')).toBeNull()
    expect(resolveEntryPath(dest, '/')).toBeNull()
    expect(resolveEntryPath(dest, 'a\0b.txt')).toBeNull()
  })

  it('段级 Windows 形态不可用 → 拒（保留设备名 / 尾点尾空格 / 数据流 / 非法字符）', () => {
    const dest = '/tmp/clw-extract-y'
    // 保留设备名：写的是设备不是文件
    for (const name of ['NUL', 'CON', 'COM1', 'resources/AUX.txt', 'nul.txt', 'CLOCK$']) {
      expect(resolveEntryPath(dest, name), `保留名应被拒：${name}`).toBeNull()
    }
    // 尾点/尾空格：win 落盘被静默归一，与既有名撞名（判据锚在**段尾**，故 `x .txt` 不算
    // ——它的尾空格在扩展名之前，落盘名与声明名一致，无歧义）
    for (const name of ['name.', 'name ', 'resources/dir./x.txt', 'x.txt ']) {
      expect(resolveEntryPath(dest, name), `尾点尾空格应被拒：${JSON.stringify(name)}`).toBeNull()
    }
    // `:` = NTFS 备用数据流（盘上看不见）
    for (const name of ['a.txt:stream', 'resources/b.md:$DATA']) {
      expect(resolveEntryPath(dest, name), `数据流应被拒：${name}`).toBeNull()
    }
    // Windows 非法文件名字符
    for (const name of ['a*b.txt', 'a?b.txt', 'a"b.txt', 'a<b.txt', 'a|b.txt']) {
      expect(resolveEntryPath(dest, name), `非法字符应被拒：${name}`).toBeNull()
    }
    // 对照：常规名与含点的常规扩展名不受影响
    expect(resolveEntryPath(dest, 'resources/app.asar')).not.toBeNull()
    expect(resolveEntryPath(dest, 'CLWriting.exe')).not.toBeNull()
    expect(resolveEntryPath(dest, 'a.b.c.txt')).not.toBeNull()
  })
})

describe('extractZipTo（解压主流程）', () => {
  it('store 与 deflate 条目均落盘，目录条目建目录（含嵌套父目录）', async () => {
    const s = scene()
    const zip = s.zipOf([
      { name: 'CLWriting.exe', data: 'new-exe' },
      { name: 'resources/', data: '' },
      { name: 'resources/app.asar', data: 'x'.repeat(4096), deflate: true },
      { name: 'resources/locales/zh-CN.json', data: '{"a":1}', deflate: true },
    ])
    await extractZipTo(zip, s.dest)
    expect(readFileSync(join(s.dest, 'CLWriting.exe'), 'utf-8')).toBe('new-exe')
    expect(readFileSync(join(s.dest, 'resources/app.asar'), 'utf-8')).toBe('x'.repeat(4096))
    expect(readFileSync(join(s.dest, 'resources/locales/zh-CN.json'), 'utf-8')).toBe('{"a":1}')
  })

  it('越界条目（`../` 与反斜杠形态）→ 抛错，目标目录之外零写入', async () => {
    for (const name of ['../evil.txt', 'a/../../evil.txt', '..\\evil.txt', 'C:/evil.txt']) {
      const s = scene()
      const zip = s.zipOf([
        { name: 'ok.txt', data: 'fine' },
        { name, data: 'pwned' },
      ])
      // 两层防线任一拦住即可：yauzl 的条目名校验或本模块的路径判定——判据是「拒绝 +
      // 越界位零写入」，不锚具体层也不锚库侧文案（库侧报错措辞随版本走）
      await expect(extractZipTo(zip, s.dest)).rejects.toThrow()
      // 越界位：根目录下除夹具自身外不得出现 evil.txt
      expect(existsSync(join(s.root, 'evil.txt'))).toBe(false)
    }
  })

  it('符号链接条目 → 抛错（不跟随链接写盘）', async () => {
    const s = scene()
    const zip = s.zipOf([{ name: 'link', data: '/etc/passwd', unixMode: 0o120777 }])
    await expect(extractZipTo(zip, s.dest)).rejects.toThrow(/符号链接/)
    expect(existsSync(join(s.dest, 'link'))).toBe(false)
  })

  it('非常规文件类型（命名管道）→ 抛错；加密条目出不了解压流（yauzl 层拒绝）', async () => {
    const s = scene()
    const zip = s.zipOf([{ name: 'pipe', data: '', unixMode: 0o010644 }])
    await expect(extractZipTo(zip, s.dest)).rejects.toThrow(/不是常规文件/)
    expect(existsSync(join(s.dest, 'pipe'))).toBe(false)
  })

  it('宿主非 UNIX 造的包（无模式位）按常规文件处理', async () => {
    const s = scene()
    // versionMadeBy 宿主改 0（MS-DOS），模式位不可信 → 仍应放行
    const zip = s.zipOf([{ name: 'CLWriting.exe', data: 'new-exe' }])
    const raw = readFileSync(zip)
    const centralAt = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    raw.writeUInt16LE(20, centralAt + 4)
    writeFileSync(zip, raw)
    await extractZipTo(zip, s.dest)
    expect(readFileSync(join(s.dest, 'CLWriting.exe'), 'utf-8')).toBe('new-exe')
  })

  it('残包（截断）→ 抛错（不给半成品假绿灯）', async () => {
    const s = scene()
    const zip = s.zipOf([
      { name: 'CLWriting.exe', data: 'new-exe' },
      { name: 'resources/app.asar', data: 'x'.repeat(2048), deflate: true },
    ])
    const raw = readFileSync(zip)
    writeFileSync(zip, raw.subarray(0, Math.floor(raw.length / 2)))
    await expect(extractZipTo(zip, s.dest)).rejects.toThrow()
  })
})

describe('extractZipTo 上限（解压炸弹面：包是远端输入，条目数与总字节都有红线）', () => {
  it('条目数超上限 → 抛错，超限条目零写入', async () => {
    const s = scene()
    const zip = s.zipOf([
      { name: 'a.txt', data: 'a' },
      { name: 'b.txt', data: 'b' },
      { name: 'c.txt', data: 'c' },
    ])
    await expect(extractZipTo(zip, s.dest, { maxEntries: 2 })).rejects.toThrow(/条目数/)
    expect(existsSync(join(s.dest, 'c.txt'))).toBe(false)
  })

  it('解压总字节超上限 → 抛错（按声明解压尺寸累计，超限条目落盘前拦下）', async () => {
    const s = scene()
    const zip = s.zipOf([
      { name: 'a.bin', data: 'a'.repeat(100) },
      { name: 'b.bin', data: 'b'.repeat(100) },
    ])
    await expect(extractZipTo(zip, s.dest, { maxTotalBytes: 150 })).rejects.toThrow(/总字节/)
    expect(existsSync(join(s.dest, 'b.bin'))).toBe(false)
  })

  it('调用方限额只能收紧：超出绝对上限的入参被压回红线', async () => {
    const { EXTRACT_MAX_TOTAL_BYTES, resolveExtractLimits } = await import('../../src/update/extract.js')
    expect(resolveExtractLimits({ maxTotalBytes: EXTRACT_MAX_TOTAL_BYTES * 2 }).maxTotalBytes).toBe(
      EXTRACT_MAX_TOTAL_BYTES,
    )
    expect(resolveExtractLimits({ maxEntries: 3 }).maxEntries).toBe(3)
    expect(resolveExtractLimits().maxEntries).toBeGreaterThan(3)
  })
})

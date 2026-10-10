/**
 * 诊断包 ZIP 写入器（src/diagnostics/zip.ts）单测：
 * 结构与字段（本地头 = 中央目录、偏移自洽）、UTF-8 条目名标志位、store 模式、
 * CRC 与自带实现互验、空归档可解析、超限 fail-loud。
 */
import { describe, it, expect } from 'vitest'
import { crc32 } from 'node:zlib'
import { buildZipStore } from '../../src/diagnostics/zip.js'
import { readZipStore, crc32Independent } from '../helpers/zip-read.js'

describe('诊断包 ZIP（store 模式手写写入器）', () => {
  it('多条目（含中文名/目录名）写出后可被独立读取器完整解析：名/数据/CRC 三者一致', () => {
    const zip = buildZipStore([
      { name: '说明.txt', data: 'CLWriting 诊断包\n' },
      { name: '环境.json', data: '{"平台":"win32"}' },
      { name: '日志/app-20261010.jsonl', data: '{"msg":"雪落在了城墙上。"}\n' },
    ])
    const entries = readZipStore(zip)
    expect(entries.map((e) => e.name)).toEqual(['说明.txt', '环境.json', '日志/app-20261010.jsonl'])
    expect(entries[0]!.data.toString('utf-8')).toBe('CLWriting 诊断包\n')
    // 中文名 UTF-8 往返无损（读取器按 UTF-8 解码，错位即名不符）
    expect(entries[2]!.data.toString('utf-8')).toContain('雪落在了城墙上')
    // CRC 与独立实现一致（非同一实现自证）
    for (const e of entries) expect(e.crc).toBe(crc32Independent(e.data))
  })

  it('CRC 取 zlib.crc32 值（与 Node 标准实现同源，非自造多项式）', () => {
    const data = Buffer.from('abc', 'utf-8')
    const zip = buildZipStore([{ name: 'a.txt', data }])
    expect(readZipStore(zip)[0]!.crc).toBe(crc32(data))
    expect(crc32(data)).toBe(0x352441c2) // 标准校验值（"abc" 的 CRC-32）
  })

  it('UTF-8 标志位与 store 模式逐条目就位（读取器对 flags/method 是硬判）', () => {
    const zip = buildZipStore([{ name: '日志/app-20261010.jsonl', data: 'x' }])
    const e = readZipStore(zip)[0]!
    expect(e.flags).toBe(0x0800)
    expect(e.method).toBe(0)
    expect(e.size).toBe(1)
    expect(e.data.length).toBe(1)
  })

  it('空归档（零条目）是合法 ZIP（EOCD 自洽，读取器零条目返回）', () => {
    const zip = buildZipStore([])
    expect(readZipStore(zip)).toEqual([])
  })

  it('条目数超 65535 → 抛出（zip64 未实现，fail-loud 不产坏包）', () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: '' }))
    expect(() => buildZipStore(many)).toThrow(/zip64/)
  })

  it('mtime 注入 → DOS 时间/日期取注入值（本地时区字段自洽，不校验具体编码）', () => {
    const at = new Date(2026, 9, 10, 12, 30, 40) // 2026-10-10 12:30:40 本地时
    const zip = buildZipStore([{ name: 'a.txt', data: 'x' }], { mtime: at })
    const local = zip.readUInt32LE(0)
    expect(local).toBe(0x04034b50)
    const time = zip.readUInt16LE(10)
    const date = zip.readUInt16LE(12)
    expect(time >> 11).toBe(12) // 时
    expect((time >> 5) & 0x3f).toBe(30) // 分
    expect(time & 0x1f).toBe(40 >> 1) // 秒（2 秒粒度）
    expect(((date >> 9) & 0x7f) + 1980).toBe(2026)
    expect((date >> 5) & 0x0f).toBe(10) // 月
    expect(date & 0x1f).toBe(10) // 日
  })
})

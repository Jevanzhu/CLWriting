/**
 * P1 回归（win 分支合并后全量复审实锤）：版本目录读写分裂。
 *
 * `resolveDocVersionsDir` 旧口径「读优先字面目录、写恒编码目录」——mac 存量库
 * `legacy:xxx` 字面目录已存在时（旧代码直接用 docId 建目录，`:` 在 POSIX 合法），
 * 新写的版本落编码目录而 listVersions/readVersion/readVersionMeta/pruneVersions
 * 仍解析字面目录：新版本永久不可见，prune 只扫字面侧照常清旧版本。
 *
 * 修复口径：读侧对字面 + 编码两目录取并集（单版本读取双目录回退），写入恒落
 * 编码目录（win 可建）不变；prune 按 listVersions 的 s.path 删除，自动覆盖两目录。
 * 字面目录场景仅 mac/Linux 可造（win 上 `:` 目录非法），按仓库惯例 skipIf(win32)。
 */
import { mkdirSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_VERSION_POLICY,
  encodeDocDirName,
  listVersions,
  pruneVersions,
  readVersion,
  readVersionMeta,
  writeVersion,
} from '../../src/document/version.js'
import { ulid } from '../../src/document/stable-id.js'

let root = ''
let versionsDir = ''
const DOC_ID = 'legacy:0123456789abcdef'
const OLD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV' // 2018 年时间戳的合法 ULID（超 maxDays 14 天期）

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-verdir-'))
  versionsDir = join(root, '工作区', '.版本')
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function seedVersionFile(dirDocId: string, id: string, content: string): void {
  mkdirSync(join(versionsDir, dirDocId), { recursive: true })
  writeFileSync(
    join(versionsDir, dirDocId, `${id}.md`),
    `---\n版本ID: ${id}\n时间: 2018-05-01T00:00:00.000Z\n来源: autosave\n---\n${content}`,
    'utf8',
  )
}

describe('P1：字面目录 + 编码写入的读写分裂修复', () => {
  // 字面冒号目录仅在 POSIX 可建（win 上 mkdir 即失败），win 跳过、mac/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')(
    '存量字面目录（新鲜版本）→ 再写新版本对 list/read/readMeta 全可见（修复前 listVersions 只见字面侧）',
    () => {
      // 种子用当前 ULID：writeVersion 末尾自带 prune，2018 老种子会被超期清掉干扰断言
      const seededId = ulid()
      seedVersionFile(DOC_ID, seededId, '字面侧旧版本内容')
      const newId = writeVersion(versionsDir, DOC_ID, '新版本内容', { origin: 'autosave' })
      expect(newId).not.toBeNull()

      // 新旧两版本都在列表（种子在字面目录、新写在编码目录）
      const list = listVersions(versionsDir, DOC_ID)
      expect(list.map((v) => v.id)).toEqual([newId, seededId])

      const rv = readVersion(versionsDir, DOC_ID, newId!)
      expect(rv?.content).toBe('新版本内容')
      const rm = readVersionMeta(versionsDir, DOC_ID, newId!)
      expect(rm?.meta.origin).toBe('autosave')
      // 字面侧种子同样可读（readVersion 双目录回退的另一方向）
      expect(readVersion(versionsDir, DOC_ID, seededId)?.content).toBe('字面侧旧版本内容')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'prune 走并集：字面目录超期版本被清、编码目录新鲜版本保留（修复前只扫字面侧）',
    () => {
      // 双侧手工置文件后直调 pruneVersions（绕开 writeVersion 末尾的自带 prune）
      seedVersionFile(DOC_ID, OLD_ID, '字面侧超期版本')
      const freshId = ulid()
      seedVersionFile(encodeDocDirName(DOC_ID), freshId, '编码侧新鲜版本')

      const removed = pruneVersions(versionsDir, DOC_ID, DEFAULT_VERSION_POLICY)
      // 字面侧 2018 版本超 14 天期被清；编码侧刚生成不可能被清
      expect(removed).toBe(1)
      expect(listVersions(versionsDir, DOC_ID).map((v) => v.id)).toEqual([freshId])
      expect(existsSync(join(versionsDir, encodeDocDirName(DOC_ID), `${freshId}.md`))).toBe(true)
      expect(existsSync(join(versionsDir, DOC_ID, `${OLD_ID}.md`))).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')('同 id 双目录双份 → 列表去重（字面优先）', () => {
    seedVersionFile(DOC_ID, OLD_ID, '双份内容')
    seedVersionFile(encodeDocDirName(DOC_ID), OLD_ID, '双份内容')
    const list = listVersions(versionsDir, DOC_ID)
    expect(list.filter((v) => v.id === OLD_ID)).toHaveLength(1)
    expect(list[0]!.path).toContain(DOC_ID) // 字面目录优先（docVersionDirs 顺序）
  })

  // 无字面目录 = win 实际运行形态，跨平台直跑（win 上等价于唯一路径）
  it('纯净库（无字面目录）→ 写入落编码目录、读取同目录，字面目录永不创建', () => {
    const newId = writeVersion(versionsDir, DOC_ID, '全新内容', { origin: 'autosave' })
    expect(newId).not.toBeNull()
    // 含冒号 docId：字面目录与编码目录路径不同，断言字面侧从未被创建
    expect(existsSync(join(versionsDir, DOC_ID))).toBe(false)
    expect(readdirSync(join(versionsDir, encodeDocDirName(DOC_ID)))).toEqual([`${newId}.md`])
    expect(readVersion(versionsDir, DOC_ID, newId!)?.content).toBe('全新内容')
    expect(listVersions(versionsDir, DOC_ID)).toHaveLength(1)
  })
})

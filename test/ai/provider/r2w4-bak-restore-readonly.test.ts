/**
 * R2W-4（win 平台专项复审 R2）：providers.json 备份恢复不再用 copyFileSync 覆盖写。
 *
 * 夹具：主文件损坏 + 只读属性（copyFileSync 覆盖写在 win 撞只读 EPERM、posix 撞
 * EACCES——两平台修复前都恢复失败）；修复后 rmQuietly（libuv 对只读属性自动清位删除）
 * + atomicWriteFile 落盘 → 自愈成功、bak 保留、主文件恢复可解析。
 */
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProviders, saveProviders, emptySettings } from '../../../src/ai/provider/store.js'

describe('providers bak 自愈对只读主文件（R2W-4）', () => {
  it('主文件损坏且只读 → loadProviders 自愈成功（bak 字节落位、bak 保留）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-r2w4-bak-'))
    try {
      // 两笔 save：主文件在位 + 写前备份生成 providers.bak.json
      saveProviders(dir, emptySettings())
      saveProviders(dir, emptySettings())
      const fp = join(dir, 'providers.json')
      const bakFp = join(dir, 'providers.bak.json')
      expect(existsSync(bakFp)).toBe(true)

      // 主文件改坏 + 只读属性（修复前 copyFileSync 对只读目标两平台都失败）
      writeFileSync(fp, '{oops-not-json', 'utf-8')
      chmodSync(fp, 0o444)

      const loaded = loadProviders(dir)
      expect(loaded.providers).toEqual([])

      // 主文件已恢复为合法 JSON 且不再只读（后续 save 可写）
      const restored = JSON.parse(readFileSync(fp, 'utf-8'))
      expect(restored).toBeTypeOf('object')
      expect(existsSync(bakFp)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

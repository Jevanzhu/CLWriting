import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 同目录临时文件 + rename，避免 JSON/manifest 中断后留下半截目标文件。 */
export function atomicWriteFile(filePath: string, data: string | Uint8Array): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, data)
    renameSync(tmpPath, filePath)
  } catch (e) {
    rmSync(tmpPath, { force: true })
    throw e
  }
}

/**
 * 章纲.md 测试造盘夹具。
 *
 * 生产侧 writePieceList（format/manifest.ts）已改抛错占位：全量重生成写路径不保作者
 * 手写补遗/注释，接线前须先落地补丁式写路径（见该函数头注）。测试盘面只需三段结构
 * 数据、无未知段保全需求，故夹具写入口独立于此——字节与生产读侧 parsePieceListBody
 * 同源（stringifyPieceList 生成），落盘走 atomicWriteFile（与生产同款原子替换，
 * 目录自动创建）。
 */
import { atomicWriteFile } from '../../src/fs/atomic.js'
import { stringifyPieceList } from '../../src/format/piece-list-core.js'
import type { PieceList } from '../../src/format/types.js'

/** 以 stringifyPieceList 全量生成落一份章纲.md（测试夹具用，勿当生产写路径）。 */
export function writePieceListFixture(filePath: string, list: PieceList): void {
  atomicWriteFile(filePath, stringifyPieceList(list))
}

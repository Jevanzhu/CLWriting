/**
 * redactSecret 脱敏测试——凭据存储设计 §6.2 D9。
 */
import { test, expect } from 'vitest'
import { redactSecret } from '../../../src/ai/provider/redact.js'

test('redact: URL query param 凭据脱敏', () => {
  const input = '请求失败：GET https://api.x.com/v1/chat?key=sk-secret1234567890'
  const out = redactSecret(input)
  expect(out).not.toContain('sk-secret1234567890')
  expect(out).toContain('***REDACTED***')
})

test('redact: api_key / token / authorization 多种 param 名', () => {
  expect(redactSecret('?api_key=sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop')
  expect(redactSecret('?token=BearerAbcDef12345678')).not.toContain('BearerAbcDef12345678')
  expect(redactSecret('&authorization=secretvalue123456')).not.toContain('secretvalue123456')
})

test('redact: Bearer header 脱敏', () => {
  const out = redactSecret('Authorization: Bearer sk-abcdefghijklmnopqrst')
  expect(out).not.toContain('sk-abcdefghijklmnopqrst')
  expect(out).toContain('***REDACTED***')
})

test('redact: 裸 key（sk- / xai- 前缀）脱敏', () => {
  expect(redactSecret('error body: sk-secretkey1234567890')).not.toContain('sk-secretkey1234567890')
  expect(redactSecret('xai-abcdefghijklmnop')).not.toContain('xai-abcdefghijklmnop')
})

test('redact: 无害文本不误伤', () => {
  expect(redactSecret('连通失败：连接超时')).toBe('连通失败：连接超时')
  expect(redactSecret('OpenAI API 401: Invalid authentication')).toBe('OpenAI API 401: Invalid authentication')
  // 短串不误杀（< 16 字符后缀）
  expect(redactSecret('sk-short')).toBe('sk-short')
})

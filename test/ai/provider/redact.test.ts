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

test('redact: 裸 key（P3 补全常见厂商前缀）脱敏', () => {
  // sk-ant-（Anthropic）/ gsk_（Groq）/ hf_（HuggingFace）/ glpat-（GitLab PAT）/ ghp_（GitHub PAT）
  expect(redactSecret('sk-ant-api03-secretkey1234567890')).not.toContain('sk-ant-api03-secretkey1234567890')
  expect(redactSecret('gsk_secretkey1234567890ab')).not.toContain('gsk_secretkey1234567890ab')
  expect(redactSecret('hf_secretkey1234567890abcd')).not.toContain('hf_secretkey1234567890abcd')
  expect(redactSecret('glpat-secretkey1234567890ab')).not.toContain('glpat-secretkey1234567890ab')
  expect(redactSecret('ghp_secretkey1234567890abcd')).not.toContain('ghp_secretkey1234567890abcd')
  // 各前缀替换后都留 REDACTED 痕迹（确认是被脱敏而非截断）
  expect(redactSecret('key: gsk_secretkey1234567890ab')).toContain('***REDACTED***')
  expect(redactSecret('key: glpat-secretkey1234567890ab')).toContain('***REDACTED***')
  // 短串不误杀（< 16 字符后缀，同 sk-short 口径）
  expect(redactSecret('hf_short123')).toBe('hf_short123')
})

test('redact: 裸 key（R73-6 智谱 id.secret 形态）脱敏', () => {
  // 智谱：<id32 hex>.<secret32 hex>，id 与 secret 间以点分隔
  const key = '0123456789abcdef0123456789abcdef.9f8e7d6c5b4a39281706f5e4d3c2b1a0'
  expect(redactSecret(`error: ${key}`)).not.toContain(key)
  expect(redactSecret(`error: ${key}`)).toContain('***REDACTED***')
  // 非 32 hex 段（长度不足/含非 hex 字符）不误杀
  expect(redactSecret('abc123.def456')).toBe('abc123.def456')
})

test('redact: 裸 key（R73-6 Gemini AIza 前缀）脱敏', () => {
  // Google Gemini：AIza + 35 位 [A-Za-z0-9_-]（总长 39）
  const key = 'AIzaSyA1234567890abcdefghijklmnopqrstuv'
  expect(redactSecret(`error: ${key}`)).not.toContain(key)
  expect(redactSecret(`error: ${key}`)).toContain('***REDACTED***')
  // 短串（非 35 位后缀）不误杀
  expect(redactSecret('AIzaShort')).toBe('AIzaShort')
})

test('redact: 无害文本不误伤', () => {
  expect(redactSecret('连通失败：连接超时')).toBe('连通失败：连接超时')
  expect(redactSecret('OpenAI API 401: Invalid authentication')).toBe('OpenAI API 401: Invalid authentication')
  // 短串不误杀（< 16 字符后缀）
  expect(redactSecret('sk-short')).toBe('sk-short')
})

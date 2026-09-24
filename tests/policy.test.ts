import { describe, expect, test } from 'bun:test'
import {
  effortRank,
  parseToggle,
  pendingDecisions,
  readDecision,
  requestBody,
  route,
  shorten,
} from '../hooks/policy.ts'
import type { PolicyConfig } from '../hooks/policy.ts'

const config: PolicyConfig = { maxEffort: 'xhigh', minUpgradeConfidence: 0.3, minDowngradeConfidence: 0.6 }

describe('readDecision', () => {
  test('reads choice, confidence and noul', () => {
    const d = readDecision(
      JSON.stringify({ answers: { effort: { choice: 'high', confidence: 0.8 }, risky: { noul: 0.1 } } }),
    )
    expect(d).toEqual({ effort: 'high', confidence: 0.8, risky: 0.1 })
  })
  test('rejects unknown levels and junk', () => {
    expect(readDecision(JSON.stringify({ answers: { effort: { choice: 'minimal' } } }))).toBeNull()
    expect(readDecision('not json')).toBeNull()
    expect(readDecision('null')).toBeNull()
  })
})

describe('route', () => {
  const d = (effort: 'low' | 'medium' | 'high' | 'xhigh', confidence: number | null, risky: number | null = null) => ({
    effort,
    confidence,
    risky,
  })
  test('upgrades past the low bar', () => {
    expect(route(d('high', 0.4), 'low', config).effort).toBe('high')
  })
  test('downgrade needs the high bar', () => {
    expect(route(d('low', 0.5), 'high', config).effort).toBeNull()
    expect(route(d('low', 0.7), 'high', config).effort).toBe('low')
  })
  test('no confidence never downgrades', () => {
    expect(route(d('low', null), 'high', config).effort).toBeNull()
    expect(route(d('high', null), 'low', config).effort).toBe('high')
  })
  test('same level is left alone', () => {
    expect(route(d('medium', 0.9), 'medium', config).effort).toBeNull()
  })
  test('ceiling caps the choice', () => {
    expect(route(d('xhigh', 0.9), 'low', { ...config, maxEffort: 'high' }).effort).toBe('high')
  })
  test('risk forces at least high and never lowers', () => {
    expect(route(d('low', 0.99, 0.9), 'low', config).effort).toBe('high')
    expect(route(d('low', 0.99, 0.9), 'xhigh', config).effort).toBeNull()
  })
  test('max is above the ladder: a confident downgrade still applies', () => {
    expect(effortRank('max')).toBe(4)
    expect(route(d('medium', 0.9), 'max', config).effort).toBe('medium')
  })
  test('numeric effort is left alone', () => {
    expect(route(d('high', 0.9), 3, config).effort).toBeNull()
  })
})

describe('pendingDecisions', () => {
  test('two waiting prompts yield none', () => {
    const p = pendingDecisions()
    p.put({ effort: 'low', confidence: 1, risky: null })
    p.put({ effort: 'high', confidence: 1, risky: null })
    expect(p.take()).toBeNull()
  })
})

describe('shorten and body', () => {
  test('keeps head and tail within the limit', () => {
    const s = shorten('a'.repeat(3000) + 'b'.repeat(7000))
    expect(s.startsWith('a')).toBe(true)
    expect(s.endsWith('b')).toBe(true)
    expect(s.length).toBeLessThan(6010)
  })
  test('body names the model and asks effort as a choice', () => {
    const body = JSON.parse(requestBody('fix it', 'jev-latest'))
    expect(body.model).toBe('jev-latest')
    expect(body.questions.effort.type).toBe('choice')
    expect(Object.keys(body.questions.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

describe('parseToggle', () => {
  test('on, off, status, junk', () => {
    expect(parseToggle(' ON ')).toBe('on')
    expect(parseToggle('off')).toBe('off')
    expect(parseToggle('')).toBe('status')
    expect(parseToggle('maybe')).toBeNull()
  })
})

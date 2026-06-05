/**
 * src/lib/opus-ttl.test.ts
 * TDD unit tests — scritti PRIMA dell'implementazione (cost-control 5 giu 2026).
 */

import { describe, it, expect } from 'vitest'
import {
  parseOpusCommand,
  computeOpusUntil,
  isOpusExpired,
  OPUS_TTL_DEFAULT_MIN,
  OPUS_TTL_MAX_MIN,
} from './opus-ttl'

describe('parseOpusCommand', () => {
  it('returns default TTL (60) for bare /opus', () => {
    expect(parseOpusCommand('/opus')).toBe(OPUS_TTL_DEFAULT_MIN) // 60
  })

  it('returns 120 for /opus 120', () => {
    expect(parseOpusCommand('/opus 120')).toBe(120)
  })

  it('clamps to min 5 for /opus 2', () => {
    expect(parseOpusCommand('/opus 2')).toBe(5)
  })

  it('clamps to max 480 for /opus 9999', () => {
    expect(parseOpusCommand('/opus 9999')).toBe(OPUS_TTL_MAX_MIN) // 480
  })

  it('returns null for /opusx (not a valid /opus command)', () => {
    expect(parseOpusCommand('/opusx')).toBeNull()
  })

  it('returns null for "ciao /opus" (not a command prefix)', () => {
    expect(parseOpusCommand('ciao /opus')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseOpusCommand('')).toBeNull()
  })

  it('returns null for arbitrary text', () => {
    expect(parseOpusCommand('dimmi qualcosa')).toBeNull()
  })

  it('accepts /opus with trailing whitespace', () => {
    expect(parseOpusCommand('/opus   ')).toBe(60)
  })

  it('returns default TTL for /opus 0 → clamped to 5', () => {
    expect(parseOpusCommand('/opus 0')).toBe(5)
  })

  it('returns 480 for /opus 480 (at max boundary)', () => {
    expect(parseOpusCommand('/opus 480')).toBe(480)
  })

  it('returns 5 for /opus 1 (clamp min)', () => {
    expect(parseOpusCommand('/opus 1')).toBe(5)
  })
})

describe('computeOpusUntil', () => {
  it('adds correct number of minutes to a given date', () => {
    const base = new Date('2026-06-05T10:00:00.000Z')
    const result = computeOpusUntil(base, 60)
    expect(result).toBe('2026-06-05T11:00:00.000Z')
  })

  it('adds 120 minutes correctly', () => {
    const base = new Date('2026-06-05T10:00:00.000Z')
    const result = computeOpusUntil(base, 120)
    expect(result).toBe('2026-06-05T12:00:00.000Z')
  })

  it('returns an ISO string', () => {
    const base = new Date('2026-06-05T10:00:00.000Z')
    const result = computeOpusUntil(base, 30)
    expect(() => new Date(result)).not.toThrow()
    expect(new Date(result).toISOString()).toBe(result)
  })
})

describe('isOpusExpired', () => {
  const now = new Date('2026-06-05T12:00:00.000Z')

  it('returns true for null (missing opus_until)', () => {
    expect(isOpusExpired(null, now)).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(isOpusExpired(undefined, now)).toBe(true)
  })

  it('returns true for malformed string', () => {
    expect(isOpusExpired('not-a-date', now)).toBe(true)
  })

  it('returns false for a future timestamp', () => {
    const future = '2026-06-05T13:00:00.000Z' // 1h after now
    expect(isOpusExpired(future, now)).toBe(false)
  })

  it('returns true for a past timestamp', () => {
    const past = '2026-06-05T11:00:00.000Z' // 1h before now
    expect(isOpusExpired(past, now)).toBe(true)
  })

  it('returns true for exactly-equal timestamp (boundary: expired)', () => {
    const exactly = '2026-06-05T12:00:00.000Z' // same as now
    expect(isOpusExpired(exactly, now)).toBe(true)
  })

  it('handles JSON-quoted ISO string (strips double-quotes)', () => {
    // Supabase sometimes returns value with surrounding quotes
    const quoted = '"2026-06-05T13:00:00.000Z"'
    expect(isOpusExpired(quoted, now)).toBe(false)
  })

  it('handles JSON-quoted past value correctly', () => {
    const quotedPast = '"2026-06-05T11:00:00.000Z"'
    expect(isOpusExpired(quotedPast, now)).toBe(true)
  })
})

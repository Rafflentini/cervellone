import { describe, it, expect } from 'vitest'
import { isRaffica, RAFFICA_THRESHOLD, shouldSendRafficaAck } from './upload-flow'

describe('isRaffica', () => {
  it('1-3 file → NON raffica (si analizza)', () => {
    expect(isRaffica(1)).toBe(false)
    expect(isRaffica(2)).toBe(false)
    expect(isRaffica(3)).toBe(false)
  })
  it('4+ file → raffica (cataloga e basta)', () => {
    expect(isRaffica(4)).toBe(true)
    expect(isRaffica(10)).toBe(true)
    expect(isRaffica(30)).toBe(true)
  })
  it('soglia di default = 4', () => {
    expect(RAFFICA_THRESHOLD).toBe(4)
  })
  it('valori non validi → false (safe: si comporta come prima = analizza)', () => {
    expect(isRaffica(NaN)).toBe(false)
    expect(isRaffica(0)).toBe(false)
    expect(isRaffica(-5)).toBe(false)
  })
  it('soglia personalizzabile', () => {
    expect(isRaffica(3, 3)).toBe(true)
    expect(isRaffica(2, 3)).toBe(false)
  })
})

describe('shouldSendRafficaAck (throttle 30s)', () => {
  it('primo avviso → true; entro 30s → false; dopo 30s → true', () => {
    const k = 'chat-A-' + Math.random()
    const t0 = 1_000_000
    expect(shouldSendRafficaAck(k, t0)).toBe(true)
    expect(shouldSendRafficaAck(k, t0 + 5_000)).toBe(false)    // entro cooldown
    expect(shouldSendRafficaAck(k, t0 + 61_000)).toBe(true)    // oltre cooldown (60s)
  })
  it('chat diverse non interferiscono', () => {
    const t = 2_000_000
    expect(shouldSendRafficaAck('chat-X', t)).toBe(true)
    expect(shouldSendRafficaAck('chat-Y', t)).toBe(true)
  })
})

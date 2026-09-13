import { afterEach, describe, expect, it, vi } from 'vitest'
import { interruttoreAcceso } from './interruttori'
import { opzioniToolDaAmbiente } from './claude'
import { mappaOfficina } from './mappa-officina'
import { decolloAcceso } from './tools/delega-tools'

/**
 * 🚨 Trovato il 13 set 2026: su Vercel `TOOL_DEFER` valeva "1\n" — un a capo
 * incollato insieme al valore. Il codice confrontava `=== '1'`, quindi la
 * Strada C sembrava accesa ed era spenta. Un interruttore che mente.
 */
const NOMI = ['TOOL_DEFER', 'DECOLLO'] as const

afterEach(() => {
  for (const n of NOMI) delete process.env[n]
  vi.restoreAllMocks()
})

describe('interruttoreAcceso', () => {
  it('acceso con "1"', () => {
    process.env.TOOL_DEFER = '1'
    expect(interruttoreAcceso('TOOL_DEFER')).toBe(true)
  })

  it.each(['1\n', '1\r\n', ' 1', '1 ', '\t1\t'])('acceso con %j: gli spazi incollati non spengono', (v) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.TOOL_DEFER = v
    expect(interruttoreAcceso('TOOL_DEFER')).toBe(true)
  })

  it.each([undefined, '', '0', 'true', 'si', '11', '1\n1'])('spento con %j', (v) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (v === undefined) delete process.env.TOOL_DEFER
    else process.env.TOOL_DEFER = v
    expect(interruttoreAcceso('TOOL_DEFER')).toBe(false)
  })

  it('un valore sporco ma acceso lo DICE nei log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.TOOL_DEFER = '1\n'
    interruttoreAcceso('TOOL_DEFER')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('TOOL_DEFER')
  })

  it('un valore non riconosciuto lo DICE nei log: spento, ma non in silenzio', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.DECOLLO = 'true'
    expect(interruttoreAcceso('DECOLLO')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('DECOLLO')
  })

  // Controllo positivo dei due avvisi qui sopra: i valori puliti NON avvisano.
  it.each([undefined, '', '0', '1'])('un valore pulito (%j) non avvisa', (v) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (v === undefined) delete process.env.DECOLLO
    else process.env.DECOLLO = v
    interruttoreAcceso('DECOLLO')
    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * Testare gli adattatori, non il motore: ognuno dei punti che leggono un
 * interruttore deve accendersi con il valore che c'era DAVVERO su Vercel.
 */
describe('i lettori degli interruttori accettano il valore vero di Vercel ("1\\n")', () => {
  it('opzioniToolDaAmbiente', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.TOOL_DEFER = '1\n'
    expect(opzioniToolDaAmbiente()).toBeDefined()
    delete process.env.TOOL_DEFER
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })

  it('mappaOfficina', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.TOOL_DEFER = '1\n'
    expect(mappaOfficina().length).toBeGreaterThan(0)
    delete process.env.TOOL_DEFER
    expect(mappaOfficina()).toBe('')
  })

  it('decolloAcceso', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.DECOLLO = '1\n'
    expect(decolloAcceso()).toBe(true)
    delete process.env.DECOLLO
    expect(decolloAcceso()).toBe(false)
  })
})

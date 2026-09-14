/**
 * src/lib/taglio-storia.test.ts — quanta conversazione si rispedisce.
 *
 * ⚠️ Questo taglio non aveva un solo test, e il 14 settembre 2026 è costato
 * tre «budget di elaborazione superato» di fila all'Ingegnere. La telemetria
 * ha detto cos'era: UNA iterazione, ZERO tool, **933.975 token spediti**. La
 * chat web tagliava, Telegram aveva un taglio suo che si fermava a «più di 8
 * messaggi» — e otto messaggi con dentro 34 fatture e sei PDF restano enormi.
 */
import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { trimMessages, MAX_CONTEXT_CHARS } from './taglio-storia'

/** Un messaggio pesante quanto si vuole. */
function msg(role: 'user' | 'assistant', caratteri: number): Anthropic.MessageParam {
  return { role, content: 'x'.repeat(caratteri) }
}

function pesa(messaggi: Anthropic.MessageParam[]): number {
  return messaggi.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
}

describe('il taglio della storia', () => {
  it('🚨 una conversazione enorme viene tagliata, e non importa quanti messaggi siano', () => {
    // Il difetto di Telegram era proprio questo: un pavimento sul NUMERO di
    // messaggi. Qui ce ne sono pochi e pesantissimi — il caso che sfondava.
    const storia = [msg('user', 400_000), msg('assistant', 400_000), msg('user', 400_000), msg('assistant', 5_000)]

    const tagliata = trimMessages(storia)

    expect(tagliata.length).toBeLessThan(storia.length)
    // L'ultimo messaggio resta sempre: e' la richiesta a cui si risponde.
    expect(tagliata[tagliata.length - 1]).toBe(storia[storia.length - 1])
  })

  it('🚨 quello che è stato tolto viene DETTO, non fatto sparire', () => {
    // ⚠️ L'avviso si aggiunge SOLO quando il primo messaggio rimasto è del bot:
    // se la storia tagliata comincia già con una domanda dell'Ingegnere, non
    // c'è niente di monco da spiegare. Qui la si costruisce apposta perché il
    // taglio cada in mezzo a uno scambio.
    const storia = [msg('user', 400_000), msg('assistant', 50_000), msg('user', 50_000)]

    const tagliata = trimMessages(storia)

    expect(tagliata.length).toBe(3) // avviso + i due messaggi tenuti
    expect(JSON.stringify(tagliata[0].content)).toContain('conversazione precedente omessa')
  })

  it('CONTROLLO POSITIVO: una conversazione piccola NON viene toccata', () => {
    // Senza questo, un taglio che butta via sempre tutto passerebbe i test qui
    // sopra — e il bot perderebbe la memoria di ogni conversazione normale.
    const storia = [msg('user', 100), msg('assistant', 200), msg('user', 50)]

    expect(trimMessages(storia)).toEqual(storia)
  })

  it('CONTROLLO POSITIVO: un solo messaggio resta intero, anche se enorme', () => {
    // Tagliare la domanda a cui si sta rispondendo vorrebbe dire rispondere a
    // un'altra domanda.
    const storia = [msg('user', 900_000)]

    expect(trimMessages(storia)).toEqual(storia)
  })

  it('il risultato sta nel budget, tranne per l ultimo messaggio', () => {
    const storia = Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', 20_000))

    const tagliata = trimMessages(storia)
    const senzaUltimo = tagliata.slice(0, -1)

    expect(pesa(senzaUltimo)).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
  })
})

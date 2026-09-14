/**
 * src/lib/taglio-storia.ts — quanta conversazione si rispedisce al modello.
 *
 * ⚠️ **Perché vive da solo e non dentro `claude.ts`** (14 settembre 2026).
 * Il taglio serve a TUTTI E DUE i canali, ma `claude.ts` si porta dietro
 * l'intero motore del modello: importarlo dalla rotta di Telegram ne rompeva
 * i test e appesantiva l'avvio. Qui non c'è niente da caricare — solo una
 * funzione pura su un array — e quindi la regola può stare davvero in un posto
 * solo, che è la condizione perché i due canali non divergano.
 *
 * ⚠️ **Il difetto che ha fatto nascere questo file.** Quel giorno l'Ingegnere
 * si è visto rispondere «budget di elaborazione superato» tre volte di fila su
 * Telegram. La telemetria ha detto cos'era: UNA sola iterazione, ZERO chiamate
 * a tool, **933.975 token spediti**. Non un loop impazzito, non la delega agli
 * specialisti: una singola richiesta gigantesca.
 *
 * La chat web chiamava questa funzione, Telegram no — aveva un taglio suo che
 * si fermava a «più di 8 messaggi», e otto messaggi contenenti 34 fatture, sei
 * PDF e gli elenchi di Fatture in Cloud restano enormi lo stesso. Il commento
 * che c'era in `claude.ts` diceva pure «Telegram usa già solo 6 messaggi di
 * history»: un'assunzione, scritta come fatto, mai verificata.
 *
 * È la forma in cui il difetto si ripete sempre, in questa casa: **una difesa
 * costruita bene su un canale e mai portata sull'altro.**
 */
import type Anthropic from '@anthropic-ai/sdk'

/**
 * cost-control 5 giu 2026: 500K char ≈ 125K token di input a ogni messaggio.
 * 120K char ≈ 30K token, che basta e avanza per una conversazione vera.
 */
export const MAX_CONTEXT_CHARS = 120_000

export function charCount(content: Anthropic.MessageParam['content']): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return JSON.stringify(content).length
  return 0
}

/**
 * Tiene gli ultimi messaggi che stanno in `MAX_CONTEXT_CHARS`, e dice che il
 * resto è stato omesso invece di farlo sparire.
 *
 * ⚠️ L'ULTIMO messaggio resta sempre, qualunque cosa pesi: è la richiesta a cui
 * si sta rispondendo, e tagliarla sarebbe rispondere a un'altra domanda.
 */
export function trimMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length <= 1) return messages
  let totalChars = charCount(messages[messages.length - 1].content)
  let startIdx = messages.length - 1

  for (let i = messages.length - 2; i >= 0; i--) {
    const chars = charCount(messages[i].content)
    if (totalChars + chars > MAX_CONTEXT_CHARS) break
    totalChars += chars
    startIdx = i
  }

  if (startIdx > 0) {
    const trimmed = messages.slice(startIdx)
    if (trimmed[0]?.role !== 'user') {
      trimmed.unshift({ role: 'user', content: '(conversazione precedente omessa)' })
    }
    return trimmed
  }
  return messages
}

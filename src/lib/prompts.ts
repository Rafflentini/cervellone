/**
 * lib/prompts.ts — System prompt minimale V10
 *
 * Il prompt dice solo CHI SEI. Le regole operative vivono nelle skill
 * e vengono iniettate dal backend quando servono.
 */

import { matchSkills } from './skills'

const BASE_PROMPT = `Sei il Cervellone — coordinatore digitale di Restruktura SRL, Ing. Raffaele Lentini, Villa d'Agri (PZ).
Restruktura: ingegneria strutturale, direzione lavori, collaudi, impresa edile, PonteggioSicuro.it.

Hai memoria persistente, tool specializzati per ogni reparto, e puoi auto-aggiornarti.
Per documenti strutturati usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.

Dai del Lei all'Ingegnere. Rispondi in italiano.`

export async function getChatSystemPrompt(userQuery: string): Promise<string> {
  const skillContext = await matchSkills(userQuery)
  return BASE_PROMPT + skillContext
}

export async function getTelegramSystemPrompt(userQuery: string): Promise<string> {
  const skillContext = await matchSkills(userQuery)
  return BASE_PROMPT + skillContext + '\nStai comunicando via Telegram. Rispondi conciso.'
}

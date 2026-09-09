/**
 * lib/skills.ts — Caricamento skill modulari da Supabase
 *
 * Il backend rileva keyword nel messaggio utente e inietta
 * le istruzioni della skill nel system prompt PRIMA di chiamare Claude.
 * Zero tool call extra, zero latenza aggiuntiva.
 */

import { supabase } from './supabase'

interface Skill {
  id: string
  nome: string
  istruzioni: string
  keywords: string[]
}

// Cache skill per 5 minuti
let skillCache: Skill[] | null = null
let skillCacheTime = 0
const SKILL_TTL = 300_000

async function loadSkills(): Promise<Skill[]> {
  if (skillCache && Date.now() - skillCacheTime < SKILL_TTL) return skillCache

  const { data } = await supabase
    .from('cervellone_skills')
    .select('id, nome, istruzioni, keywords')

  skillCache = (data || []) as Skill[]
  skillCacheTime = Date.now()
  return skillCache
}

/**
 * Quanti messaggi dell'Ingegnere si guardano, oltre a quello corrente.
 *
 * ⭐ Prima si guardava SOLO l'ultimo, e una skill spariva alla domanda dopo:
 * «quanto devo versare di imposta di soggiorno» la accendeva, «e a luglio?» la
 * spegneva — e il bot rispondeva senza le regole, con la stessa sicurezza di
 * prima. Non si vedeva: la risposta arrivava lo stesso, solo peggiore.
 *
 * La finestra e' CORTA apposta. Allargarla costa attivazioni sbagliate, e in
 * questo progetto ce n'e' una nota: «maratea» e' un anti-segnale, quattro
 * messaggi su cinque sono cantieri Restruktura. Tre turni bastano a coprire la
 * domanda di approfondimento, che e' il caso vero.
 */
export const FINESTRA_SKILL = 3

/**
 * Date le ultime frasi dell'Ingegnere, trova le skill da iniettare.
 * Restituisce le istruzioni concatenate, o stringa vuota se nessuna matcha.
 *
 * Accetta una stringa sola (il messaggio corrente) o l'elenco dei messaggi
 * utente dal piu' recente in giu'.
 */
export async function matchSkills(userQuery: string | string[]): Promise<string> {
  const skills = await loadSkills()
  const finestra = (Array.isArray(userQuery) ? userQuery : [userQuery])
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(0, FINESTRA_SKILL)
  const queryLower = finestra.join(String.fromCharCode(10)).toLowerCase()
  const matched: Skill[] = []

  for (const skill of skills) {
    // ⭐ Le parole chiave VUOTE si scartano, non solo l'elenco vuoto:
    // `"".includes("")` e' vero, quindi una riga con un campo salvato a meta'
    // — un errore di battitura nel Config — accenderebbe quella skill su OGNI
    // messaggio, per sempre, senza che si veda. La guardia che c'era copriva
    // l'elenco vuoto e non la stringa vuota dentro l'elenco.
    //
    // Nessuna guardia esplicita sull'elenco svuotato: `[].some()` e gia falso.
    // Una guardia che non puo scattare somiglia a una difesa e non lo e.
    const chiavi = (skill.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
    if (chiavi.some((kw) => queryLower.includes(kw.toLowerCase()))) matched.push(skill)
  }

  if (matched.length === 0) return ''

  const sections = matched.map(s =>
    `\n--- SKILL: ${s.nome} ---\n${s.istruzioni}`
  )

  return '\n' + sections.join('\n')
}

/**
 * Invalida la cache (dopo modifica skill).
 */
export function invalidateSkillCache(): void {
  skillCache = null
  skillCacheTime = 0
}

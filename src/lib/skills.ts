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
 * Dato il messaggio utente, trova le skill da iniettare.
 * Restituisce le istruzioni concatenate, o stringa vuota se nessuna skill matcha.
 */
export async function matchSkills(userQuery: string): Promise<string> {
  const skills = await loadSkills()
  const queryLower = userQuery.toLowerCase()
  const matched: Skill[] = []

  for (const skill of skills) {
    if (!skill.keywords?.length) continue
    const hasMatch = skill.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
    if (hasMatch) matched.push(skill)
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
export function invalidateSkillCache() {
  skillCache = null
  skillCacheTime = 0
}

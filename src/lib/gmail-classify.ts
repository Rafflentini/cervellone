/**
 * lib/gmail-classify.ts — Gmail classifier automatico (Sub-progetto C)
 *
 * Categorie data-driven via cervellone_gmail_categorie.
 * Confidence threshold 0.7. Sonnet 4.6 batch giornaliero 8:30 lun-ven Rome.
 * Auto-create label Cervellone/* via applyLabel esistente (gmail-tools).
 *
 * Spec: docs/superpowers/specs/2026-05-07-cervellone-gmail-classification-design.md
 */

import { supabase } from './supabase'

export interface Category {
  name: string
  description: string
}

/**
 * Carica le categorie attive ordinate per id.
 * Throws su errore Supabase.
 */
export async function loadCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('cervellone_gmail_categorie')
    .select('name, description')
    .eq('enabled', true)
    .order('id')
  if (error) throw new Error(`loadCategories: ${error.message}`)
  return (data ?? []) as Category[]
}

/**
 * Costruisce il prompt classifier dal set di categorie attive.
 * Throws se array vuoto (errore configurazione).
 */
export function buildPrompt(categories: Category[]): string {
  if (categories.length === 0) throw new Error('No categories configured')
  const lines = categories.map(c => `- ${c.name}: ${c.description}`).join('\n')
  return `Sei un classificatore di mail per uno studio tecnico/edile italiano.

Categorie disponibili:
${lines}

Output JSON (no markdown, no commenti):
{"category": "<nome esatto categoria o null>", "confidence": <0-1>, "reason": "1-2 frasi"}

Se nessuna categoria adatta o ambiguo: {"category": null, "confidence": 0, "reason": "..."}`
}

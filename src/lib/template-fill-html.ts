// src/lib/template-fill-html.ts — Motore B: riempimento template HTML (puro, testabile)
import type { CampoModello } from './document-templates'

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function validateValues(
  campi: CampoModello[],
  valori: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  for (const c of campi) {
    if (!c.obbligatorio) continue
    const v = valori[c.nome]
    const vuoto =
      v === undefined || v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0)
    if (vuoto) missing.push(c.nome)
  }
  return { ok: missing.length === 0, missing }
}

export function applyDefaults(
  campi: CampoModello[],
  valori: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...valori }
  for (const c of campi) {
    const v = out[c.nome]
    const vuoto = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
    if (vuoto && c.default !== undefined) out[c.nome] = c.default
  }
  return out
}

// Espande i blocchi {{#nome}}...{{/nome}} per ogni riga dell'array `valori[nome]`,
// poi sostituisce gli scalari {{campo}} con escape HTML. Scalari mancanti -> ''.
export function riempiHtml(template: string, valori: Record<string, unknown>): string {
  // 1. blocchi tabella
  const blockRe = /\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g
  let html = template.replace(blockRe, (_m, nome: string, inner: string) => {
    const rows = valori[nome]
    if (!Array.isArray(rows) || rows.length === 0) return ''
    return rows
      .map((row) =>
        inner.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_mm, col: string) =>
          escapeHtml((row as Record<string, unknown>)[col]),
        ),
      )
      .join('')
  })

  // 2. scalari
  html = html.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, nome: string) => {
    const v = valori[nome]
    if (v === undefined || v === null || typeof v === 'object') return ''
    return escapeHtml(v)
  })

  return html
}

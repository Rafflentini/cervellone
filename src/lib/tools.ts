/**
 * lib/tools.ts — Registry tool completo con tutti i fix
 * 
 * Fix applicati:
 * - PER-003: cerca_prezziario multi-risultato
 * - FUN-004: ricerca per codice_voce
 * - PER-004: cerca_prezziario_batch per preventivi grandi
 * - NEW: importa_da_url (Opzione B — scarica prezziario da URL)
 * - NEW: cerca_documenti (preventivi/relazioni passate)
 */

import { executeCalcolaPreventivo, PreventivoInput } from './tools/preventivo'
import { supabase } from './supabase'

// ── Interfaccia ──

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ── STUDIO TECNICO ──

const STUDIO_TECNICO_TOOLS: ToolDefinition[] = [
  {
    name: 'calcola_preventivo',
    description: 'Genera un preventivo estimativo professionale con calcoli e output HTML.',
    input_schema: {
      type: 'object',
      properties: {
        titolo: { type: 'string' },
        numero: { type: 'string' },
        data: { type: 'string' },
        committente: {
          type: 'object',
          properties: { nome: { type: 'string' }, indirizzo: { type: 'string' }, cf_piva: { type: 'string' }, telefono: { type: 'string' }, email: { type: 'string' } },
          required: ['nome'],
        },
        cantiere: {
          type: 'object',
          properties: { indirizzo: { type: 'string' }, comune: { type: 'string' }, descrizione: { type: 'string' } },
          required: ['indirizzo', 'comune', 'descrizione'],
        },
        voci: {
          type: 'array',
          items: {
            type: 'object',
            properties: { descrizione: { type: 'string' }, um: { type: 'string' }, quantita: { type: 'number' }, prezzo_unitario: { type: 'number' }, categoria: { type: 'string' } },
            required: ['descrizione', 'um', 'quantita', 'prezzo_unitario'],
          },
        },
        coefficienti: {
          type: 'object',
          properties: { spese_generali: { type: 'number' }, utile_impresa: { type: 'number' }, oneri_sicurezza: { type: 'number' }, iva: { type: 'number' } },
        },
        regione: { type: 'string' },
        note: { type: 'array', items: { type: 'string' } },
        esclusioni: { type: 'array', items: { type: 'string' } },
        condizioni_pagamento: { type: 'string' },
        validita_offerta: { type: 'string' },
      },
      required: ['committente', 'cantiere', 'voci'],
    },
  },
  {
    name: 'cerca_prezziario',
    description: 'Cerca voci nel prezziario regionale. Restituisce MULTIPLI risultati (fino a 15). Cerca per descrizione O per codice voce (es. BAS25_E03.015). Regioni disponibili: verificare con conta_prezziario.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Descrizione lavorazione o codice voce (es. "demolizione pavimento" o "BAS25_E03")' },
        regione: { type: 'string', description: 'Regione del prezziario (default: basilicata). Es: basilicata, lazio, campania' },
        limit: { type: 'number', description: 'Numero massimo risultati (default: 10, max: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cerca_prezziario_batch',
    description: 'Cerca MULTIPLE voci nel prezziario in una sola chiamata. Efficiente per preventivi con molte voci.',
    input_schema: {
      type: 'object',
      properties: {
        voci: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array di descrizioni da cercare (es. ["demolizione pavimento", "massetto", "piastrelle"])',
        },
        regione: { type: 'string' },
      },
      required: ['voci'],
    },
  },
  {
    name: 'conta_prezziario',
    description: 'Verifica quali prezziari regionali sono disponibili e quante voci hanno.',
    input_schema: {
      type: 'object',
      properties: {
        regione: { type: 'string', description: 'Regione specifica, o vuoto per vedere tutte le regioni disponibili' },
      },
      required: [],
    },
  },
  {
    name: 'importa_prezziario_da_url',
    description: 'Scarica e importa un prezziario regionale da un URL pubblico. Supporta file .ods, .csv, .xlsx. Usa questo tool quando serve un prezziario di una regione non ancora caricata. Cerca prima l\'URL con web_search, poi chiama questo tool.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL diretto al file del prezziario (.ods, .csv, .xlsx)' },
        regione: { type: 'string', description: 'Nome regione (es: lazio, campania, puglia)' },
        anno: { type: 'number', description: 'Anno del prezziario (es: 2025, 2026)' },
      },
      required: ['url', 'regione'],
    },
  },
  {
    name: 'cerca_documenti',
    description: 'Cerca documenti generati in passato: preventivi, computi, relazioni, lettere. Cerca per titolo, tipo o data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare nel titolo (es. "Rossi", "ponteggio", "preventivo")' },
        data_da: { type: 'string', description: 'Data inizio ricerca (YYYY-MM-DD)' },
        data_a: { type: 'string', description: 'Data fine ricerca (YYYY-MM-DD)' },
      },
      required: ['query'],
    },
  },
]

// ── EXECUTORS ──

async function executeStudioTecnico(name: string, input: Record<string, unknown>): Promise<string | null> {
  switch (name) {
    case 'calcola_preventivo':
      return executeCalcolaPreventivo(input as unknown as PreventivoInput)

    case 'cerca_prezziario': {
      const query = input.query as string
      const regione = (input.regione as string) || 'basilicata'
      const limit = Math.min((input.limit as number) || 10, 20)

      // FIX FUN-004: Controlla se è un codice voce
      const isCode = /^[A-Z]{2,5}\d{2}[_-]/.test(query)

      let data: any[] | null = null

      if (isCode) {
        // Ricerca per codice voce (prefix match)
        const { data: d } = await supabase
          .from('prezziario')
          .select('codice_voce, descrizione, unita_misura, prezzo, fonte')
          .eq('regione', regione)
          .ilike('codice_voce', `${query}%`)
          .order('codice_voce')
          .limit(limit)
        data = d
      }

      if (!data?.length) {
        // Ricerca per descrizione (ILIKE)
        const { data: d } = await supabase
          .from('prezziario')
          .select('codice_voce, descrizione, unita_misura, prezzo, fonte')
          .eq('regione', regione)
          .ilike('descrizione', `%${query}%`)
          .order('descrizione')
          .limit(limit)
        data = d
      }

      // Se ancora niente, prova parole singole
      if (!data?.length) {
        const words = query.split(/\s+/).filter(w => w.length > 3)
        for (const word of words.slice(0, 2)) {
          const { data: d } = await supabase
            .from('prezziario')
            .select('codice_voce, descrizione, unita_misura, prezzo, fonte')
            .eq('regione', regione)
            .ilike('descrizione', `%${word}%`)
            .limit(5)
          if (d?.length) {
            data = [...(data || []), ...d]
          }
        }
        // Deduplica
        if (data) {
          const seen = new Set<string>()
          data = data.filter(v => {
            if (seen.has(v.codice_voce)) return false
            seen.add(v.codice_voce)
            return true
          }).slice(0, limit)
        }
      }

      if (!data?.length) {
        // Check se il prezziario per quella regione esiste
        const { count } = await supabase
          .from('prezziario')
          .select('*', { count: 'exact', head: true })
          .eq('regione', regione)
        if (!count) {
          return `Prezziario ${regione} non disponibile nel database. Usa importa_prezziario_da_url per scaricarlo, oppure chiedi all'Ingegnere di caricare il file ODS.`
        }
        return `Nessuna voce trovata per "${query}" nel prezziario ${regione} (${count} voci totali). Prova con parole chiave diverse.`
      }

      const lines = data.map(v =>
        `${v.codice_voce} | ${v.descrizione.slice(0, 80)} | ${v.unita_misura} | €${v.prezzo}`
      )
      return `Trovate ${data.length} voci per "${query}" (${regione}):\n\n${lines.join('\n')}`
    }

    case 'cerca_prezziario_batch': {
      const voci = input.voci as string[]
      const regione = (input.regione as string) || 'basilicata'
      const results: string[] = []

      for (const voce of voci.slice(0, 20)) {
        const { data } = await supabase
          .from('prezziario')
          .select('codice_voce, descrizione, unita_misura, prezzo')
          .eq('regione', regione)
          .ilike('descrizione', `%${voce}%`)
          .limit(3)

        if (data?.length) {
          results.push(`📌 "${voce}":\n${data.map(v =>
            `  ${v.codice_voce} | ${v.descrizione.slice(0, 60)} | ${v.unita_misura} | €${v.prezzo}`
          ).join('\n')}`)
        } else {
          results.push(`📌 "${voce}": nessuna voce trovata`)
        }
      }

      return results.join('\n\n')
    }

    case 'conta_prezziario': {
      const regione = input.regione as string

      if (regione) {
        const { count } = await supabase
          .from('prezziario')
          .select('*', { count: 'exact', head: true })
          .eq('regione', regione)
        if (count && count > 0) {
          return `Prezziario ${regione}: ${count} voci disponibili.`
        }
        return `Nessun prezziario caricato per ${regione}. Puoi importarlo con importa_prezziario_da_url.`
      }

      // Tutte le regioni — usa query distinta per non scaricare tutte le righe
      const { data } = await supabase
        .from('prezziario')
        .select('regione', { count: 'exact' })
        .limit(1)
      if (!data?.length) return 'Nessun prezziario caricato.'

      // Conta per regione con query separate (più efficiente di scaricare tutto)
      const regioni = [...new Set((await supabase.from('prezziario').select('regione')).data?.map(r => r.regione) || [])]
      const counts: Record<string, number> = {}
      for (const r of regioni) {
        const { count } = await supabase.from('prezziario').select('*', { count: 'exact', head: true }).eq('regione', r)
        if (count) counts[r] = count
      }
      const lines = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${r}: ${c} voci`)
      return `Prezziari disponibili:\n${lines.join('\n')}`
    }

    case 'importa_prezziario_da_url': {
      const url = input.url as string
      const regione = (input.regione as string).toLowerCase()
      const anno = (input.anno as number) || new Date().getFullYear()

      try {
        // Scarica il file
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Cervellone/2.0 (Restruktura SRL)' },
        })
        if (!response.ok) {
          return `Errore download: HTTP ${response.status}. Verificare che l'URL sia corretto e il file sia pubblicamente accessibile.`
        }

        const contentType = response.headers.get('content-type') || ''
        const buffer = Buffer.from(await response.arrayBuffer())
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)

        if (buffer.length > 50 * 1024 * 1024) {
          return `File troppo grande (${sizeMB}MB). Limite: 50MB.`
        }

        // Determina formato dall'URL o content-type
        const isOds = url.endsWith('.ods') || contentType.includes('opendocument')
        const isCsv = url.endsWith('.csv') || contentType.includes('csv')
        const isXlsx = url.endsWith('.xlsx') || contentType.includes('spreadsheet')

        let rows: string[] = []

        if (isOds) {
          rows = await parseOdsToRows(buffer)
        } else if (isCsv) {
          rows = buffer.toString('utf-8').split('\n').filter(r => r.trim().length > 0)
        } else if (isXlsx) {
          rows = await parseXlsxToRows(buffer)
        } else {
          return `Formato file non riconosciuto. Supportati: .ods, .csv, .xlsx. URL: ${url}`
        }

        if (rows.length < 10) {
          return `File scaricato ma contiene solo ${rows.length} righe. Non sembra un prezziario.`
        }

        // Parsa voci
        const voci: { codice_voce: string; descrizione: string; unita_misura: string; prezzo: number }[] = []

        for (const row of rows) {
          const cells = row.split(/[|\t;]/).map(c => c.trim())
          if (cells.length < 3) continue

          // Cerca codice voce (pattern: LETTERE + NUMERI + _ o .)
          const codice = cells.find(c => /^[A-Z]{1,6}\d{2}[_.\-]/.test(c)) || cells[0]
          if (!/[A-Z]/.test(codice) || codice.length < 5) continue

          // Cerca descrizione (cella più lunga)
          const descrizione = cells.reduce((a, b) => b.length > a.length ? b : a, '')
          if (descrizione.length < 5) continue

          // Cerca prezzo (ultimo numero valido)
          let prezzo = 0
          for (let i = cells.length - 1; i >= 0; i--) {
            if (cells[i].includes('%')) continue
            const num = parseFloat(cells[i].replace(/\./g, '').replace(',', '.'))
            if (!isNaN(num) && num > 0 && num < 999999) { prezzo = num; break }
          }
          if (prezzo === 0) continue

          // Cerca unità di misura
          const umCandidates = ['mq', 'mc', 'ml', 'kg', 'q', 't', 'nr', 'cad', 'corpo', 'ora', 'giorno', 'm2', 'm3', 'lt']
          let um = ''
          for (const cell of cells) {
            const lower = cell.toLowerCase().trim()
            if (umCandidates.includes(lower) || lower.length <= 5 && /^[a-z/²³]+$/.test(lower)) {
              um = lower
              break
            }
          }

          voci.push({
            codice_voce: codice.trim(),
            descrizione: descrizione.slice(0, 500),
            unita_misura: um,
            prezzo: Math.round(prezzo * 100) / 100,
          })
        }

        if (voci.length < 50) {
          return `File scaricato (${sizeMB}MB, ${rows.length} righe) ma solo ${voci.length} voci valide riconosciute. Il formato potrebbe essere diverso dal previsto. Suggerimento: chiedere all'Ingegnere di caricare manualmente il file ODS via Telegram.`
        }

        // Elimina vecchie voci e importa
        await supabase.from('prezziario').delete().eq('regione', regione).eq('anno', anno)

        let salvate = 0
        for (let i = 0; i < voci.length; i += 500) {
          const batch = voci.slice(i, i + 500).map(v => ({
            regione,
            anno,
            ...v,
            fonte: `Prezziario ${regione} ${anno} (importato da URL)`,
          }))
          const { error } = await supabase.from('prezziario').insert(batch)
          if (!error) salvate += batch.length
        }

        return `✅ PREZZIARIO ${regione.toUpperCase()} ${anno} IMPORTATO\n\n` +
          `File: ${sizeMB}MB, ${rows.length} righe analizzate\n` +
          `Voci importate: ${salvate}/${voci.length}\n\n` +
          `Ora puoi cercare con: cerca_prezziario(query, regione="${regione}")`

      } catch (err) {
        return `Errore durante l'importazione: ${(err as Error).message}. Verificare URL e connessione.`
      }
    }

    case 'cerca_documenti': {
      const query = input.query as string
      let q = supabase
        .from('documents')
        .select('id, name, type, created_at')
        .ilike('name', `%${query}%`)

      if (input.data_da) q = q.gte('created_at', input.data_da as string)
      if (input.data_a) q = q.lte('created_at', input.data_a as string)

      const { data } = await q.order('created_at', { ascending: false }).limit(10)

      if (!data?.length) return `Nessun documento trovato per "${query}".`

      return data.map(d => {
        const date = new Date(d.created_at).toLocaleDateString('it')
        const url = `https://cervellone-5poc.vercel.app/doc/${d.id}`
        return `📄 ${d.name} — ${date} — ${url}`
      }).join('\n')
    }

    default:
      return null
  }
}

// ── ODS Parser ──
async function parseOdsToRows(buffer: Buffer): Promise<string[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('content.xml')?.async('string')
  if (!xml) return []

  const rows: string[] = []
  const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g
  let rm
  while ((rm = rowRe.exec(xml)) !== null) {
    const cells: string[] = []
    const cellRe = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
    let cm
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const txt = (cm[2] || '').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&apos;/g, "'").trim()
      if (txt) cells.push(txt)
    }
    if (cells.length >= 2) rows.push(cells.join(' | '))
  }
  return rows
}

// ── XLSX Parser (basic) ──
async function parseXlsxToRows(buffer: Buffer): Promise<string[]> {
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buffer)
    const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
    if (!shared) return []
    const texts: string[] = []
    const re = /<t[^>]*>([\s\S]*?)<\/t>/g
    let m
    while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
    // Raggruppamento approssimativo in righe (ogni 5-10 celle)
    const rows: string[] = []
    for (let i = 0; i < texts.length; i += 6) {
      rows.push(texts.slice(i, i + 6).join(' | '))
    }
    return rows
  } catch {
    return []
  }
}

// ── Registry ──

const ALL_TOOLS: ToolDefinition[] = [...STUDIO_TECNICO_TOOLS]
const EXECUTORS = [executeStudioTecnico]

export function getToolDefinitions() {
  return [
    { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 },
    ...ALL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  ]
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  for (const executor of EXECUTORS) {
    const result = await executor(name, input)
    if (result !== null) return result
  }
  return `Tool "${name}" non riconosciuto.`
}

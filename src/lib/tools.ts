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

import { supabase } from './supabase'
import { sendTelegramMessage } from './telegram-helpers'
import { DRIVE_TOOLS, executeDriveTool } from './drive'
import { GITHUB_TOOLS, executeGithubTool } from './github-tools'
import { WEATHER_TOOLS, executeWeatherTool } from './weather-tool'
import { promoteModel } from './circuit-breaker'

/**
 * Notifica all'Ingegnere il cambio modello — Telegram (immediato) + webchat
 * (inserisce assistant message nelle ultime 5 conversazioni web non-Telegram,
 * così appare in cronologia al prossimo apri-chat).
 */
async function notifyModelChange(noticeText: string): Promise<void> {
  // Telegram immediato all'admin. Fallback a TELEGRAM_ALLOWED_IDS[0] se ADMIN_CHAT_ID
  // non configurato (single-user setup tipico).
  let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (!adminChat) {
    const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
    adminChat = parseInt(firstAllowed || '0', 10)
  }
  if (adminChat) {
    await sendTelegramMessage(adminChat, noticeText).catch((err) => {
      console.error('Notify Telegram failed:', err)
    })
  }

  // Webchat: insert assistant message in ultime 5 conv web
  try {
    const { data: webConvs } = await supabase
      .from('conversations')
      .select('id')
      .neq('title', '💬 Telegram')
      .order('created_at', { ascending: false })
      .limit(5)

    if (webConvs && webConvs.length > 0) {
      const inserts = webConvs.map((c: { id: string }) => ({
        conversation_id: c.id,
        role: 'assistant',
        content: noticeText,
      }))
      await supabase.from('messages').insert(inserts)
    }
  } catch (err) {
    console.error('Notify webchat failed:', err)
  }
}

// ── Interfaccia ──

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ── STUDIO TECNICO ──

const STUDIO_TECNICO_TOOLS: ToolDefinition[] = [
  {
    name: 'cerca_prezziario',
    description: 'Cerca voci nel prezziario regionale per descrizione o codice voce.',
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
    description: 'Cerca multiple voci nel prezziario in una sola chiamata.',
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
    description: 'Scarica e importa un prezziario da URL (.ods, .csv, .xlsx).',
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
    description: 'Cerca documenti generati in passato per titolo o data.',
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
  {
    name: 'scarica_file_da_url',
    description: 'Scarica qualsiasi file da un URL pubblico.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL diretto al file da scaricare' },
        filename: { type: 'string', description: 'Nome descrittivo del file (es: "relazione_strutturale.pdf")' },
      },
      required: ['url'],
    },
  },
  {
    name: 'genera_preventivo_completo',
    description: 'Genera Preventivo + CME + Quadro Economico. Cerca nel prezziario, calcola, produce 3 documenti HTML.',
    input_schema: {
      type: 'object',
      properties: {
        committente: { type: 'string', description: 'Nome committente' },
        indirizzo_cantiere: { type: 'string', description: 'Indirizzo del cantiere' },
        comune: { type: 'string', description: 'Comune del cantiere' },
        descrizione_lavoro: { type: 'string', description: 'Descrizione generale del lavoro' },
        lavorazioni: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              descrizione: { type: 'string', description: 'Descrizione lavorazione (es: "demolizione pavimento esistente")' },
              quantita: { type: 'number' },
              um: { type: 'string', description: 'Unità di misura: mq, ml, mc, kg, cad, corpo' },
              prezzo_mercato: { type: 'number', description: 'Prezzo unitario di mercato stimato (per il preventivo)' },
            },
            required: ['descrizione', 'quantita', 'um'],
          },
        },
        regione: { type: 'string', description: 'Regione per prezziario (default: basilicata)' },
        spese_generali_perc: { type: 'number', description: 'Default 0.15 (15%)' },
        utile_impresa_perc: { type: 'number', description: 'Default 0.10 (10%)' },
        iva_perc: { type: 'number', description: 'Default 0.10 (10%)' },
      },
      required: ['committente', 'comune', 'descrizione_lavoro', 'lavorazioni'],
    },
  },
]

// ── LOOKUP PREZZIARI — URL diretti ODS/XLS/CSV per auto-import ──
const PREZZIARI_LEENO: Record<string, { url: string; anno: number; formato: string }> = {
  'emilia-romagna': { url: 'https://leeno.org/download/LeenO/public/listini/emilia_romagna/Emilia_Romagna_2026_LeenO.ods', anno: 2026, formato: 'ods' },
  'lombardia': { url: 'https://leeno.org/download/LeenO/public/listini/lombardia/Prezzario_Lombardia_2025_2.ods', anno: 2025, formato: 'ods' },
  'puglia': { url: 'https://leeno.org/download/LeenO/public/listini/Puglia/prezzario_regione_puglia_2025.ods', anno: 2025, formato: 'ods' },
  'friuli-venezia-giulia': { url: 'https://leeno.org/download/LeenO/public/listini/Friuli-Venezia%20Giulia/20250701_Prezzario_FVG_2025.ods', anno: 2025, formato: 'ods' },
  'calabria': { url: 'https://leeno.org/download/LeenO/public/listini/calabria/Elenco_prezzi_Ambito_Regionale_anno_2025.ods', anno: 2025, formato: 'ods' },
  'marche': { url: 'https://leeno.org/download/LeenO/public/listini/Marche/MARCHE_2025_LeenO.ods', anno: 2025, formato: 'ods' },
  'campania': { url: 'https://leeno.org/download/LeenO/public/listini/Campania/Elenco_prezzi_Ambito_Regionale_anno_2025.ods', anno: 2025, formato: 'ods' },
  'umbria': { url: 'https://leeno.org/download/LeenO/public/listini/Umbria/UMBRIA_2024_LeenO.ods', anno: 2024, formato: 'ods' },
  'basilicata': { url: 'https://leeno.org/download/LeenO/public/listini/Basilicata/Prezzario_Regione_Basilicata_2025.ods', anno: 2025, formato: 'ods' },
  'piemonte': { url: 'https://leeno.org/download/LeenO/public/listini/Piemonte/Piemonte_Edizione_2025.ods', anno: 2025, formato: 'ods' },
  'abruzzo': { url: 'https://leeno.org/download/LeenO/public/listini/abruzzo/2025/Listino_Edile_Regione_Abruzzo_2025.ods', anno: 2025, formato: 'ods' },
  'veneto': { url: 'https://leeno.org/download/LeenO/public/listini/Veneto/Prezzario_VENETO_2024.ods', anno: 2024, formato: 'ods' },
  'trento': { url: 'https://leeno.org/download/LeenO/public/listini/Trento/Provincia_Autonoma_di_Trento_Prezziario_2025.ods', anno: 2025, formato: 'ods' },
  'sardegna': { url: 'https://cmsras.regione.sardegna.it/api/assets/redazionaleras/850d6b50-937e-4abf-ba84-a12088f3f14b/elenco-articoli-ed-analisi-2024-xls.zip', anno: 2024, formato: 'xlsx' },
  'toscana': { url: 'https://dati.toscana.it/dataset/a8113242-e448-4ad9-863d-2ebdee3812b7/resource/bc3b4d14-d70a-4609-bb1f-ce2afa6a3215/download/2025-1-firenze-data.zip', anno: 2025, formato: 'csv' },
  'sicilia': { url: 'https://www.regione.sicilia.it/sites/default/files/2024-01/Prezzario%202024.pdf', anno: 2024, formato: 'pdf' },
  'lazio': { url: 'https://www.regione.lazio.it/sites/default/files/documentazione/2025/DD-G00988-27-01-2025-Allegato1-Tariffario-2025-aggiornato.pdf', anno: 2025, formato: 'pdf' },
}

const REGIONI_ALIAS: Record<string, string> = {
  'friuli': 'friuli-venezia-giulia',
  'fvg': 'friuli-venezia-giulia',
  'trentino': 'trento',
  'trentino-alto-adige': 'trento',
  'emilia': 'emilia-romagna',
  'romagna': 'emilia-romagna',
}

// ── EXECUTORS ──

async function executeStudioTecnico(name: string, input: Record<string, unknown>, conversationId?: string): Promise<string | null> {
  switch (name) {
    case 'cerca_prezziario': {
      const query = input.query as string
      const regioneRaw2 = ((input.regione as string) || 'basilicata').toLowerCase().trim()
      const regione = REGIONI_ALIAS[regioneRaw2] || regioneRaw2
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
      const regioneRaw3 = ((input.regione as string) || 'basilicata').toLowerCase().trim()
      const regione = REGIONI_ALIAS[regioneRaw3] || regioneRaw3
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

      // Tutte le regioni — usa RPC efficiente (1 query, zero download massivi)
      const { data } = await supabase.rpc('get_distinct_regioni')
      if (!data?.length) return 'Nessun prezziario caricato.'

      const lines = (data as Array<{ regione: string; voci_count: number }>).map(r => `${r.regione}: ${r.voci_count} voci`)
      return `Prezziari disponibili:\n${lines.join('\n')}`
    }

    case 'importa_prezziario_da_url': {
      const url = input.url as string
      const regione = (input.regione as string).toLowerCase()
      const anno = (input.anno as number) || new Date().getFullYear()

      try {
        // Scarica il file
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'application/octet-stream,application/vnd.oasis.opendocument.spreadsheet,text/csv,*/*',
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
          },
          redirect: 'follow',
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

    case 'scarica_file_da_url': {
      const dlUrl = input.url as string
      const filename = (input.filename as string) || dlUrl.split('/').pop() || 'file'

      try {
        const response = await fetch(dlUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': '*/*',
          },
          redirect: 'follow',
        })
        if (!response.ok) return `Errore download: HTTP ${response.status}`

        const buffer = Buffer.from(await response.arrayBuffer())
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)
        if (buffer.length > 25 * 1024 * 1024) return `File troppo grande (${sizeMB}MB). Limite: 25MB.`

        const ext = filename.split('.').pop()?.toLowerCase() || ''

        // CSV/TXT/JSON/XML/HTML
        if (['csv', 'txt', 'md', 'json', 'xml', 'html'].includes(ext)) {
          const text = buffer.toString('utf-8')
          return `[File ${filename}, ${sizeMB}MB]\n\n${text.slice(0, 100000)}`
        }

        // ODS
        if (ext === 'ods') {
          const rows = await parseOdsToRows(buffer)
          if (rows.length > 0) {
            return `[File ODS: ${filename}, ${rows.length} righe]\n\n${rows.slice(0, 2000).join('\n').slice(0, 100000)}`
          }
        }

        // XLSX
        if (ext === 'xlsx' || ext === 'xls') {
          const rows = await parseXlsxToRows(buffer)
          if (rows.length > 0) {
            return `[File Excel: ${filename}, ${rows.length} righe]\n\n${rows.slice(0, 2000).join('\n').slice(0, 100000)}`
          }
        }

        // Word
        if (ext === 'docx' || ext === 'doc') {
          try {
            const mammoth = await import('mammoth')
            const result = await mammoth.extractRawText({ buffer })
            if (result.value && result.value.length > 50) {
              return `[File Word: ${filename}, ${sizeMB}MB]\n\n${result.value.slice(0, 100000)}`
            }
          } catch { /* fallback */ }
        }

        return `[File scaricato: ${filename}, ${sizeMB}MB, formato ${ext}] — contenuto binario non leggibile come testo.`
      } catch (err) {
        return `Errore download: ${(err as Error).message}`
      }
    }

    case 'genera_preventivo_completo': {
      // ══════════════════════════════════════════════════════════
      // CACHE CHECK: se documenti già generati per questa conversazione, restituiscili
      // ══════════════════════════════════════════════════════════
      if (conversationId) {
        const { data: allDocs } = await supabase
          .from('documents')
          .select('name, content, metadata')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cached = (allDocs || []).filter((d: any) =>
          ['preventivo', 'cme', 'quadro_economico'].includes(d.metadata?.doc_type)
        )

        if (cached.length >= 2) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prevDoc = cached.find((d: any) => d.metadata?.doc_type === 'preventivo')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cmeDoc = cached.find((d: any) => d.metadata?.doc_type === 'cme')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const qeDoc = cached.find((d: any) => d.metadata?.doc_type === 'quadro_economico')

          if (prevDoc && cmeDoc) {
            let result = `DOCUMENTI GIÀ GENERATI PER QUESTA CONVERSAZIONE (risultati invariati).\n\nPREVENTIVO:\n~~~document\n${prevDoc.content}\n~~~\n\nCME:\n~~~document\n${cmeDoc.content}\n~~~`
            if (qeDoc) {
              result += `\n\nQUADRO ECONOMICO:\n~~~document\n${qeDoc.content}\n~~~`
            }
            result += `\n\nI documenti sono identici a quelli generati in precedenza. Il CME è una misurazione ufficiale e non può cambiare.`
            return result
          }
        }
      }

      // ══════════════════════════════════════════════════════════
      // AUTO-IMPORT: se il prezziario non è caricato, scaricalo automaticamente
      // ══════════════════════════════════════════════════════════
      const regioneRaw = ((input.regione as string) || 'basilicata').toLowerCase().trim()
      const regioneNorm = REGIONI_ALIAS[regioneRaw] || regioneRaw
      const { count: prezCount } = await supabase
        .from('prezziario')
        .select('*', { count: 'exact', head: true })
        .eq('regione', regioneNorm)

      if (!prezCount || prezCount < 50) {
        const leeno = PREZZIARI_LEENO[regioneNorm]
        if (leeno && leeno.formato !== 'pdf') {
          console.log(`Auto-importing prezziario ${regioneNorm} (${leeno.formato}) from ${leeno.url.slice(0, 80)}...`)
          try {
            const importResult = await executeStudioTecnico('importa_prezziario_da_url', {
              url: leeno.url,
              regione: regioneNorm,
              anno: leeno.anno,
            })
            console.log(`Auto-import ${regioneNorm}: ${importResult?.slice(0, 200)}`)
          } catch (err) {
            console.error(`Auto-import failed for ${regioneNorm}:`, (err as Error).message)
          }
        } else if (leeno && leeno.formato === 'pdf') {
          console.log(`Prezziario ${regioneNorm} disponibile solo in PDF — non importabile automaticamente`)
        }
      }

      const committente = input.committente as string
      const indirizzo = (input.indirizzo_cantiere as string) || ''
      const comune = input.comune as string
      const descrizione = input.descrizione_lavoro as string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lavorazioni = input.lavorazioni as any[]
      const regione = ((input.regione as string) || 'basilicata').toLowerCase()
      const sgPerc = (input.spese_generali_perc as number) || 0.15
      const uiPerc = (input.utile_impresa_perc as number) || 0.10
      const ivaPerc = (input.iva_perc as number) || 0.10
      const oggi = new Date().toISOString().slice(0, 10)
      const numero = `PREV-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000) + 1000}`

      const fmt = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

      // ══════════════════════════════════════════════════════════
      // RICERCA PREZZIARIO CON SCORING — prende il match MIGLIORE, non il primo
      // ══════════════════════════════════════════════════════════

      const STOP = new Set(['per','con','del','della','delle','dei','degli','nel','nella','nelle',
        'nei','negli','sul','sulla','sulle','sui','dal','dalla','dai','tra','fra','che','come',
        'una','uno','gli','alle','alla','allo','fino','dopo','prima','sopra','sotto','tipo',
        'vari','circa','ogni','tutto','tutti','ecc','incluso','compreso','nuovo','nuova',
        'opere','lavori','fornitura','posa','opera','mano'])

      // Mappa U.M. compatibili
      const UM_COMPAT: Record<string, string[]> = {
        'mq': ['mq', 'mq/cm', 'a corpo'],
        'ml': ['m', 'ml', 'a corpo'],
        'mc': ['mc', 'a corpo'],
        'kg': ['kg', 'kn', 'a corpo'],
        'corpo': ['a corpo', 'corpo', 'mq', 'm', 'mc', 'kg'],
        'cadauno': ['cadauno', 'cad', 'nr', 'a corpo'],
      }

      function getKeywords(text: string): string[] {
        return text.toLowerCase()
          .replace(/[^a-zàèéìòù\s]/gi, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !STOP.has(w))
      }

      function isUmCompatible(umLav: string, umPrezziario: string): boolean {
        const lavNorm = umLav.toLowerCase().trim()
        const prezNorm = umPrezziario.toLowerCase().trim()
        if (lavNorm === prezNorm) return true
        const compat = UM_COMPAT[lavNorm]
        if (compat) return compat.some(c => prezNorm.includes(c))
        return true // se non mappata, accetta
      }

      async function cercaPerParola(parola: string): Promise<{codice_voce:string; descrizione:string; prezzo:number; um?:string}[]> {
        const { data } = await supabase.from('prezziario')
          .select('codice_voce, descrizione, prezzo, unita_misura')
          .eq('regione', regione)
          .ilike('descrizione', `%${parola}%`)
          .gt('prezzo', 0)
          .limit(25)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (data || []).map((r: any) => ({ ...r, um: r.unita_misura }))
      }

      // Scoring: keyword match + U.M. compatibile + prezzo in range ragionevole
      function scoreCandidato(
        candidato: {codice_voce:string; descrizione:string; prezzo:number; um?:string},
        keywords: string[],
        umLav: string,
        prezzoMercato: number
      ): number {
        const dl = candidato.descrizione.toLowerCase()
        let score = 0
        for (const kw of keywords) {
          if (dl.includes(kw)) score += 2
        }
        if (candidato.um) {
          if (isUmCompatible(umLav, candidato.um)) {
            score += 3
          } else {
            score -= 5
          }
        }
        if (prezzoMercato > 0 && candidato.prezzo > 0) {
          const ratio = candidato.prezzo / prezzoMercato
          if (ratio > 0.2 && ratio < 5) score += 2
          if (ratio > 0.5 && ratio < 2) score += 1
          if (ratio > 10 || ratio < 0.05) score -= 3
        }
        return score
      }

      let npCounter = 0

      const vociConPrezzi: Array<{
        descrizione: string; quantita: number; um: string;
        prezzo_mercato: number; prezzo_prezziario: number;
        codice_prezziario: string; desc_prezziario: string;
        importo_mercato: number; importo_prezziario: number;
        is_nuovo_prezzo: boolean;
        analisi_prezzo?: { materiali: number; manodopera: number; noli: number; totale: number };
      }> = []

      for (const lav of lavorazioni) {
        const desc = lav.descrizione as string
        const qty = lav.quantita as number
        const um = lav.um as string
        const prezzoMercato = (lav.prezzo_mercato as number) || 0
        const keywords = getKeywords(desc)
        const importoMercato = Math.round(qty * prezzoMercato * 100) / 100

        // ── RACCOLTA CANDIDATI da tutte le keyword (con stemming per-keyword) ──
        const candidatiMap = new Map<string, {codice_voce:string; descrizione:string; prezzo:number; um?:string}>()

        for (const kw of keywords) {
          let risultati = await cercaPerParola(kw)

          // Se questa keyword non trova nulla, prova la radice troncata
          if (risultati.length === 0 && kw.length > 5) {
            const radice = kw.slice(0, Math.max(5, Math.floor(kw.length * 0.65)))
            risultati = await cercaPerParola(radice)
          }

          for (const r of risultati) {
            if (!candidatiMap.has(r.codice_voce)) {
              candidatiMap.set(r.codice_voce, r)
            }
          }
        }

        // ── SCORING: scegli il candidato MIGLIORE ──
        const candidati = Array.from(candidatiMap.values())
        let bestMatch: {codice_voce:string; descrizione:string; prezzo:number; um?:string} | null = null
        let bestScore = -Infinity

        for (const c of candidati) {
          const s = scoreCandidato(c, keywords, um, prezzoMercato)
          if (s > bestScore) {
            bestScore = s
            bestMatch = c
          }
        }

        // Accetta solo se lo score è almeno 2 (= almeno 1 keyword matchata)
        if (bestMatch && bestScore >= 2) {
          const prezzoPrezziario = Number(bestMatch.prezzo)
          vociConPrezzi.push({
            descrizione: desc, quantita: qty, um,
            prezzo_mercato: prezzoMercato,
            prezzo_prezziario: prezzoPrezziario,
            codice_prezziario: bestMatch.codice_voce,
            desc_prezziario: bestMatch.descrizione.slice(0, 150),
            importo_mercato: importoMercato,
            importo_prezziario: Math.round(qty * prezzoPrezziario * 100) / 100,
            is_nuovo_prezzo: false,
          })
        } else {
          // ── NUOVO PREZZO — davvero non esiste nulla di simile ──
          npCounter++
          const codiceNP = `N.P.${npCounter}`

          // Analisi prezzo semplificata dal prezzo di mercato
          // 40% materiali, 40% manodopera, 15% noli, 5% spese (il 5% non si mette, è incluso)
          const materiali = Math.round(prezzoMercato * 0.40 * 100) / 100
          const manodopera = Math.round(prezzoMercato * 0.40 * 100) / 100
          const noli = Math.round(prezzoMercato * 0.15 * 100) / 100
          const totAnalisi = Math.round((materiali + manodopera + noli) * 100) / 100
          const prezzoNP = totAnalisi > 0 ? totAnalisi : prezzoMercato

          vociConPrezzi.push({
            descrizione: desc, quantita: qty, um,
            prezzo_mercato: prezzoMercato,
            prezzo_prezziario: prezzoNP,
            codice_prezziario: codiceNP,
            desc_prezziario: desc,
            importo_mercato: importoMercato,
            importo_prezziario: Math.round(qty * prezzoNP * 100) / 100,
            is_nuovo_prezzo: true,
            analisi_prezzo: { materiali, manodopera, noli, totale: totAnalisi },
          })
        }
      }

      // ── Calcoli ──
      const subtMercato = vociConPrezzi.reduce((s, v) => s + v.importo_mercato, 0)
      const subtPrezziario = vociConPrezzi.reduce((s, v) => s + v.importo_prezziario, 0)
      const sgMercato = Math.round(subtMercato * sgPerc * 100) / 100
      const uiMercato = Math.round(subtMercato * uiPerc * 100) / 100
      const impMercato = subtMercato + sgMercato + uiMercato
      const ivaMercato = Math.round(impMercato * ivaPerc * 100) / 100
      const totMercato = Math.round((impMercato + ivaMercato) * 100) / 100

      // Calcoli Quadro Economico (basati su prezziario, NON su mercato)
      const oneriSic = Math.round(subtPrezziario * 0.03 * 100) / 100
      const totLavori = Math.round((subtPrezziario + oneriSic) * 100) / 100
      const speseTecniche = Math.round(subtPrezziario * 0.10 * 100) / 100
      const imprevisti = Math.round(subtPrezziario * 0.05 * 100) / 100
      const totSommeDisp = Math.round((speseTecniche + imprevisti) * 100) / 100
      const ivaLavori = Math.round(totLavori * ivaPerc * 100) / 100
      const ivaSomme = Math.round(totSommeDisp * ivaPerc * 100) / 100
      const totQE = Math.round((totLavori + ivaLavori + totSommeDisp + ivaSomme) * 100) / 100

      // ══════════════════════════════════════════════════════════
      // CSS e header comuni
      // ══════════════════════════════════════════════════════════
      const cssCommon = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#222;padding:30px}
    .header{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:20px;border-radius:8px;margin-bottom:20px}
    .header h1{font-size:20px;margin-bottom:4px}.header p{font-size:11px;opacity:0.8}
    h2{color:#1e3a5f;font-size:16px;margin:20px 0 10px;border-bottom:2px solid #1e3a5f;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;font-size:11px}
    th{background:#1e3a5f;color:#fff;text-align:left}.right{text-align:right}.center{text-align:center}
    tr:nth-child(even){background:#f8f9fa}.total-row{background:#e8f0fe;font-weight:bold}
    .footer{margin-top:30px;font-size:10px;color:#888;border-top:1px solid #ddd;padding-top:10px}
    code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:10px}`

      const headerHtml = `<div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>Ingegneria, Costruzioni, Ponteggi — P.IVA 02087420762 — Villa d'Agri (PZ) — Ing. Raffaele Lentini</p></div>`

      // ══════════════════════════════════════════════════════════
      // PREVENTIVO HTML (documento commerciale — può avere spese generali ecc.)
      // ══════════════════════════════════════════════════════════
      const prevVociHtml = vociConPrezzi.map((v, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${v.descrizione}</td>
      <td class="center">${v.um}</td>
      <td class="right">${v.quantita}</td>
      <td class="right">€ ${fmt(v.prezzo_mercato)}</td>
      <td class="right"><strong>€ ${fmt(v.importo_mercato)}</strong></td>
    </tr>`).join('')

      const prevHtml = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><style>${cssCommon}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
    .info-box{background:#f8f9fa;padding:10px;border-radius:6px;border-left:3px solid #1e3a5f}
    .info-box strong{display:block;font-size:10px;color:#666;margin-bottom:2px}
  </style></head><body>
    <div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>Ingegneria, Costruzioni, Ponteggi — P.IVA 02087420762 — Villa d'Agri (PZ) — Ing. Raffaele Lentini</p></div>
    <h2>PREVENTIVO ESTIMATIVO N. ${numero}</h2>
    <div class="info-grid">
      <div class="info-box"><strong>Committente</strong>${committente}</div>
      <div class="info-box"><strong>Cantiere</strong>${indirizzo || comune}</div>
      <div class="info-box"><strong>Comune</strong>${comune}</div>
      <div class="info-box"><strong>Data</strong>${oggi}</div>
    </div>
    <p style="margin:10px 0"><strong>Oggetto:</strong> ${descrizione}</p>
    <table><thead><tr><th>N.</th><th>Lavorazione</th><th>U.M.</th><th>Q.tà</th><th>P.U.</th><th>Importo</th></tr></thead>
    <tbody>${prevVociHtml}
      <tr class="total-row"><td colspan="5">Subtotale lavori</td><td class="right">€ ${fmt(subtMercato)}</td></tr>
      <tr><td colspan="5">Spese generali (${(sgPerc * 100).toFixed(0)}%)</td><td class="right">€ ${fmt(sgMercato)}</td></tr>
      <tr><td colspan="5">Utile impresa (${(uiPerc * 100).toFixed(0)}%)</td><td class="right">€ ${fmt(uiMercato)}</td></tr>
      <tr class="total-row"><td colspan="5">Imponibile</td><td class="right">€ ${fmt(impMercato)}</td></tr>
      <tr><td colspan="5">IVA (${(ivaPerc * 100).toFixed(0)}%)</td><td class="right">€ ${fmt(ivaMercato)}</td></tr>
      <tr class="total-row" style="font-size:14px"><td colspan="5">TOTALE COMPLESSIVO</td><td class="right">€ ${fmt(totMercato)}</td></tr>
    </tbody></table>
    <div class="footer">Restruktura S.r.l. — Validità offerta: 60 giorni — Condizioni: 30% firma, 40% SAL, 30% collaudo</div>
  </body></html>`

      // ══════════════════════════════════════════════════════════
      // CME HTML — SOLO LAVORAZIONI, ZERO PERCENTUALI
      // Conforme a DPR 207/2010 Art. 32 e D.Lgs. 36/2023
      // ══════════════════════════════════════════════════════════
      const vociPrezziario = vociConPrezzi.filter(v => !v.is_nuovo_prezzo)
      const vociNP = vociConPrezzi.filter(v => v.is_nuovo_prezzo)

      const cmeRigheHtml = vociConPrezzi.map((v, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><code${v.is_nuovo_prezzo ? ' style="color:#c45500;font-weight:bold"' : ''}>${v.codice_prezziario}</code></td>
      <td>${v.desc_prezziario}${v.is_nuovo_prezzo ? ' <em style="color:#888;font-size:10px">(N.P.)</em>' : ''}</td>
      <td class="center">${v.um}</td>
      <td class="right">${v.quantita}</td>
      <td class="right">€ ${fmt(v.prezzo_prezziario)}</td>
      <td class="right"><strong>€ ${fmt(v.importo_prezziario)}</strong></td>
    </tr>`).join('')

      // Analisi Nuovi Prezzi (solo se ce ne sono)
      const analisiNPHtml = vociNP.length > 0 ? `
    <h2 style="margin-top:30px">ANALISI NUOVI PREZZI</h2>
    <p style="margin:5px 0;font-size:11px;color:#555">Art. 32 DPR 207/2010 — Voci non presenti nel Prezziario Regionale</p>
    <table>
      <thead><tr><th>Codice</th><th>Descrizione</th><th>Materiali</th><th>Manodopera</th><th>Noli/Trasp.</th><th>P.U.</th></tr></thead>
      <tbody>${vociNP.map(v => `
        <tr>
          <td><code style="color:#c45500;font-weight:bold">${v.codice_prezziario}</code></td>
          <td>${v.desc_prezziario}</td>
          <td class="right">€ ${fmt(v.analisi_prezzo?.materiali || 0)}</td>
          <td class="right">€ ${fmt(v.analisi_prezzo?.manodopera || 0)}</td>
          <td class="right">€ ${fmt(v.analisi_prezzo?.noli || 0)}</td>
          <td class="right"><strong>€ ${fmt(v.analisi_prezzo?.totale || v.prezzo_prezziario)}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>` : ''

      const cmeHtml = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><style>${cssCommon}</style></head><body>
    ${headerHtml}
    <h2>COMPUTO METRICO ESTIMATIVO</h2>
    <p><strong>Committente:</strong> ${committente} | <strong>Comune:</strong> ${comune} | <strong>Data:</strong> ${oggi}</p>
    <p style="margin:5px 0"><strong>Oggetto:</strong> ${descrizione}</p>
    <p style="margin:5px 0;font-size:11px"><strong>Prezziario:</strong> Regione ${regione.charAt(0).toUpperCase() + regione.slice(1)} 2025</p>

    <table>
      <thead><tr><th>N°</th><th>Codice</th><th>Descrizione</th><th>U.M.</th><th>Q.tà</th><th>P.U.</th><th>Importo</th></tr></thead>
      <tbody>
        ${cmeRigheHtml}
        <tr class="total-row" style="font-size:13px">
          <td colspan="6">TOTALE LAVORI A BASE D'ASTA</td>
          <td class="right">€ ${fmt(subtPrezziario)}</td>
        </tr>
      </tbody>
    </table>

    ${analisiNPHtml}

    <div class="footer">
      Restruktura S.r.l. — Conforme a DPR 207/2010 Art. 32 e D.Lgs. 36/2023<br>
      I Nuovi Prezzi (N.P.) sono soggetti a verifica del R.U.P.
    </div>
  </body></html>`

      // ══════════════════════════════════════════════════════════
      // DOCUMENTO 3 — QUADRO ECONOMICO (Art. 16 DPR 207/2010)
      // ══════════════════════════════════════════════════════════
      const qeHtml = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><style>${cssCommon}</style></head><body>
    ${headerHtml}
    <h2>QUADRO ECONOMICO</h2>
    <p><strong>Committente:</strong> ${committente} | <strong>Comune:</strong> ${comune} | <strong>Data:</strong> ${oggi}</p>
    <p style="margin:5px 0"><strong>Oggetto:</strong> ${descrizione}</p>
    <p style="margin:5px 0;font-size:11px">Art. 16 DPR 207/2010 — Rif. CME allegato</p>

    <table>
      <tbody>
        <tr><td colspan="2"><strong>A) LAVORI</strong></td><td></td></tr>
        <tr><td style="padding-left:20px" colspan="2">a.1) Lavori a base d'asta (da CME)</td><td class="right">€ ${fmt(subtPrezziario)}</td></tr>
        <tr><td style="padding-left:20px" colspan="2">a.2) Oneri della sicurezza (non soggetti a ribasso, 3%)</td><td class="right">€ ${fmt(oneriSic)}</td></tr>
        <tr class="total-row"><td colspan="2">TOTALE A) LAVORI</td><td class="right">€ ${fmt(totLavori)}</td></tr>

        <tr><td colspan="2"><strong>B) SOMME A DISPOSIZIONE DELL'AMMINISTRAZIONE</strong></td><td></td></tr>
        <tr><td style="padding-left:20px" colspan="2">b.1) Spese tecniche (progettazione, DL, coordinamento sicurezza, 10%)</td><td class="right">€ ${fmt(speseTecniche)}</td></tr>
        <tr><td style="padding-left:20px" colspan="2">b.2) Imprevisti (5%)</td><td class="right">€ ${fmt(imprevisti)}</td></tr>
        <tr class="total-row"><td colspan="2">TOTALE B) SOMME A DISPOSIZIONE</td><td class="right">€ ${fmt(totSommeDisp)}</td></tr>

        <tr><td colspan="2"><strong>C) IVA</strong></td><td></td></tr>
        <tr><td style="padding-left:20px" colspan="2">c.1) IVA su lavori (${(ivaPerc * 100).toFixed(0)}%)</td><td class="right">€ ${fmt(ivaLavori)}</td></tr>
        <tr><td style="padding-left:20px" colspan="2">c.2) IVA su somme a disposizione (${(ivaPerc * 100).toFixed(0)}%)</td><td class="right">€ ${fmt(ivaSomme)}</td></tr>

        <tr class="total-row" style="font-size:14px"><td colspan="2">TOTALE GENERALE (A + B + C)</td><td class="right">€ ${fmt(totQE)}</td></tr>
      </tbody>
    </table>

    <div class="footer">
      Restruktura S.r.l. — Le percentuali sono indicative e soggette a verifica del R.U.P.<br>
      Le somme a disposizione saranno adeguate in fase di progettazione esecutiva.
    </div>
  </body></html>`

      // ══════════════════════════════════════════════════════════
      // SALVATAGGIO CACHE SU SUPABASE (per evitare rigenerazione)
      // ══════════════════════════════════════════════════════════
      if (conversationId) {
        const docsToSave = [
          { name: `Preventivo - ${committente}`, content: prevHtml, doc_type: 'preventivo' },
          { name: `CME - ${committente}`, content: cmeHtml, doc_type: 'cme' },
          { name: `Quadro Economico - ${committente}`, content: qeHtml, doc_type: 'quadro_economico' },
        ]
        for (const doc of docsToSave) {
          const { error } = await supabase.from('documents').insert({
            name: doc.name,
            content: doc.content,
            conversation_id: conversationId,
            type: 'html',
            metadata: { source: 'genera_preventivo_completo', doc_type: doc.doc_type, committente, comune, numero },
          })
          if (error) console.error(`Cache save failed (${doc.doc_type}):`, error.message)
        }
      }

      // ── Confronto ──
      const diff = subtMercato - subtPrezziario
      const diffPerc = subtPrezziario > 0 ? ((diff / subtPrezziario) * 100).toFixed(1) : '—'
      const vociPrezziarioCount = vociPrezziario.length

      return `PREVENTIVO, CME E QUADRO ECONOMICO GENERATI CON SUCCESSO.

PREVENTIVO (prezzi di mercato):
~~~document
${prevHtml}
~~~

CME (prezziario ufficiale ${regione} 2025):
~~~document
${cmeHtml}
~~~

QUADRO ECONOMICO:
~~~document
${qeHtml}
~~~

RIEPILOGO:
- Totale preventivo (mercato): € ${fmt(subtMercato)}
- Totale CME (lavori a base d'asta): € ${fmt(subtPrezziario)}
- Differenza preventivo/CME: € ${fmt(diff)} (${diffPerc}%)
- Totale Quadro Economico: € ${fmt(totQE)}
- Voci trovate nel prezziario: ${vociPrezziarioCount}/${vociConPrezzi.length}
- Nuovi Prezzi: ${vociNP.length} (${vociNP.map(v => v.codice_prezziario).join(', ') || 'nessuno'})

IMPORTANTE: questi documenti sono ora salvati e NON possono essere rigenerati. Se servono modifiche, specificare esattamente quali voci o quantità cambiare.`
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

// ── SELF-AWARENESS — Il Cervellone conosce e modifica se stesso ──

const SELF_TOOLS: ToolDefinition[] = [
  {
    name: 'modifica_skill',
    description: 'Modifica le istruzioni di una skill/reparto. Salva la versione precedente per rollback.',
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'ID skill: studio_tecnico, segreteria, cantieri, marketing, clienti, self' },
        nuove_istruzioni: { type: 'string', description: 'Le nuove istruzioni complete per la skill' },
        motivo: { type: 'string', description: 'Perche stai modificando la skill' },
      },
      required: ['skill_id', 'nuove_istruzioni', 'motivo'],
    },
  },
  {
    name: 'cervellone_info',
    description: 'Mostra la tua configurazione attuale: modello AI, versione, tool disponibili, parametri. Usa questo tool quando qualcuno ti chiede "che modello sei?", "come funzioni?", "che tool hai?", o qualsiasi domanda su te stesso.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cervellone_check_aggiornamenti',
    description: 'Controlla se sono disponibili modelli Claude più recenti e aggiorna automaticamente la configurazione. Interroga l\'API Anthropic per la lista modelli disponibili, confronta con quelli in uso, e si auto-aggiorna ai migliori. Usa questo tool periodicamente o quando senti parlare di nuovi modelli Claude.',
    input_schema: {
      type: 'object',
      properties: {
        applica: {
          type: 'boolean',
          description: 'Se true, applica gli aggiornamenti trovati. Se false, mostra solo cosa cambierebbe (default: true)',
        },
      },
      required: [],
    },
  },
  {
    name: 'cervellone_modifica',
    description: 'Modifica la tua configurazione: cambia modello AI, parametri di thinking, versione, o aggiungi istruzioni personalizzate. Usa questo per auto-migliorarti o quando l\'Ingegnere ti chiede di cambiare qualcosa di te stesso.',
    input_schema: {
      type: 'object',
      properties: {
        chiave: {
          type: 'string',
          description: 'Chiave config da modificare: model_default, model_complex, model_digest, version, thinking_budget_default, thinking_budget_medium, thinking_budget_high, max_tokens_default, max_tokens_medium, max_tokens_high, prompt_extra, nome, descrizione',
        },
        valore: {
          type: 'string',
          description: 'Nuovo valore (stringa JSON). Es: "claude-opus-4-7" per modello, "200000" per thinking budget',
        },
        motivo: {
          type: 'string',
          description: 'Perché stai facendo questa modifica (viene salvato nel log)',
        },
      },
      required: ['chiave', 'valore', 'motivo'],
    },
  },
  {
    name: 'promuovi_modello',
    description: `Promuove un nuovo modello Claude a default (model_default). L'attuale default diventa stable di backup. SOLO admin. Usa quando Anthropic rilascia una nuova versione e l'hai testata. Esempio: "claude-opus-4-8" o "claude-opus-5".`,
    input_schema: {
      type: 'object' as const,
      properties: {
        new_default: {
          type: 'string',
          description: 'Identificatore modello, es. "claude-opus-4-8". Deve iniziare con "claude-".',
        },
      },
      required: ['new_default'],
    },
  },
]

async function executeSelfTools(name: string, input: Record<string, unknown>, _conversationId?: string): Promise<string | null> {
  switch (name) {
    case 'cervellone_info': {
      const { data: config } = await supabase
        .from('cervellone_config')
        .select('key, value, updated_at, updated_by')
        .order('key')

      if (!config?.length) return 'Configurazione non disponibile.'

      const configMap: Record<string, unknown> = {}
      for (const row of config) {
        configMap[row.key] = row.value
      }

      const toolNames = ALL_TOOLS.map(t => t.name)

      return `🧠 CERVELLONE — CONFIGURAZIONE ATTUALE

IDENTITÀ:
- Nome: ${configMap.nome || 'Cervellone'}
- Descrizione: ${configMap.descrizione || 'CEO digitale Restruktura'}
- Versione: ${configMap.version || '1.0.0'}

MODELLI AI:
- Conversazione standard: ${configMap.model_default}
- Task complessi (preventivi, relazioni, analisi): ${configMap.model_complex}
- Digestione documenti: ${configMap.model_digest}

PARAMETRI THINKING:
- Standard: budget ${configMap.thinking_budget_default}, max tokens ${configMap.max_tokens_default}
- Medio: budget ${configMap.thinking_budget_medium}, max tokens ${configMap.max_tokens_medium}
- Alto: budget ${configMap.thinking_budget_high}, max tokens ${configMap.max_tokens_high}

TOOL DISPONIBILI:
${toolNames.map(t => `- ${t}`).join('\n')}
- web_search (built-in Anthropic)

ISTRUZIONI EXTRA: ${configMap.prompt_extra || '(nessuna)'}

ULTIMA MODIFICA CONFIG:
${config.map(r => `- ${r.key}: aggiornato ${new Date(r.updated_at).toLocaleString('it')} da ${r.updated_by}`).join('\n')}

Puoi modificare qualsiasi parametro con il tool cervellone_modifica.`
    }

    case 'cervellone_check_aggiornamenti': {
      const applica = input.applica !== false // default true

      try {
        // Interroga l'API Anthropic per i modelli disponibili
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
        })

        if (!response.ok) {
          return `Errore API Anthropic: HTTP ${response.status}. Impossibile controllare modelli disponibili.`
        }

        const data = await response.json() as { data?: Array<{ id: string; display_name?: string; created_at?: string }> }
        const models = data.data || []

        if (!models.length) {
          return 'Nessun modello trovato dall\'API Anthropic.'
        }

        // Filtra solo i modelli Claude rilevanti (no embedding, no legacy)
        const claudeModels = models
          .filter(m => m.id.startsWith('claude-') && !m.id.includes('embed'))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

        // Trova il miglior modello per famiglia
        const findBest = (family: string) => {
          const candidates = claudeModels.filter(m => m.id.includes(family))
          // Ordina per versione (il più recente = id più alto alfabeticamente per modelli con stesso prefisso)
          return candidates[0]?.id || null
        }

        const bestOpus = findBest('opus')
        const bestSonnet = findBest('sonnet')
        const bestHaiku = findBest('haiku')

        // Leggi config attuale
        const { data: config } = await supabase
          .from('cervellone_config')
          .select('key, value')

        const configMap: Record<string, string> = {}
        if (config) {
          for (const row of config) {
            configMap[row.key] = String(row.value).replace(/"/g, '')
          }
        }

        const currentDefault = configMap.model_default || 'sconosciuto'
        const currentComplex = configMap.model_complex || 'sconosciuto'
        const currentDigest = configMap.model_digest || 'sconosciuto'

        // Strategia: default=miglior Sonnet, complex=miglior Opus, digest=miglior Sonnet
        const newDefault = bestSonnet || currentDefault
        const newComplex = bestOpus || bestSonnet || currentComplex
        const newDigest = bestSonnet || currentDigest

        const changes: Array<{ key: string; from: string; to: string }> = []
        if (newDefault !== currentDefault) changes.push({ key: 'model_default', from: currentDefault, to: newDefault })
        if (newComplex !== currentComplex) changes.push({ key: 'model_complex', from: currentComplex, to: newComplex })
        if (newDigest !== currentDigest) changes.push({ key: 'model_digest', from: currentDigest, to: newDigest })

        let report = `🔍 MODELLI CLAUDE DISPONIBILI (da API Anthropic):\n\n`
        report += `Opus: ${claudeModels.filter(m => m.id.includes('opus')).map(m => m.id).join(', ') || 'nessuno'}\n`
        report += `Sonnet: ${claudeModels.filter(m => m.id.includes('sonnet')).map(m => m.id).join(', ') || 'nessuno'}\n`
        report += `Haiku: ${claudeModels.filter(m => m.id.includes('haiku')).map(m => m.id).join(', ') || 'nessuno'}\n\n`

        report += `CONFIGURAZIONE ATTUALE:\n`
        report += `- model_default (conversazione): ${currentDefault}\n`
        report += `- model_complex (task pesanti): ${currentComplex}\n`
        report += `- model_digest (digestione file): ${currentDigest}\n\n`

        if (changes.length === 0) {
          report += `✅ SEI GIÀ AGGIORNATO — stai usando i modelli migliori disponibili.`
          return report
        }

        report += `📦 AGGIORNAMENTI DISPONIBILI:\n`
        for (const c of changes) {
          report += `- ${c.key}: ${c.from} → ${c.to}\n`
        }

        if (applica) {
          for (const c of changes) {
            await supabase
              .from('cervellone_config')
              .update({
                value: c.to,
                updated_by: `auto-update: ${c.from} → ${c.to}`,
              })
              .eq('key', c.key)
          }
          report += `\n✅ AGGIORNAMENTO APPLICATO — i nuovi modelli sono attivi dalla prossima richiesta.`

          // Notifica utente su Telegram + webchat (FIX W1.1: trasparenza cambi modello)
          const noticeLines = changes.map((c) => `• *${c.key}*: ${c.from} → *${c.to}*`).join('\n')
          const noticeText =
            `🆕 *Cervellone aggiornato a un nuovo modello AI*\n\n` +
            `${noticeLines}\n\n` +
            `Le capability del nuovo modello vengono rilevate automaticamente. ` +
            `Dalla prossima richiesta utilizzo i nuovi modelli.`
          await notifyModelChange(noticeText)

          // Invalida cache config + capability per pickup immediato
          try {
            const { invalidateConfigCache, invalidateModelCapsCache } = await import('./claude')
            invalidateConfigCache()
            invalidateModelCapsCache()
          } catch (err) {
            console.error('Cache invalidation failed (non-critical):', err)
          }
        } else {
          report += `\n⏸️ Aggiornamento NON applicato (modalità anteprima). Richiama con applica=true per applicare.`
        }

        return report

      } catch (err) {
        return `Errore durante il check aggiornamenti: ${(err as Error).message}`
      }
    }

    case 'cervellone_modifica': {
      const chiave = input.chiave as string
      const valore = input.valore as string
      const motivo = input.motivo as string

      const CHIAVI_VALIDE = [
        'model_default', 'model_complex', 'model_digest', 'version',
        'thinking_budget_default', 'thinking_budget_medium', 'thinking_budget_high',
        'max_tokens_default', 'max_tokens_medium', 'max_tokens_high',
        'prompt_extra', 'nome', 'descrizione',
      ]

      if (!CHIAVI_VALIDE.includes(chiave)) {
        return `Chiave "${chiave}" non valida. Chiavi disponibili: ${CHIAVI_VALIDE.join(', ')}`
      }

      // Parsa il valore come JSON
      let jsonValue: unknown
      try {
        jsonValue = JSON.parse(valore)
      } catch {
        // Se non è JSON valido, wrappa come stringa
        jsonValue = valore
      }

      const { error } = await supabase
        .from('cervellone_config')
        .update({
          value: jsonValue,
          updated_by: `cervellone: ${motivo.slice(0, 100)}`,
        })
        .eq('key', chiave)

      if (error) {
        return `Errore modifica config: ${error.message}`
      }

      // Notifica utente se cambiato un modello (FIX W1.1: trasparenza cambi modello)
      if (chiave.startsWith('model_')) {
        const noticeText =
          `🆕 *Cervellone aggiornato — modello cambiato manualmente*\n\n` +
          `• *${chiave}*: nuovo valore *${String(jsonValue).replace(/"/g, '')}*\n` +
          `• Motivo: ${motivo}\n\n` +
          `Le capability del nuovo modello vengono rilevate automaticamente. ` +
          `Dalla prossima richiesta utilizzo il nuovo modello.`
        await notifyModelChange(noticeText)
        try {
          const { invalidateConfigCache, invalidateModelCapsCache } = await import('./claude')
          invalidateConfigCache()
          invalidateModelCapsCache()
        } catch (err) {
          console.error('Cache invalidation failed (non-critical):', err)
        }
      }

      return `✅ CONFIGURAZIONE AGGIORNATA
- Chiave: ${chiave}
- Nuovo valore: ${JSON.stringify(jsonValue)}
- Motivo: ${motivo}

La modifica è attiva dalla prossima richiesta.`
    }

    case 'modifica_skill': {
      const skillId = input.skill_id as string
      const nuoveIstruzioni = input.nuove_istruzioni as string
      const motivo = input.motivo as string

      const { data: current } = await supabase
        .from('cervellone_skills')
        .select('istruzioni, versione')
        .eq('id', skillId)
        .single()

      if (!current) return `Skill "${skillId}" non trovata.`

      const { error } = await supabase
        .from('cervellone_skills')
        .update({
          istruzioni: nuoveIstruzioni,
          istruzioni_precedenti: current.istruzioni,
          versione: (current.versione || 1) + 1,
          updated_by: `cervellone: ${motivo.slice(0, 100)}`,
        })
        .eq('id', skillId)

      if (error) return `Errore modifica skill: ${error.message}`

      const { invalidateSkillCache } = await import('./skills')
      invalidateSkillCache()

      return `Skill "${skillId}" aggiornata (v${(current.versione || 1) + 1}). Motivo: ${motivo}`
    }

    case 'promuovi_modello': {
      try {
        const result = await promoteModel(input.new_default as string)
        return `🚀 Promozione completata.\nNuovo default: ${result.newDefault}\nNuovo stable: ${result.newStable}\nVecchio stable archiviato: ${result.oldStable}`
      } catch (err) {
        return `Errore promozione: ${err instanceof Error ? err.message : err}`
      }
    }

    default:
      return null
  }
}

// ── Registry ──

// FIX W1.3: wrapper per DRIVE_TOOLS che combacia signature con altri executor.
// Ritorna null se il tool non è un drive_*/sheets_*, altrimenti delega a executeDriveTool.
async function executeDriveWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('drive_') && !name.startsWith('sheets_') && name !== 'salva_documento_su_drive') return null
  // executeDriveTool aspetta Record<string, string>; serializzo se necessario.
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeDriveTool(name, stringInput)
}

// Self-healing 2026-05-04: wrapper per i tool GitHub + Vercel deploy status.
async function executeGithubWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'github_read_file' && name !== 'github_propose_fix' && name !== 'vercel_deploy_status') return null
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeGithubTool(name, stringInput)
}

// 2026-05-05: wrapper per il tool meteo (Open-Meteo, no API key).
async function executeWeatherWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'weather_now') return null
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeWeatherTool(name, stringInput)
}

const ALL_TOOLS: ToolDefinition[] = [
  ...STUDIO_TECNICO_TOOLS,
  ...SELF_TOOLS,
  ...DRIVE_TOOLS, // W1.3: 10 tool Drive/Sheets registrati
  ...GITHUB_TOOLS, // Self-healing 2026-05-04: github_read_file, github_propose_fix, vercel_deploy_status
  ...WEATHER_TOOLS, // 2026-05-05: weather_now via Open-Meteo
]
const EXECUTORS = [executeStudioTecnico, executeSelfTools, executeDriveWrapper, executeGithubWrapper, executeWeatherWrapper]

export function getToolDefinitions() {
  return [
    { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 },
    ...ALL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  ]
}

export async function executeTool(name: string, input: Record<string, unknown>, conversationId?: string): Promise<string> {
  for (const executor of EXECUTORS) {
    const result = await executor(name, input, conversationId)
    if (result !== null) return result
  }
  return `Tool "${name}" non riconosciuto.`
}

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
  {
    name: 'scarica_file_da_url',
    description: 'Scarica qualsiasi file da un URL pubblico (PDF, Word, Excel, ODS, immagini, CSV, ecc.) e restituisce il contenuto come testo o lo salva in memoria. Usa questo per scaricare documenti dal web.',
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
    description: 'Genera PREVENTIVO + CME in una sola chiamata. Cerca automaticamente le voci nel prezziario regionale, calcola tutto, produce 2 documenti HTML separati. Usa SEMPRE questo tool per preventivi — è molto più veloce di cercare le voci una per una.',
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

      // ── Cerca TUTTE le voci nel prezziario in batch (query dirette, no Claude) ──
      const vociConPrezzi: Array<{
        descrizione: string; quantita: number; um: string;
        prezzo_mercato: number; prezzo_prezziario: number | null;
        codice_prezziario: string | null; desc_prezziario: string | null;
        importo_mercato: number; importo_prezziario: number | null;
      }> = []

      for (const lav of lavorazioni) {
        const desc = lav.descrizione as string
        const qty = lav.quantita as number
        const um = lav.um as string
        const prezzoMercato = (lav.prezzo_mercato as number) || 0

        // Cerca nel prezziario con ILIKE
        let prezziarioMatch: { codice_voce: string; descrizione: string; prezzo: number } | null = null
        const words = desc.split(/\s+/).filter((w: string) => w.length > 3)

        // Prova prima con la descrizione completa
        const { data: d1 } = await supabase.from('prezziario')
          .select('codice_voce, descrizione, prezzo')
          .eq('regione', regione)
          .ilike('descrizione', `%${desc}%`)
          .limit(1)
        if (d1?.length) prezziarioMatch = d1[0]

        // Se non trova, prova parole singole
        if (!prezziarioMatch && words.length > 0) {
          for (const word of words.slice(0, 3)) {
            const { data: d2 } = await supabase.from('prezziario')
              .select('codice_voce, descrizione, prezzo')
              .eq('regione', regione)
              .ilike('descrizione', `%${word}%`)
              .limit(1)
            if (d2?.length) { prezziarioMatch = d2[0]; break }
          }
        }

        const importoMercato = Math.round(qty * prezzoMercato * 100) / 100
        const importoPrezziario = prezziarioMatch ? Math.round(qty * Number(prezziarioMatch.prezzo) * 100) / 100 : null

        vociConPrezzi.push({
          descrizione: desc, quantita: qty, um,
          prezzo_mercato: prezzoMercato,
          prezzo_prezziario: prezziarioMatch ? Number(prezziarioMatch.prezzo) : null,
          codice_prezziario: prezziarioMatch?.codice_voce || null,
          desc_prezziario: prezziarioMatch?.descrizione?.slice(0, 100) || null,
          importo_mercato: importoMercato,
          importo_prezziario: importoPrezziario,
        })
      }

      // ── Calcoli ──
      const subtMercato = vociConPrezzi.reduce((s, v) => s + v.importo_mercato, 0)
      const subtPrezziario = vociConPrezzi.reduce((s, v) => s + (v.importo_prezziario || 0), 0)
      const sgMercato = Math.round(subtMercato * sgPerc * 100) / 100
      const uiMercato = Math.round(subtMercato * uiPerc * 100) / 100
      const impMercato = subtMercato + sgMercato + uiMercato
      const ivaMercato = Math.round(impMercato * ivaPerc * 100) / 100
      const totMercato = Math.round((impMercato + ivaMercato) * 100) / 100

      const fmt = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

      // ── PREVENTIVO HTML ──
      const prevVociHtml = vociConPrezzi.map((v, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${v.descrizione}</td>
          <td class="center">${v.um}</td>
          <td class="right">${v.quantita}</td>
          <td class="right">€ ${fmt(v.prezzo_mercato)}</td>
          <td class="right"><strong>€ ${fmt(v.importo_mercato)}</strong></td>
        </tr>`).join('')

      const prevHtml = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#222;padding:30px}
        .header{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:20px;border-radius:8px;margin-bottom:20px}
        .header h1{font-size:20px;margin-bottom:4px}.header p{font-size:11px;opacity:0.8}
        h2{color:#1e3a5f;font-size:16px;margin:20px 0 10px;border-bottom:2px solid #1e3a5f;padding-bottom:4px}
        table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;font-size:11px}
        th{background:#1e3a5f;color:#fff;text-align:left}.right{text-align:right}.center{text-align:center}
        tr:nth-child(even){background:#f8f9fa}.total-row{background:#e8f0fe;font-weight:bold}
        .footer{margin-top:30px;font-size:10px;color:#888;border-top:1px solid #ddd;padding-top:10px}
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

      // ── CME HTML ──
      const cmeVociHtml = vociConPrezzi.map((v, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${v.codice_prezziario || '—'}</td>
          <td>${v.desc_prezziario || v.descrizione}</td>
          <td class="center">${v.um}</td>
          <td class="right">${v.quantita}</td>
          <td class="right">${v.prezzo_prezziario !== null ? '€ ' + fmt(v.prezzo_prezziario) : '—'}</td>
          <td class="right">${v.importo_prezziario !== null ? '€ ' + fmt(v.importo_prezziario) : '—'}</td>
        </tr>`).join('')

      const cmeHtml = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#222;padding:30px}
        .header{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:20px;border-radius:8px;margin-bottom:20px}
        .header h1{font-size:20px;margin-bottom:4px}.header p{font-size:11px;opacity:0.8}
        h2{color:#1e3a5f;font-size:16px;margin:20px 0 10px;border-bottom:2px solid #1e3a5f;padding-bottom:4px}
        table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;font-size:11px}
        th{background:#1e3a5f;color:#fff;text-align:left}.right{text-align:right}.center{text-align:center}
        tr:nth-child(even){background:#f8f9fa}.total-row{background:#e8f0fe;font-weight:bold}
        .footer{margin-top:30px;font-size:10px;color:#888;border-top:1px solid #ddd;padding-top:10px}
        .alert{background:#fff3cd;border:1px solid #ffc107;padding:8px;border-radius:4px;margin:10px 0;font-size:11px}
      </style></head><body>
        <div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>Ingegneria, Costruzioni, Ponteggi — P.IVA 02087420762 — Villa d'Agri (PZ) — Ing. Raffaele Lentini</p></div>
        <h2>COMPUTO METRICO ESTIMATIVO — Prezziario ${regione.toUpperCase()} 2025</h2>
        <p><strong>Committente:</strong> ${committente} | <strong>Comune:</strong> ${comune} | <strong>Data:</strong> ${oggi}</p>
        <p style="margin:5px 0"><strong>Oggetto:</strong> ${descrizione}</p>
        <table><thead><tr><th>N.</th><th>Codice</th><th>Descrizione (da prezziario)</th><th>U.M.</th><th>Q.tà</th><th>P.U. Prezziario</th><th>Importo</th></tr></thead>
        <tbody>${cmeVociHtml}
          <tr class="total-row"><td colspan="6">TOTALE CME (prezzi prezziario)</td><td class="right">€ ${fmt(subtPrezziario)}</td></tr>
        </tbody></table>
        <div class="alert">⚠️ Prezzi dal Prezziario Regionale ${regione.toUpperCase()} 2025 (DGR 208/2025). Le voci senza codice non sono state trovate nel prezziario.</div>
        <div class="footer">Restruktura S.r.l. — Documento tecnico ad uso interno</div>
      </body></html>`

      // ── Confronto ──
      const diff = subtMercato - subtPrezziario
      const diffPerc = subtPrezziario > 0 ? ((diff / subtPrezziario) * 100).toFixed(1) : '—'

      return `PREVENTIVO E CME GENERATI CON SUCCESSO.

PREVENTIVO (prezzi di mercato):
~~~document
${prevHtml}
~~~

CME (prezziario ufficiale ${regione} 2025):
~~~document
${cmeHtml}
~~~

CONFRONTO:
- Totale preventivo (mercato): € ${fmt(subtMercato)}
- Totale CME (prezziario): € ${fmt(subtPrezziario)}
- Differenza: € ${fmt(diff)} (${diffPerc}%)
- Voci trovate nel prezziario: ${vociConPrezzi.filter(v => v.codice_prezziario).length}/${vociConPrezzi.length}

Le voci senza codice prezziario non sono state trovate — verificare con termini diversi.`
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

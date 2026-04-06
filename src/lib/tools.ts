// Tool custom per il Cervellone
import { executeCalcolaPreventivo, PreventivoInput } from './tools/preventivo'
import { cercaPrezziario, countPrezziario } from './tools/prezziario'

export const CUSTOM_TOOLS = [
  {
    name: 'calcola_preventivo',
    description: 'Genera un preventivo estimativo professionale con calcoli precisi e output HTML.',
    input_schema: {
      type: 'object' as const,
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
    description: 'Cerca voci nel prezziario regionale salvato nel database. Usa questo tool per trovare codici voce e prezzi ufficiali. Puoi cercare per descrizione (es. "demolizione pavimento", "gres porcellanato", "massetto"). Ritorna codice voce, descrizione ufficiale, unità di misura e prezzo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        descrizione: { type: 'string', description: 'Parole chiave della lavorazione da cercare (es. "gres porcellanato", "demolizione pavimento")' },
        regione: { type: 'string', description: 'Regione del prezziario (default: basilicata)' },
      },
      required: ['descrizione'],
    },
  },
  {
    name: 'conta_prezziario',
    description: 'Verifica quante voci di prezziario sono disponibili per una regione. Usa per controllare se il prezziario è stato caricato.',
    input_schema: {
      type: 'object' as const,
      properties: {
        regione: { type: 'string', description: 'Regione da verificare' },
      },
      required: ['regione'],
    },
  },
]

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'calcola_preventivo':
      return executeCalcolaPreventivo(input as unknown as PreventivoInput)
    case 'cerca_prezziario': {
      const desc = input.descrizione as string
      const regione = (input.regione as string) || 'basilicata'
      // Cerca più risultati con query diverse
      const results = []
      const words = desc.split(/\s+/).filter(w => w.length > 3)

      // Cerca con full text search
      const result = await cercaPrezziario(desc, regione)
      if (result.found) {
        results.push(`✅ ${result.codice_voce} — ${result.descrizione_prezziario} — ${result.prezzo} €/${result.fonte}`)
      }

      // Cerca anche parole singole per più risultati
      for (const word of words.slice(0, 3)) {
        const r = await cercaPrezziario(word, regione)
        if (r.found && r.codice_voce !== result.codice_voce) {
          results.push(`✅ ${r.codice_voce} — ${r.descrizione_prezziario} — ${r.prezzo} €`)
        }
      }

      if (results.length > 0) {
        return `Trovate ${results.length} voci per "${desc}":\n${results.join('\n')}`
      }
      return `Nessuna voce trovata per "${desc}" nel prezziario ${regione}. Prova con parole chiave diverse.`
    }
    case 'conta_prezziario': {
      const regione = (input.regione as string) || 'basilicata'
      const result = await countPrezziario(regione)
      if (result.count > 0) {
        return `Prezziario ${result.regione} ${result.anno}: ${result.count} voci disponibili.`
      }
      return `Nessun prezziario caricato per ${regione}. Chiedere all'Ingegnere di caricare il file ODS.`
    }
    default:
      return `Tool "${name}" non riconosciuto.`
  }
}

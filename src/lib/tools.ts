// Tool custom per il Cervellone

import { executeCalcolaPreventivo, PreventivoInput } from './tools/preventivo'

export const CUSTOM_TOOLS = [
  {
    name: 'read_webpage',
    description: 'Leggi il contenuto di una pagina web specifica. Usa questo strumento quando hai un URL e vuoi leggerne il contenuto completo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL completo della pagina da leggere',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'calcola_preventivo',
    description: 'Genera un preventivo estimativo professionale con calcoli precisi, confronto prezziario regionale e output HTML. Usa SEMPRE questo tool quando devi generare un preventivo — non calcolare a mente. Il tool restituisce HTML completo da mettere in un blocco ~~~document.',
    input_schema: {
      type: 'object' as const,
      properties: {
        titolo: { type: 'string', description: 'Titolo del documento (default: Preventivo Estimativo)' },
        numero: { type: 'string', description: 'Numero preventivo (default: auto-generato)' },
        data: { type: 'string', description: 'Data in formato YYYY-MM-DD (default: oggi)' },
        committente: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            indirizzo: { type: 'string' },
            cf_piva: { type: 'string' },
            telefono: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['nome'],
        },
        cantiere: {
          type: 'object',
          properties: {
            indirizzo: { type: 'string' },
            comune: { type: 'string' },
            descrizione: { type: 'string' },
          },
          required: ['indirizzo', 'comune', 'descrizione'],
        },
        voci: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              descrizione: { type: 'string' },
              um: { type: 'string', description: 'Unita di misura: mq, mc, kg, ml, cad, a corpo' },
              quantita: { type: 'number' },
              prezzo_unitario: { type: 'number', description: 'Prezzo unitario in euro' },
              categoria: { type: 'string', description: 'Categoria per raggruppamento (es. Demolizioni, Strutture)' },
            },
            required: ['descrizione', 'um', 'quantita', 'prezzo_unitario'],
          },
        },
        coefficienti: {
          type: 'object',
          properties: {
            spese_generali: { type: 'number', description: 'Default 0.15 (15%)' },
            utile_impresa: { type: 'number', description: 'Default 0.10 (10%)' },
            oneri_sicurezza: { type: 'number', description: 'Default 0.025 (2.5%)' },
            iva: { type: 'number', description: 'Default 0.10 (10%)' },
          },
        },
        regione: { type: 'string', description: 'Regione per prezziario (default: basilicata)' },
        note: { type: 'array', items: { type: 'string' } },
        esclusioni: { type: 'array', items: { type: 'string' } },
        condizioni_pagamento: { type: 'string' },
        validita_offerta: { type: 'string' },
      },
      required: ['committente', 'cantiere', 'voci'],
    },
  },
]

// Leggi contenuto di una pagina web
async function executeReadWebpage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) return `Errore: ${res.status} ${res.statusText}`

    const html = await res.text()

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()

    const trimmed = text.length > 25000 ? text.slice(0, 25000) + '\n\n[...contenuto troncato]' : text
    return `Contenuto di ${url}:\n\n${trimmed}`
  } catch (err) {
    return `Errore lettura pagina: ${err}`
  }
}

// Esegui un tool custom
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read_webpage':
      return executeReadWebpage(input.url as string)
    case 'calcola_preventivo':
      return executeCalcolaPreventivo(input as unknown as PreventivoInput)
    default:
      return `Tool "${name}" non riconosciuto.`
  }
}

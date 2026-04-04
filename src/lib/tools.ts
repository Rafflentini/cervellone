// Tool custom per il Cervellone — SEMPLIFICATO
// Claude fa quasi tutto da solo. Questi tool sono solo per operazioni
// che richiedono calcoli precisi server-side.

import { executeCalcolaPreventivo, PreventivoInput } from './tools/preventivo'

export const CUSTOM_TOOLS = [
  {
    name: 'calcola_preventivo',
    description: 'Genera un preventivo estimativo professionale con calcoli precisi e output HTML. Usa questo tool quando devi generare un preventivo formale con voci, quantità e prezzi.',
    input_schema: {
      type: 'object' as const,
      properties: {
        titolo: { type: 'string', description: 'Titolo del documento' },
        numero: { type: 'string', description: 'Numero preventivo (auto-generato se omesso)' },
        data: { type: 'string', description: 'Data YYYY-MM-DD (oggi se omesso)' },
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
              um: { type: 'string' },
              quantita: { type: 'number' },
              prezzo_unitario: { type: 'number' },
              categoria: { type: 'string' },
            },
            required: ['descrizione', 'um', 'quantita', 'prezzo_unitario'],
          },
        },
        coefficienti: {
          type: 'object',
          properties: {
            spese_generali: { type: 'number' },
            utile_impresa: { type: 'number' },
            oneri_sicurezza: { type: 'number' },
            iva: { type: 'number' },
          },
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
]

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'calcola_preventivo':
      return executeCalcolaPreventivo(input as unknown as PreventivoInput)
    default:
      return `Tool "${name}" non riconosciuto.`
  }
}

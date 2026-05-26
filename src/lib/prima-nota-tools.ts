import { supabase } from './supabase'
import { createSpreadsheetInFolder } from './drive'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface MovimentoRow {
  id: string
  data: string
  importo: number
  direzione: 'entrata' | 'uscita'
  descrizione: string | null
  controparte: string | null
  fonte: string | null
  conto: string | null
  periodo: string
}

interface RiconciliazioneRow {
  movimento_id: string
  fattura_numero: string | null
  importo_abbinato: number | null
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload })
}

function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/\./g, '').replace(',', '.'))
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function money(value: unknown): number {
  return Math.round(parseNumber(value) * 100) / 100
}

async function generaPrimaNota(input: Record<string, unknown>): Promise<string> {
  const periodo = cleanString(input.periodo)
  const folderId = cleanString(input.folder_id)
  const saldoIniziale = money(input.saldo_iniziale)

  if (!periodo) return fail('periodo richiesto')
  if (!folderId) return fail('folder_id richiesto')

  const { data, error } = await supabase
    .from('cervellone_movimenti')
    .select('id, data, importo, direzione, descrizione, controparte, fonte, conto, periodo')
    .eq('periodo', periodo)
    .eq('stato', 'attivo')
    .order('data', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) return fail(error.message)
  const movimenti = (data ?? []) as MovimentoRow[]
  if (movimenti.length === 0) return fail(`nessun movimento per il periodo ${periodo}`)

  const movimentoIds = movimenti.map(row => row.id)
  const riconciliazioni = movimentoIds.length
    ? await supabase
      .from('cervellone_riconciliazioni')
      .select('movimento_id, fattura_numero, importo_abbinato')
      .in('movimento_id', movimentoIds)
      .eq('stato', 'confermata')
    : { data: [], error: null }

  if (riconciliazioni.error) return fail(riconciliazioni.error.message)

  const fattureByMovimento = new Map<string, string[]>()
  for (const row of (riconciliazioni.data ?? []) as RiconciliazioneRow[]) {
    if (!row.fattura_numero) continue
    const label = row.importo_abbinato
      ? `${row.fattura_numero} (${money(row.importo_abbinato)})`
      : row.fattura_numero
    const list = fattureByMovimento.get(row.movimento_id) ?? []
    list.push(label)
    fattureByMovimento.set(row.movimento_id, list)
  }

  const rows: (string | number)[][] = [[
    'Data',
    'Causale',
    'Controparte',
    'Entrata',
    'Uscita',
    'Saldo',
    'Conto/Fonte',
    'Rif. fattura',
    'Note',
  ]]

  let saldo = saldoIniziale
  let entrate = 0
  let uscite = 0

  for (const movimento of movimenti) {
    const importo = money(movimento.importo)
    const entrata = movimento.direzione === 'entrata' ? importo : 0
    const uscita = movimento.direzione === 'uscita' ? importo : 0
    entrate += entrata
    uscite += uscita
    saldo = Math.round((saldo + entrata - uscita) * 100) / 100

    rows.push([
      movimento.data,
      movimento.descrizione ?? '',
      movimento.controparte ?? '',
      entrata,
      uscita,
      saldo,
      [movimento.conto, movimento.fonte].filter(Boolean).join(' / '),
      (fattureByMovimento.get(movimento.id) ?? []).join(', '),
      saldoIniziale === 0 ? 'Saldo iniziale non indicato: saldo progressivo relativo.' : '',
    ])
  }

  const saldoFinale = Math.round((saldoIniziale + entrate - uscite) * 100) / 100
  rows.push(['', 'TOTALI', '', entrate, uscite, saldoFinale, '', '', ''])

  const sheet = await createSpreadsheetInFolder(`Prima Nota ${periodo}`, folderId, rows as string[][])
  return ok({
    url: sheet.webViewLink,
    periodo,
    movimenti: movimenti.length,
    entrate,
    uscite,
    saldo_finale: saldoFinale,
  })
}

export const PRIMA_NOTA_TOOLS: ToolDefinition[] = [
  {
    name: 'genera_prima_nota',
    description: 'Genera una Prima Nota mensile come Google Sheet nella cartella Drive indicata, usando movimenti e riconciliazioni confermate.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', description: 'Periodo contabile, es. 2026-05.' },
        folder_id: { type: 'string', description: 'ID cartella Drive dove creare il foglio.' },
        saldo_iniziale: { type: 'number', description: 'Saldo iniziale del periodo. Default 0.' },
      },
      required: ['periodo', 'folder_id'],
    },
  },
]

export async function executePrimaNotaTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name === 'genera_prima_nota') {
    try {
      return await generaPrimaNota(input)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
  return null
}

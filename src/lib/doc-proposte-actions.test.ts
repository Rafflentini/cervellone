import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * FIX 3 — il path AUTOMATICO (mail-sentinella -> proposta -> /conferma) scriveva
 * su cervellone_scadenze con un INSERT proprio: niente Calendar, niente
 * sostituzione della scadenza precedente, niente round-trip sulla data, niente
 * strip dei NUL byte, niente cap su reminder_days. Il suo dedup era `.eq`
 * case-sensitive, cioe lo stesso bug appena corretto in registra_scadenza.
 *
 * Questi test provano che ora la conferma passa dalla STESSA logica del path
 * manuale: validazione a monte (nessuna scrittura su una data inesistente),
 * sostituzione della precedente con la stessa chiave, evento in agenda.
 */

interface MockQueryResult {
  data: unknown
  error: { message: string } | null
}

type MockOpKind = 'none' | 'select' | 'insert' | 'update' | 'delete'

interface MockOp {
  table: string
  op: MockOpKind
  payload?: unknown
  filters: { method: string; args: unknown[] }[]
}

const mockOps: MockOp[] = []

class MockQueryBuilder implements PromiseLike<MockQueryResult> {
  private readonly rec: MockOp

  constructor(table: string) {
    this.rec = { table, op: 'none', filters: [] }
    mockOps.push(this.rec)
  }

  select(): this {
    if (this.rec.op === 'none') this.rec.op = 'select'
    return this
  }

  insert(payload: unknown): this {
    this.rec.op = 'insert'
    this.rec.payload = payload
    return this
  }

  update(payload: unknown): this {
    this.rec.op = 'update'
    this.rec.payload = payload
    return this
  }

  eq(...args: unknown[]): this { return this.addFilter('eq', args) }
  neq(...args: unknown[]): this { return this.addFilter('neq', args) }
  is(...args: unknown[]): this { return this.addFilter('is', args) }
  in(...args: unknown[]): this { return this.addFilter('in', args) }
  ilike(...args: unknown[]): this { return this.addFilter('ilike', args) }
  limit(...args: unknown[]): this { return this.addFilter('limit', args) }
  order(...args: unknown[]): this { return this.addFilter('order', args) }

  single(): Promise<MockQueryResult> { return Promise.resolve(mockHandler(this.rec)) }
  maybeSingle(): Promise<MockQueryResult> { return Promise.resolve(mockHandler(this.rec)) }

  then<TResult1 = MockQueryResult, TResult2 = never>(
    onfulfilled?: ((value: MockQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(mockHandler(this.rec)).then(onfulfilled, onrejected)
  }

  private addFilter(method: string, args: unknown[]): this {
    this.rec.filters.push({ method, args })
    return this
  }
}

interface ProposalFixture {
  id: string
  account: string
  uid: number
  folder: string
  attachment_filename: string
  drive_url: string | null
  tipo_documento: string | null
  soggetto: string | null
  data_scadenza: string | null
  stato: string
}

let proposta: ProposalFixture
let scadenzeEsistenti: unknown[] = []

const mockHandler = (op: MockOp): MockQueryResult => {
  if (op.table === 'cervellone_doc_proposte') {
    if (op.op === 'select') return { data: proposta, error: null }
    if (op.op === 'update') return { data: [{ id: proposta.id }], error: null }
  }
  if (op.table === 'cervellone_scadenze') {
    if (op.op === 'insert') return { data: { id: 'scadenza-nuova', reminder_days: 5 }, error: null }
    if (op.op === 'select') return { data: scadenzeEsistenti, error: null }
    if (op.op === 'update') return { data: null, error: null }
  }
  return { data: null, error: null }
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => new MockQueryBuilder(table) },
}))

vi.mock('@/v19/tools/email/get-email-body', () => ({
  getEmailBody: vi.fn(async () => ({
    uid: 42,
    folder: 'INBOX',
    message_id: null,
    from: 'ente@example.it',
    to: [],
    cc: [],
    subject: 'DURC',
    date: null,
    text: '',
    html: null,
    attachments: [
      {
        filename: 'durc.pdf',
        contentType: 'application/pdf',
        size: 1024,
        contentBase64: Buffer.from('pdf').toString('base64'),
      },
    ],
  })),
}))

vi.mock('@/lib/drive', () => ({
  DRIVE_FOLDERS: { DOC_IMPRESA: 'doc-impresa-id' },
  getOrCreatePathFolders: vi.fn(async () => 'folder-id'),
  uploadBinaryToDrive: vi.fn(async () => ({ id: 'file-id', webViewLink: 'https://drive.example/durc.pdf' })),
}))

const calendarCalls: { name: string; input: Record<string, unknown> }[] = []
vi.mock('./calendar-tools', () => ({
  executeCalendarTool: async (name: string, input: Record<string, unknown>) => {
    calendarCalls.push({ name, input })
    return 'OK Evento creato sul Google Calendar'
  },
  CALENDAR_TOOLS: [],
}))

function scadenzeOps(kind: MockOpKind): MockOp[] {
  return mockOps.filter(op => op.table === 'cervellone_scadenze' && op.op === kind)
}

async function conferma(): Promise<{ ok: boolean; message: string }> {
  const { confirmProposta } = await import('./doc-proposte-actions')
  return confirmProposta(proposta.id)
}

beforeEach(() => {
  mockOps.length = 0
  calendarCalls.length = 0
  scadenzeEsistenti = []
  proposta = {
    id: 'proposta-1',
    account: 'info',
    uid: 42,
    folder: 'INBOX',
    attachment_filename: 'durc.pdf',
    drive_url: null,
    tipo_documento: 'DURC',
    soggetto: 'Restruktura Srl',
    data_scadenza: '2027-01-31',
    stato: 'in_attesa',
  }
})

describe('confirmProposta — la scadenza automatica passa dalla stessa logica del path manuale (FIX 3)', () => {
  it('conferma normale: INSERT via registra_scadenza + evento in agenda', async () => {
    const res = await conferma()

    expect(res.ok).toBe(true)
    expect(scadenzeOps('insert')).toHaveLength(1)
    const payload = scadenzeOps('insert')[0].payload as Record<string, unknown>
    expect(payload.soggetto).toBe('Restruktura Srl')
    expect(payload.tipo_documento).toBe('DURC')
    expect(payload.data_scadenza).toBe('2027-01-31')
    expect(payload.drive_url).toBe('https://drive.example/durc.pdf')
    expect(payload.stato).toBe('attivo')
    // Il difetto centrale: il flusso automatico non finiva MAI in agenda.
    expect(calendarCalls).toHaveLength(1)
    expect(calendarCalls[0].name).toBe('calendar_create_event')
  })

  it('data inesistente (2027-02-31) → rifiutata PRIMA di scrivere su cervellone_scadenze', async () => {
    proposta.data_scadenza = '2027-02-31'

    const res = await conferma()

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/data_scadenza/i)
    expect(scadenzeOps('insert')).toHaveLength(0)
  })

  it('una scadenza precedente con la stessa chiave viene marcata sostituito', async () => {
    // Prima del fix il dedup era `.eq` case-sensitive su soggetto+data+drive_url:
    // il DURC rinnovato (data e link diversi) entrava come SECONDA riga attiva,
    // la vecchia restava attiva: due promemoria dal cron e il documento scaduto
    // ancora dichiarato valido da lista_scadenze.
    scadenzeEsistenti = [
      { id: 'durc-vecchio', soggetto: 'restruktura  srl', tipo_documento: 'durc', categoria: 'documenti' },
    ]

    const res = await conferma()
    expect(res.ok).toBe(true)

    const sostituzioni = scadenzeOps('update').filter(op => {
      const payload = op.payload as { stato?: string }
      return payload?.stato === 'sostituito'
    })
    expect(sostituzioni).toHaveLength(1)
    expect(sostituzioni[0].filters.find(f => f.method === 'in')?.args[1]).toEqual(['durc-vecchio'])
  })

  it('i NUL byte del soggetto estratto da OCR non arrivano a Postgres', async () => {
    proposta.soggetto = 'Restruktura\u0000 Srl'

    const res = await conferma()

    expect(res.ok).toBe(true)
    const payload = scadenzeOps('insert')[0].payload as { soggetto?: string }
    expect(payload.soggetto).toBe('Restruktura Srl')
    expect(payload.soggetto).not.toContain('\u0000')
  })
})

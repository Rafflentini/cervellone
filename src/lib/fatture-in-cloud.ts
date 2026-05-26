// src/lib/fatture-in-cloud.ts
// Integrazione Fatture in Cloud — SOLO LETTURA (sub-progetto A Amministrazione Contabile).
// Il modulo espone UNICAMENTE ficGet (HTTP GET): nessuna funzione POST/PUT/DELETE esiste,
// quindi la scrittura sul gestionale è impossibile per costruzione. La scrittura arriverà
// in un sub-progetto dedicato (F) con bozza + doppia conferma.

const FIC_BASE = 'https://api-v2.fattureincloud.it'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FicResult = { ok: true; data: any } | { ok: false; error: string }

let _companyId: string | null = null

export async function ficGet(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<FicResult> {
  const token = process.env.FIC_ACCESS_TOKEN
  if (!token) return { ok: false, error: 'FIC_ACCESS_TOKEN non configurato su Vercel.' }
  let url = FIC_BASE + path
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  console.log(`[FIC] GET ${path}`) // audit (mai loggare il token)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    if (res.status === 401) return { ok: false, error: 'Token FIC non valido/revocato: rigeneralo nelle Applicazioni collegate.' }
    if (res.status === 429) return { ok: false, error: 'Troppe richieste a Fatture in Cloud, riprova tra poco.' }
    if (!res.ok) return { ok: false, error: `Errore FIC ${res.status}: ${(await res.text()).slice(0, 200)}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function getCompanyId(): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (process.env.FIC_COMPANY_ID) return { ok: true, id: process.env.FIC_COMPANY_ID }
  if (_companyId) return { ok: true, id: _companyId }
  const r = await ficGet('/user/companies')
  if (!r.ok) return { ok: false, error: r.error }
  const companies = r.data?.data?.companies
  const first = Array.isArray(companies) && companies.length ? companies[0] : null
  if (!first?.id) return { ok: false, error: 'company_id non trovato in /user/companies' }
  _companyId = String(first.id)
  return { ok: true, id: _companyId }
}

// Costruisce un filtro data FIC (campo `q`) da anno/mese opzionali.
function buildDateQuery(anno?: number, mese?: number): string | undefined {
  if (!anno) return undefined
  const m = mese && mese >= 1 && mese <= 12 ? mese : undefined
  if (m) {
    const last = new Date(anno, m, 0).getDate()
    const mm = String(m).padStart(2, '0')
    return `date >= '${anno}-${mm}-01' and date <= '${anno}-${mm}-${last}'`
  }
  return `date >= '${anno}-01-01' and date <= '${anno}-12-31'`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDoc(d: any) {
  return {
    id: d?.id,
    numero: d?.number ?? d?.numeration ?? null,
    data: d?.date ?? null,
    soggetto: d?.entity?.name ?? null,
    totale: d?.amount_gross ?? d?.amountGross ?? d?.amount_net ?? d?.amountNet ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pagata: typeof d?.is_marked === 'boolean'
      ? d.is_marked
      : (Array.isArray(d?.payments_list ?? d?.paymentsList) ? (d.payments_list ?? d.paymentsList).every((p: any) => p?.status === 'paid') : null),
    scadenza: d?.next_due_date ?? d?.nextDueDate ?? d?.due_date ?? d?.dueDate ?? null,
  }
}

function intParam(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export const FIC_READ_TOOLS: ToolDefinition[] = [
  {
    name: 'fic_fatture_emesse',
    description: 'Elenca le fatture EMESSE da Fatture in Cloud (sola lettura). Filtri opzionali: anno, mese (1-12), cliente (nome), stato ("pagata"|"non_pagata"|"tutte"). Usa per "quali fatture ho emesso a maggio", "chi non mi ha pagato".',
    input_schema: {
      type: 'object',
      properties: {
        anno: { type: 'integer' },
        mese: { type: 'integer' },
        cliente: { type: 'string' },
        stato: { type: 'string', enum: ['pagata', 'non_pagata', 'tutte'] },
      },
    },
  },
  {
    name: 'fic_fatture_ricevute',
    description: 'Elenca le fatture RICEVUTE (spese/fornitori) da Fatture in Cloud (sola lettura). Filtri: anno, mese, fornitore. Usa per "fatture ricevute da registrare", "spese di aprile".',
    input_schema: {
      type: 'object',
      properties: { anno: { type: 'integer' }, mese: { type: 'integer' }, fornitore: { type: 'string' } },
    },
  },
  {
    name: 'fic_dettaglio_documento',
    description: 'Dettaglio completo di un documento Fatture in Cloud dato il suo id e il tipo ("emessa"|"ricevuta").',
    input_schema: {
      type: 'object',
      properties: { tipo: { type: 'string', enum: ['emessa', 'ricevuta'] }, id: { type: 'integer' } },
      required: ['tipo', 'id'],
    },
  },
  {
    name: 'fic_cerca_anagrafica',
    description: 'Cerca un cliente o fornitore in Fatture in Cloud per nome (sola lettura).',
    input_schema: {
      type: 'object',
      properties: { tipo: { type: 'string', enum: ['cliente', 'fornitore'] }, nome: { type: 'string' } },
      required: ['tipo', 'nome'],
    },
  },
]

export async function executeFicTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('fic_')) return null
  const company = await getCompanyId()
  if (!company.ok) return JSON.stringify({ ok: false, error: company.error })
  const cid = company.id

  try {
    if (name === 'fic_fatture_emesse') {
      const q = buildDateQuery(intParam(input.anno), intParam(input.mese))
      const r = await ficGet(`/c/${cid}/issued_documents`, { type: 'invoice', q, per_page: 50, sort: '-date' })
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let docs = (r.data?.data ?? []).map(mapDoc)
      const cliente = input.cliente ? String(input.cliente).toLowerCase() : ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (cliente) docs = docs.filter((d: any) => (d.soggetto || '').toLowerCase().includes(cliente))
      const stato = String(input.stato || 'tutte')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (stato === 'pagata') docs = docs.filter((d: any) => d.pagata === true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (stato === 'non_pagata') docs = docs.filter((d: any) => d.pagata === false)
      return JSON.stringify({ ok: true, count: docs.length, fatture: docs.slice(0, 50) })
    }
    if (name === 'fic_fatture_ricevute') {
      const q = buildDateQuery(intParam(input.anno), intParam(input.mese))
      const r = await ficGet(`/c/${cid}/received_documents`, { type: 'expense', q, per_page: 50, sort: '-date' })
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let docs = (r.data?.data ?? []).map(mapDoc)
      const forn = input.fornitore ? String(input.fornitore).toLowerCase() : ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (forn) docs = docs.filter((d: any) => (d.soggetto || '').toLowerCase().includes(forn))
      return JSON.stringify({ ok: true, count: docs.length, fatture: docs.slice(0, 50) })
    }
    if (name === 'fic_dettaglio_documento') {
      const id = intParam(input.id)
      if (!id) return JSON.stringify({ ok: false, error: 'id richiesto' })
      const seg = input.tipo === 'ricevuta' ? 'received_documents' : 'issued_documents'
      const typeQ = input.tipo === 'ricevuta' ? 'expense' : 'invoice'
      const r = await ficGet(`/c/${cid}/${seg}/${id}`, { type: typeQ, fieldset: 'detailed' })
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
      return JSON.stringify({ ok: true, documento: r.data?.data ?? r.data })
    }
    if (name === 'fic_cerca_anagrafica') {
      const nome = String(input.nome || '').trim()
      if (!nome) return JSON.stringify({ ok: false, error: 'nome richiesto' })
      const seg = input.tipo === 'fornitore' ? 'suppliers' : 'clients'
      const r = await ficGet(`/c/${cid}/entities/${seg}`, { q: `name contains '${nome.replace(/[\\']/g, '')}'`, per_page: 25 })
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (r.data?.data ?? []).map((e: any) => ({ id: e?.id, nome: e?.name, piva: e?.vat_number ?? e?.vatNumber, cf: e?.tax_code ?? e?.taxCode, email: e?.email }))
      return JSON.stringify({ ok: true, count: list.length, anagrafiche: list })
    }
    return JSON.stringify({ ok: false, error: `tool FIC sconosciuto: ${name}` })
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

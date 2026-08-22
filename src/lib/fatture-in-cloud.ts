// src/lib/fatture-in-cloud.ts
// Integrazione Fatture in Cloud — lettura + create/delete BOZZE.
// Il modulo espone ficGet per le letture e solo due operazioni write dedicate:
// creaDocumentoFIC ed eliminaDocumentoFIC. NESSUNA trasmissione SdI è implementata
// per costruzione: le creazioni forzano e_invoice:false e omettono sempre number.

import { getSocieta, type CodiceSocieta } from './societa'

const FIC_BASE = 'https://api-v2.fattureincloud.it'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FicResult = { ok: true; data: any } | { ok: false; error: string }
type FicCreateResult = { ok: true; id: string; url: string | null } | { ok: false; error: string }
type FicDeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Token FIC della società indicata. Null se la variabile non è configurata.
 *
 * Le due società hanno account Fatture in Cloud separati, quindi token distinti:
 * leggere un unico `FIC_ACCESS_TOKEN` significherebbe operare sempre sull'account
 * sbagliato per una delle due.
 */
export function getFicToken(societa: CodiceSocieta): string | null {
  return process.env[getSocieta(societa).ficTokenEnv] || null
}

/**
 * NB: `societa` è obbligatoria di proposito. Un default renderebbe possibile
 * chiamare senza dichiarare l'azienda, che è il difetto rimosso da questo task:
 * una chiamata futura finirebbe in silenzio sull'account sbagliato.
 */
export async function ficGet(
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  societa: CodiceSocieta,
): Promise<FicResult> {
  const s = getSocieta(societa)
  const token = getFicToken(societa)
  if (!token) return { ok: false, error: `${s.ficTokenEnv} non configurato su Vercel (${s.denominazione}).` }
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

/**
 * Id azienda su Fatture in Cloud per la società indicata.
 *
 * Il vecchio ripiego prendeva `companies[0]`, cioè la PRIMA azienda restituita
 * dall'API: una scelta fatta dall'ordine di risposta, non da noi. Rimosso.
 *
 * Ma toglierlo e basta spegnerebbe la contabilità di Restruktura, che oggi
 * funziona proprio grazie a quel ripiego (`FIC_COMPANY_ID` non è configurata in
 * produzione). Quindi il ripiego resta, in una forma che non può sbagliare:
 * **si accetta l'azienda solo se ne esiste UNA SOLA** sull'account. Con una
 * sola azienda non c'è scelta da fare; con due o più bisogna dichiararla,
 * perché li' sceglierne una a caso vuol dire emettere fatture da una partita
 * IVA sbagliata — e una fattura elettronica trasmessa non si cancella.
 *
 * Niente cache di modulo: la lettura è una variabile d'ambiente, e una cache
 * globale con due società restituirebbe l'id dell'altra.
 */
export async function getCompanyId(
  societa: CodiceSocieta,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const s = getSocieta(societa)
  const id = process.env[s.ficCompanyIdEnv]
  if (id) return { ok: true, id }

  const r = await ficGet('/user/companies', undefined, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const companies = r.data?.data?.companies
  const elenco = Array.isArray(companies) ? companies : []

  if (elenco.length === 1 && elenco[0]?.id) {
    return { ok: true, id: String(elenco[0].id) }
  }
  if (elenco.length > 1) {
    return {
      ok: false,
      error: `${s.ficCompanyIdEnv} non configurata e l'account ha ${elenco.length} aziende: `
        + `dichiara quale usare invece di lasciarlo decidere all'ordine della lista.`,
    }
  }
  return { ok: false, error: `nessuna azienda trovata su Fatture in Cloud per ${s.denominazione}.` }
}

export async function creaDocumentoFIC(
  payload: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<FicCreateResult> {
  const s = getSocieta(societa)
  const token = getFicToken(societa)
  if (!token) return { ok: false, error: `${s.ficTokenEnv} non configurato su Vercel (${s.denominazione}).` }

  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const { number: _number, ...payloadWithoutNumber } = payload
  void _number
  const forcedPayload = { ...payloadWithoutNumber, e_invoice: false }
  const path = `/c/${company.id}/issued_documents`
  console.log('[FIC] POST issued_documents') // audit (mai loggare il token)

  try {
    const res = await fetch(FIC_BASE + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ data: forcedPayload }),
    })
    if (res.status === 401) return { ok: false, error: 'Token FIC non valido/revocato: rigeneralo nelle Applicazioni collegate.' }
    if (res.status === 429) return { ok: false, error: 'Troppe richieste a Fatture in Cloud, riprova tra poco.' }
    if (!res.ok) return { ok: false, error: `Errore creazione bozza FIC ${res.status}: ${(await res.text()).slice(0, 300)}` }

    const json = await res.json()
    const data = json?.data ?? json
    const id = data?.id ? String(data.id) : ''
    if (!id) return { ok: false, error: 'Bozza FIC creata ma id documento non trovato nella risposta.' }
    const url = typeof data?.url === 'string' && data.url ? data.url : `https://secure.fattureincloud.it/issued_documents/${id}`
    return { ok: true, id, url }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function eliminaDocumentoFIC(
  id: string,
  societa: CodiceSocieta,
): Promise<FicDeleteResult> {
  const s = getSocieta(societa)
  const token = getFicToken(societa)
  if (!token) return { ok: false, error: `${s.ficTokenEnv} non configurato su Vercel (${s.denominazione}).` }

  const cleanId = String(id || '').trim()
  if (!cleanId) return { ok: false, error: 'id documento FIC richiesto' }

  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  console.log('[FIC] DELETE issued_documents') // audit (mai loggare il token)
  try {
    const res = await fetch(`${FIC_BASE}/c/${company.id}/issued_documents/${encodeURIComponent(cleanId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })
    if (res.status === 401) return { ok: false, error: 'Token FIC non valido/revocato: rigeneralo nelle Applicazioni collegate.' }
    if (res.status === 429) return { ok: false, error: 'Troppe richieste a Fatture in Cloud, riprova tra poco.' }
    if (!res.ok) return { ok: false, error: `Errore eliminazione bozza FIC ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
  const payments = d?.payments_list ?? d?.paymentsList
  const amountDue = d?.amount_due ?? d?.amountDue
  const amountGross = d?.amount_gross ?? d?.amountGross
  const pagata = typeof d?.is_marked === 'boolean'
    ? d.is_marked
    : (Array.isArray(payments)
        ? payments.every((p: { status?: unknown }) => p?.status === 'paid')
        : (amountDue === 0 && typeof amountGross === 'number' && amountGross > 0 ? true : null))

  return {
    id: d?.id,
    numero: d?.number ?? d?.numeration ?? null,
    data: d?.date ?? null,
    soggetto: d?.entity?.name ?? null,
    totale: amountGross ?? d?.amount_net ?? d?.amountNet ?? null,
    pagata,
    scadenza: d?.next_due_date ?? d?.nextDueDate ?? d?.due_date ?? d?.dueDate ?? null,
    residuo: amountDue ?? null,
    pagamenti_count: Array.isArray(payments) ? payments.length : 0,
  }
}

function intParam(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export const FIC_READ_TOOLS: ToolDefinition[] = [
  {
    name: 'fic_fatture_emesse',
    description: 'Elenca le fatture EMESSE da Fatture in Cloud (sola lettura). Filtri opzionali: anno, mese (1-12), cliente (nome), stato ("pagata"|"non_pagata"|"tutte"). Usa per "quali fatture ho emesso a maggio", "chi non mi ha pagato". Ritorna anche residuo (importo ancora dovuto) e pagamenti_count.',
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
    description: 'Elenca le fatture RICEVUTE (spese/fornitori) da Fatture in Cloud (sola lettura). Filtri: anno, mese, fornitore. Usa per "fatture ricevute da registrare", "spese di aprile". Ritorna anche residuo (importo ancora dovuto) e pagamenti_count.',
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
  societa: CodiceSocieta,
): Promise<string | null> {
  if (!name.startsWith('fic_')) return null
  const company = await getCompanyId(societa)
  if (!company.ok) return JSON.stringify({ ok: false, error: company.error })
  const cid = company.id

  try {
    if (name === 'fic_fatture_emesse') {
      const q = buildDateQuery(intParam(input.anno), intParam(input.mese))
      const r = await ficGet(`/c/${cid}/issued_documents`, { type: 'invoice', q, per_page: 50, sort: '-date', fieldset: 'detailed' }, societa)
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
      const r = await ficGet(`/c/${cid}/received_documents`, { type: 'expense', q, per_page: 50, sort: '-date', fieldset: 'detailed' }, societa)
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
      const r = await ficGet(`/c/${cid}/${seg}/${id}`, { type: typeQ, fieldset: 'detailed' }, societa)
      if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
      return JSON.stringify({ ok: true, documento: r.data?.data ?? r.data })
    }
    if (name === 'fic_cerca_anagrafica') {
      const nome = String(input.nome || '').trim()
      if (!nome) return JSON.stringify({ ok: false, error: 'nome richiesto' })
      const seg = input.tipo === 'fornitore' ? 'suppliers' : 'clients'
      const r = await ficGet(`/c/${cid}/entities/${seg}`, { q: `name contains '${nome.replace(/[\\']/g, '')}'`, per_page: 25 }, societa)
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

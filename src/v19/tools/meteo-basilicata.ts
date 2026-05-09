/**
 * Cervellone V19 — Tool scarica_bollettino_meteo_basilicata
 *
 * Scarica il bollettino di criticità ufficiale del Centro Funzionale
 * Decentrato (CFD) Regione Basilicata per una data specifica.
 * Fonte istituzionale vincolante per giustificare CIGO Eventi Meteo.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 9.2
 * Memoria: cervellone-bollettino-meteo-basilicata.md (vincolante)
 */

import type Anthropic from '@anthropic-ai/sdk'
import { BollettinoFetchError, BollettinoNotFoundError } from './meteo-basilicata.errors'

const CFD_BASE_URL = 'https://centrofunzionale.regione.basilicata.it/ew/ew_pdf/a'
const FILENAME_PREFIX = 'Bollettino_Criticita_Regione_Basilicata'
const USER_AGENT = 'Cervellone-Restruktura/1.0 (CIGO automation)'
const FETCH_TIMEOUT_MS = 15_000

export type BollettinoResult = {
  pdfUrl: string
  pdfBuffer: Buffer
  contentType: string
  fonte: 'CFD Basilicata'
  filename: string
  date: string // YYYY-MM-DD
}

export type ScaricaBollettinoOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Format data come "DD_MM_YYYY" — formato URL CFD Basilicata. */
function formatDateForUrl(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = String(date.getFullYear())
  return `${dd}_${mm}_${yyyy}`
}

/** Format data come "YYYY-MM-DD" — formato canonico. */
function formatDateIso(date: Date): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isPdfBuffer(buf: Buffer): boolean {
  return buf.length > 1000 && buf.subarray(0, 4).toString('ascii') === '%PDF'
}

export async function scaricaBollettinoBasilicata(
  date: Date,
  opts: ScaricaBollettinoOptions = {},
): Promise<BollettinoResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const ddmmyyyy = formatDateForUrl(date)
  const isoDate = formatDateIso(date)

  // Tenta sia .pdf (lowercase) che .PDF (uppercase) — CFD ha entrambi nello storico
  const candidates = [
    `${CFD_BASE_URL}/${FILENAME_PREFIX}_${ddmmyyyy}.pdf`,
    `${CFD_BASE_URL}/${FILENAME_PREFIX}_${ddmmyyyy}.PDF`,
  ]

  let lastError: unknown = null
  for (const url of candidates) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
        redirect: 'follow',
      })
      clearTimeout(timeout)
      if (!res.ok) {
        lastError = new BollettinoFetchError(
          `HTTP ${res.status} su ${url}`,
          url,
        )
        continue
      }
      const arrayBuf: ArrayBuffer = await res.arrayBuffer()
      const buf: Buffer = Buffer.from(arrayBuf)
      if (!isPdfBuffer(buf)) {
        lastError = new BollettinoFetchError(
          `Risposta non è un PDF valido (${buf.length} bytes, magic bytes: ${buf.subarray(0, 4).toString('ascii')})`,
          url,
        )
        continue
      }
      const filename = `Bollettino_Criticita_Basilicata_${isoDate}.pdf`
      return {
        pdfUrl: url,
        pdfBuffer: buf,
        contentType: res.headers.get('content-type') ?? 'application/pdf',
        fonte: 'CFD Basilicata',
        filename,
        date: isoDate,
      }
    } catch (err) {
      clearTimeout(timeout)
      lastError = err
    }
  }

  throw new BollettinoNotFoundError(
    `Bollettino CFD Basilicata non disponibile per ${ddmmyyyy}. ` +
      `Fallback: invia richiesta PEC a protezionecivile@cert.regione.basilicata.it. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    isoDate,
  )
}

export const SCARICA_BOLLETTINO_TOOL: Anthropic.Tool = {
  name: 'scarica_bollettino_meteo_basilicata',
  description:
    'Scarica il bollettino di criticità ufficiale del Centro Funzionale Decentrato (CFD) Regione Basilicata per una data specifica. Fonte istituzionale per giustificare CIGO Eventi Meteo (vincolante per Restruktura). Ritorna PDF + URL pubblico. Fallback se non disponibile: PEC protezione civile.',
  input_schema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'Data del bollettino in formato YYYY-MM-DD (es. "2026-04-08")',
      },
    },
    required: ['data'],
  },
}

export async function executeScaricaBollettino(input: { data: string }): Promise<string> {
  const date = new Date(input.data)
  if (isNaN(date.getTime())) {
    return `Errore: data non valida "${input.data}". Usa formato YYYY-MM-DD.`
  }
  try {
    const result = await scaricaBollettinoBasilicata(date)
    return JSON.stringify({
      ok: true,
      url: result.pdfUrl,
      filename: result.filename,
      bytes: result.pdfBuffer.length,
      fonte: result.fonte,
      date: result.date,
    })
  } catch (err) {
    if (err instanceof BollettinoNotFoundError) {
      return JSON.stringify({ ok: false, error: 'not_found', message: err.message, date: err.date })
    }
    if (err instanceof BollettinoFetchError) {
      return JSON.stringify({ ok: false, error: 'fetch_error', message: err.message, url: err.url })
    }
    return JSON.stringify({ ok: false, error: 'unknown', message: String(err) })
  }
}

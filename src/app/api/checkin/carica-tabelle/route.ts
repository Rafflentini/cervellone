/**
 * api/checkin/carica-tabelle — porta nel foglio le tabelle ufficiali della
 * Questura scaricate dal Portale Alloggiati.
 *
 * Esiste come operazione ripetibile, e non come cosa fatta una volta a mano,
 * perche' quelle tabelle cambiano: nascono stati, i comuni si fondono. Quando
 * l'Ingegnere scarichera' una versione nuova, la mettera' nella stessa cartella
 * e rilancera' questa — senza che nessuno debba ricordarsi come si faceva.
 *
 * Carica solo gli STATI. I comuni stanno nel codice: sono ottomila righe che
 * renderebbero il foglio lento proprio sul telefono, e nessuno le sfoglia.
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { getDrive } from '@/lib/drive'
import { foglioGoogle } from '@/lib/checkin/foglio-google'
import { leggiTutto } from '@/lib/checkin/foglio-google'
import {
  FOGLIO_CHECKIN_ID, SCHEDA_TABELLE, COL_TABELLE,
} from '@/lib/checkin/foglio-schema'

function autorizzato(header: string | null): boolean {
  const atteso = process.env.SETUP_SECRET
  if (!atteso || !header) return false
  const ricevuto = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

/** Le tabelle del Portale sono CSV: Codice, Descrizione, Provincia, DataFineVal. */
function leggiCsv(testo: string): Array<{ codice: string; nome: string; prov: string; fine: string }> {
  return testo
    .split(/\r?\n/)
    .slice(1) // intestazione
    .map((r) => r.split(','))
    .filter((c) => c.length >= 2 && c[0]?.trim() && c[1]?.trim())
    .map((c) => ({
      codice: c[0].trim(),
      nome: c[1].trim(),
      prov: (c[2] ?? '').trim(),
      fine: (c[3] ?? '').trim(),
    }))
}

export async function POST(req: NextRequest) {
  if (!autorizzato(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, errore: 'non autorizzato' }, { status: 401 })
  }

  const fileId = req.nextUrl.searchParams.get('file')?.trim()
  if (!fileId) {
    return NextResponse.json({ ok: false, errore: 'Indica il file Drive da leggere.' }, { status: 400 })
  }

  try {
    const drive = await getDrive()
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' })
    const testo = Buffer.from(res.data as ArrayBuffer).toString('utf8')

    const voci = leggiCsv(testo)
    if (voci.length === 0) {
      return NextResponse.json(
        { ok: false, errore: 'Il file non contiene righe leggibili (atteso CSV Codice,Descrizione,...).' },
        { status: 422 },
      )
    }

    // Si tengono ANCHE gli stati non piu' esistenti: chi e' nato in
    // Cecoslovacchia nel 1985 e' nato li', e il Portale vuole quel codice.
    const righe = voci.map((v) => [
      v.nome.toUpperCase(),
      '', // provincia: per gli stati non c'e'
      '', // codice catastale: non e' in queste tabelle
      v.codice,
      'STATO',
      v.fine ? `non piu esistente dal ${v.fine.split(' ')[0]}` : '',
    ])

    // Si riscrive la scheda intera: le tre righe di esempio dell'11 agosto
    // erano inventate — una attribuiva alla Germania il codice dell'Italia —
    // e lasciarle mescolate ai dati veri sarebbe peggio che toglierle.
    const intestazione = [...COL_TABELLE]
    await foglioGoogle.scrivi(FOGLIO_CHECKIN_ID, SCHEDA_TABELLE, [intestazione, ...righe])

    const dopo = await leggiTutto(FOGLIO_CHECKIN_ID, SCHEDA_TABELLE)

    return NextResponse.json({
      ok: true,
      lette: voci.length,
      attuali: voci.filter((v) => !v.fine).length,
      storiche: voci.filter((v) => v.fine).length,
      // Riletto dal foglio, non dedotto da cio' che abbiamo mandato.
      righeSulFoglio: Math.max(dopo.length - 1, 0),
      esempio: righe.find((r) => r[0] === 'GERMANIA') ?? righe[0],
    })
  } catch (err) {
    console.error('[CHECKIN] carica-tabelle fallito:', err)
    return NextResponse.json({ ok: false, errore: 'Non sono riuscito a leggere il file.' }, { status: 500 })
  }
}

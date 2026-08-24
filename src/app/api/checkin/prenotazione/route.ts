/**
 * api/checkin/prenotazione — crea la pratica e restituisce i collegamenti.
 *
 * Solo col token generale: la prenotazione la apre chi gestisce, non un ospite.
 *
 * Restituisce anche i link dei singoli ospiti, gia' pronti da girare. Servono
 * al caso descritto dall'Ingegnere: l'intestatario compila la propria scheda e
 * manda agli altri il pezzo che li riguarda, senza che nessuno veda i documenti
 * degli altri.
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { creaPrenotazione, type DatiPrenotazione } from '@/lib/checkin/pratica'
import { linkPrenotazione, linkOspite } from '@/lib/checkin/token-prenotazione'

function tokenGenerale(ricevuto: string | null): boolean {
  const atteso = process.env.CHECKIN_TOKEN
  if (!atteso || !ricevuto) return false
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

export async function POST(req: NextRequest) {
  if (!tokenGenerale(req.nextUrl.searchParams.get('k'))) {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

  let d: DatiPrenotazione
  try {
    d = (await req.json()) as DatiPrenotazione
  } catch {
    return NextResponse.json({ ok: false, errore: 'Dati non leggibili.' }, { status: 400 })
  }

  const errori: string[] = []
  if (!String(d.unita || '').trim()) errori.push("Indica l'unita.")
  if (!String(d.checkin || '').trim()) errori.push('Indica la data di check-in.')
  if (!String(d.checkout || '').trim()) errori.push('Indica la data di check-out.')

  const ospiti = Number(String(d.ospitiAttesi || '').trim())
  if (!Number.isInteger(ospiti) || ospiti < 1) {
    // Il numero di ospiti non e' un dato fra i tanti: e' il metro con cui si
    // stabilisce se la pratica e' completa. Senza, CHECKIN OK comparirebbe
    // anche con meta' delle schede.
    errori.push('Indica quanti ospiti sono attesi.')
  }

  if (errori.length > 0) return NextResponse.json({ ok: false, errori }, { status: 400 })

  try {
    const { id } = await creaPrenotazione(d, new Date())
    const base = req.nextUrl.origin

    return NextResponse.json({
      ok: true,
      id,
      link: linkPrenotazione(base, id),
      linkOspiti: Array.from({ length: ospiti }, (_, i) => ({
        progressivo: i + 1,
        link: linkOspite(base, id, i + 1),
      })),
    })
  } catch (err) {
    console.error('[CHECKIN] creazione prenotazione fallita:', err)
    return NextResponse.json({ ok: false, errore: 'Non sono riuscito a creare la prenotazione.' }, { status: 500 })
  }
}

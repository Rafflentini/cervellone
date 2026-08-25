/**
 * api/checkin/segna — spunta un adempimento su una prenotazione.
 *
 * Due sole cose, e sono i due gesti che restano UMANI:
 *
 *  - **Inviato Alloggiati.** Il programma sa quando ha generato il file; non
 *    sa se qualcuno l'ha poi caricato sul Portale. Quello e' un accesso con
 *    credenziali su un sito della Polizia di Stato, e finche' non c'e' la
 *    WebServiceKey lo fa una persona. La spunta dice che e' successo davvero.
 *  - **Stato fattura.** Serve a correggere a mano finche' il collegamento con
 *    Fatture in Cloud non esiste, e a tornare indietro dopo una nota di
 *    credito anche quando esistera'.
 *
 * Solo col token generale: una spunta che dichiara compiuto un adempimento
 * verso la Questura non e' cosa da ospiti.
 */

import { NextRequest, NextResponse } from 'next/server'
import { risolviAccesso } from '@/lib/checkin/accesso'
import { segnaSoggiorno } from '@/lib/checkin/pratica'
import { conStatoFattura } from '@/lib/checkin/segnature'
import { STATI_FATTURA, type StatoFattura } from '@/lib/checkin/archivio'

export async function POST(req: NextRequest) {
  const accesso = risolviAccesso(req.nextUrl.searchParams.get('k'), null, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }

  let corpo: { id?: string; alloggiati?: boolean; fattura?: string }
  try {
    corpo = await req.json()
  } catch {
    return NextResponse.json({ ok: false, errore: 'Dati non leggibili.' }, { status: 400 })
  }

  const id = String(corpo.id ?? '').trim()
  if (!id) return NextResponse.json({ ok: false, errore: 'Manca la prenotazione.' }, { status: 400 })

  /*
    Si costruisce SOLO cio' che e' stato chiesto esplicitamente.

    Un oggetto con tutti i campi, riempito con i valori di ripiego di quelli
    non passati, spunterebbe l'invio alla Questura ogni volta che si cambia lo
    stato di una fattura. Sarebbe una dichiarazione di adempimento fatta per
    distrazione del codice.
  */
  let campi: Record<string, string> = {}

  if (typeof corpo.alloggiati === 'boolean') {
    campi['Inviato Alloggiati'] = corpo.alloggiati ? 'SI' : 'NO'
  }

  if (corpo.fattura !== undefined) {
    const stato = String(corpo.fattura).trim().toUpperCase()
    if (!(STATI_FATTURA as readonly string[]).includes(stato)) {
      return NextResponse.json(
        { ok: false, errore: `Stato fattura non valido. Ammessi: ${STATI_FATTURA.join(', ')}.` },
        { status: 400 },
      )
    }
    // Passa da conStatoFattura perche' `Stato fattura` e `Fattura emessa`
    // devono restare in riga fra loro: si scrivono insieme o non si scrivono.
    campi = conStatoFattura(campi, stato as StatoFattura)
  }

  if (Object.keys(campi).length === 0) {
    return NextResponse.json({ ok: false, errore: 'Non hai chiesto di segnare niente.' }, { status: 400 })
  }

  try {
    const esito = await segnaSoggiorno(id, campi)
    if (!esito.ok) return NextResponse.json(esito, { status: 404 })
    return NextResponse.json({ ok: true, id, segnati: campi })
  } catch (err) {
    console.error('[CHECKIN] segnatura fallita:', err)
    return NextResponse.json({ ok: false, errore: 'Non sono riuscito a segnare.' }, { status: 500 })
  }
}

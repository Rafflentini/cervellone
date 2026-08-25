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
import { leggiConfig } from '@/lib/checkin/foglio-lettura'
import {
  inviaAvvisi, linkWhatsApp, messaggioOspite, messaggioConsegnaChiavi, chiConsegnaLeChiavi,
} from '@/lib/checkin/avvisi'

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
    const link = linkPrenotazione(base, id) ?? ''
    const linkGestione = `${base}/checkin/gestione?k=${encodeURIComponent(req.nextUrl.searchParams.get('k') ?? '')}`

    /*
      Chi consegna le chiavi va avvisata: e' lei che completa i dati mancanti al
      momento del riconoscimento, e senza saperlo si presenta senza sapere chi
      trovera'. I suoi recapiti stanno nel Config, non nel codice: cambiano
      quando cambia la persona.
    */
    const cfg = await leggiConfig()
    const consegnaChiavi = chiConsegnaLeChiavi(
      cfg.consegna_chiavi_nome ?? '',
      cfg.consegna_chiavi_telefono ?? '',
    )

    const testoOspite = messaggioOspite({ link, unita: d.unita, checkin: d.checkin })
    const testoConsegnaChiavi = messaggioConsegnaChiavi({
      linkGestione,
      unita: d.unita,
      checkin: d.checkin,
      checkout: d.checkout,
      ospiti,
      intestatario: d.intestatario ?? '',
    })

    // L'email all'ospite parte SOLO se l'indirizzo c'e': lasciarlo vuoto
    // spegne l'invio senza toccare il codice. Un avviso che non parte non deve
    // mai far fallire la creazione — la prenotazione e' il dato, l'avviso una
    // cortesia.
    const avvisi = await inviaAvvisi({
      emailOspite: d.email ?? '',
      oggettoOspite: 'Check-in — LA REAL ESTATE',
      testoOspite,
    })

    return NextResponse.json({
      ok: true,
      id,
      link,
      linkGestione,
      // I collegamenti che aprono WhatsApp gia' sulla persona giusta: un tocco,
      // e nessun rischio di mandarlo al contatto sbagliato.
      whatsappOspite: linkWhatsApp(d.telefono ?? '', testoOspite),
      // Una voce per ciascuna delle ragazze indicate nel Config: chi consegna
      // le chiavi non e' sempre la stessa persona, e non ha una email.
      consegnaChiavi: consegnaChiavi.map((c) => ({
        ...c,
        whatsapp: linkWhatsApp(c.telefono, testoConsegnaChiavi),
      })),
      avvisi,
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

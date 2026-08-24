/**
 * api/checkin/registra — riceve un check-in dal form e lo scrive sul foglio.
 *
 * Questa route e' PUBBLICA per necessita': la compila l'ospite dal proprio
 * telefono, o la ragazza che consegna le chiavi. Non c'e' un login da chiedere
 * a un turista tedesco alle undici di sera.
 *
 * Quello che raccoglie sono dati personali di terzi — nome, data e luogo di
 * nascita, tipo e numero del documento. Le difese sono quindi quattro, e nessuna
 * e' facoltativa:
 *
 *  1. un token nel collegamento: senza, non si entra. Si revoca cambiando una
 *     variabile d'ambiente, senza toccare il codice;
 *  2. si scrive soltanto. Questa route non restituisce MAI un soggiorno: non
 *     esiste modo di sfogliare gli ospiti gia' registrati;
 *  3. un limite di frequenza per indirizzo;
 *  4. i dati vanno solo sul foglio, che sta in un Drive privato. Niente copie,
 *     e i messaggi di errore non ripetono mai un dato personale.
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { rateLimit } from '@/lib/rate-limiter'
import { appendSheet } from '@/lib/drive'
import { registraCheckin, type PayloadCheckin } from '@/lib/checkin/registrazione'
import {
  leggiConfig, regoleDaConfig, leggiTabelle, cercatoreCatastale,
} from '@/lib/checkin/foglio-lettura'
import {
  FOGLIO_CHECKIN_ID, SCHEDA_SOGGIORNI, SCHEDA_OSPITI,
} from '@/lib/checkin/foglio-schema'

/** Fail-closed: senza token configurato il form non si apre a nessuno. */
export function tokenValido(ricevuto: string | null): boolean {
  const atteso = process.env.CHECKIN_TOKEN
  if (!atteso || !ricevuto) return false
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

export async function POST(req: NextRequest) {
  if (!tokenValido(req.nextUrl.searchParams.get('k'))) {
    return NextResponse.json({ ok: false, errori: ['Collegamento non valido.'] }, { status: 401 })
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'ignoto'
  if (!rateLimit(`checkin_${ip}`, 60_000, 6)) {
    return NextResponse.json(
      { ok: false, errori: ['Troppe registrazioni in poco tempo. Attendi un minuto.'] },
      { status: 429 },
    )
  }

  let payload: PayloadCheckin
  try {
    payload = (await req.json()) as PayloadCheckin
  } catch {
    return NextResponse.json({ ok: false, errori: ['Dati non leggibili.'] }, { status: 400 })
  }

  try {
    const [cfg, tabelle] = await Promise.all([leggiConfig(), leggiTabelle()])

    const esito = registraCheckin(payload, {
      ora: new Date(),
      cercaCatastale: cercatoreCatastale(tabelle),
      regole: regoleDaConfig(cfg),
    })

    if (!esito.ok) {
      return NextResponse.json({ ok: false, errori: esito.errori, avvisi: esito.avvisi }, { status: 400 })
    }

    // Prima gli ospiti, poi il soggiorno. Se la seconda scrittura fallisce
    // restano righe orfane in Ospiti — visibili e recuperabili. Nell'ordine
    // opposto resterebbe un soggiorno SENZA ospiti: fatturabile, e con la
    // comunicazione alla Questura mancante senza che nulla lo dica.
    if (esito.righeOspiti.length > 0) {
      await appendSheet(FOGLIO_CHECKIN_ID, `'${SCHEDA_OSPITI}'!A:A`, esito.righeOspiti)
    }
    await appendSheet(FOGLIO_CHECKIN_ID, `'${SCHEDA_SOGGIORNI}'!A:A`, [esito.rigaSoggiorno])

    return NextResponse.json({
      ok: true,
      id: esito.id,
      notti: esito.rigaSoggiorno[7],
      imposta: esito.rigaSoggiorno[21],
      avvisi: esito.avvisi,
    })
  } catch (err) {
    // Il dettaglio va nei log del server, non all'ospite: potrebbe contenere
    // frammenti dei dati inviati.
    console.error('[CHECKIN] registrazione fallita:', err)
    return NextResponse.json(
      { ok: false, errori: ['Non sono riuscito a salvare. Riprova, e se insiste avvisa l Ingegnere.'] },
      { status: 500 },
    )
  }
}

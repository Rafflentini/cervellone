/**
 * api/checkin/pratica — legge e salva una pratica di check-in.
 *
 * GET  → cosa deve mostrare il form a chi ha quel collegamento
 * POST → salva quello che e' stato compilato, per quel che il livello consente
 *
 * Due regole che valgono per entrambe:
 *
 *  - **si restituisce solo cio' che quel livello puo' vedere.** Un ospite che
 *    non e' l'intestatario non riceve le schede degli altri: sono documenti
 *    d'identita' di persone che non si conoscono fra loro, e il link gira su
 *    WhatsApp;
 *  - **il permesso si decide qui**, sul server. Quello che il browser mostra o
 *    nasconde non e' una difesa.
 */

import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limiter'
import { risolviAccesso } from '@/lib/checkin/accesso'
import { leggiPratica, salvaPratica, eliminaPratica } from '@/lib/checkin/pratica'
import { linkScaduto, linkOspite } from '@/lib/checkin/token-prenotazione'
import { CAMPI_DELLA_PRENOTAZIONE, oscuraRiservati } from '@/lib/checkin/merge-pratica'

function parametri(req: NextRequest) {
  const s = req.nextUrl.searchParams
  return {
    k: s.get('k'), p: s.get('p'), t: s.get('t'), o: s.get('o'),
  }
}

function ip(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'ignoto'
}

export async function GET(req: NextRequest) {
  const { k, p, t, o } = parametri(req)
  const accesso = risolviAccesso(k, p, t, o)
  if (!accesso.ok) return NextResponse.json({ ok: false, errore: accesso.motivo }, { status: 401 })
  if (!accesso.id) return NextResponse.json({ ok: false, errore: 'Prenotazione non indicata.' }, { status: 400 })

  if (!rateLimit(`pratica_get_${ip(req)}`, 60_000, 40)) {
    return NextResponse.json({ ok: false, errore: 'Troppe richieste.' }, { status: 429 })
  }

  const pratica = await leggiPratica(accesso.id)
  if (!pratica) return NextResponse.json({ ok: false, errore: 'Prenotazione non trovata.' }, { status: 404 })

  // Una pratica chiusa da un pezzo non ha motivo di restare apribile. Il
  // gestore entra comunque: a lui puo' servire riaprirla.
  if (accesso.livello.tipo !== 'gestore' && linkScaduto(pratica.soggiorno['Check-out'] ?? '', new Date())) {
    return NextResponse.json({ ok: false, errore: 'Collegamento scaduto.' }, { status: 410 })
  }

  const miaScheda = accesso.livello.tipo === 'ospite' ? accesso.livello.progressivo : null

  /*
    I collegamenti delle singole schede servono ANCHE all'ospite intestatario:
    e' lui che li gira agli altri, dal telefono, mentre compila. Finche' li
    vedeva solo chi gestisce, il flusso restava a meta' — l'ospite non aveva
    modo di mandare all'ospite 2 la sua parte.
    Non concede niente di nuovo: l'intestatario puo' gia' scrivere in tutte le
    schede. A un singolo ospite invece non si danno: lui vede solo la propria.
  */
  /*
    Un collegamento per ogni scheda che ESISTE, piu' quelli che servono ad
    arrivare al numero di ospiti prenotati.

    Non "uno per ogni numero da 1 a N": i progressivi non sono contigui. Basta
    aver tolto un ospite perche' restino, per esempio, l'1 e il 3 — e generando
    1, 2, 3 per posizione all'ospite numero 3 si mandava il collegamento della
    scheda 2. Quell'ospite avrebbe compilato, e caricato il proprio documento
    d'identita', sulla scheda di un altro.
  */
  const esistenti = pratica.ospiti
    .map((o) => Number(String(o.dati['Progressivo'] ?? '').trim()))
    .filter((n) => Number.isInteger(n) && n > 0)

  const numeri = new Set(esistenti)
  const attesi = Math.max(Number(pratica.soggiorno['N. ospiti'] || 0), 1)
  // I numeri mancanti per arrivare agli attesi: i piu' bassi ancora liberi,
  // cosi' chi non ha ancora compilato riceve un collegamento comunque.
  for (let n = 1; numeri.size < attesi && n < attesi + esistenti.length + 1; n++) numeri.add(n)

  const linkOspiti = miaScheda
    ? []
    : [...numeri].sort((a, b) => a - b).map((n) => ({
      progressivo: n,
      link: linkOspite(req.nextUrl.origin, pratica.id, n),
    }))

  return NextResponse.json({
    linkOspiti,
    ok: true,
    id: pratica.id,
    livello: accesso.livello.tipo,
    ...(miaScheda ? { mioProgressivo: miaScheda } : {}),
    campiBloccati: accesso.livello.tipo === 'gestore' ? [] : CAMPI_DELLA_PRENOTAZIONE,
    // L'importo non esce affatto verso un ospite: nasconderlo nella pagina lo
    // lascerebbe leggibile dagli strumenti del browser.
    soggiorno: oscuraRiservati(pratica.soggiorno, accesso.livello),
    // Un ospite qualsiasi vede SOLO la propria scheda.
    ospiti: pratica.ospiti
      .filter((x) => miaScheda === null || Number(x.dati['Progressivo']) === miaScheda)
      .map((x) => x.dati),
  })
}

export async function POST(req: NextRequest) {
  const { k, p, t, o } = parametri(req)
  const accesso = risolviAccesso(k, p, t, o)
  if (!accesso.ok) return NextResponse.json({ ok: false, errore: accesso.motivo }, { status: 401 })
  if (!accesso.id) return NextResponse.json({ ok: false, errore: 'Prenotazione non indicata.' }, { status: 400 })

  if (!rateLimit(`pratica_post_${ip(req)}`, 60_000, 20)) {
    return NextResponse.json({ ok: false, errore: 'Troppi salvataggi in poco tempo.' }, { status: 429 })
  }

  let corpo: {
    soggiorno?: Record<string, string>
    ospiti?: Array<Record<string, string>>
    /**
     * I numeri delle schede che chi salva ha esplicitamente TOLTO.
     *
     * Uno per uno, e non "tutte quelle che non ti sto mandando": una pagina
     * aperta da mezz'ora non sa chi ha compilato nel frattempo, e dedurre le
     * cancellazioni dall'assenza le farebbe sparire. Chi non nomina un ospite
     * non lo tocca.
     */
    tolti?: string[]
  }
  try {
    corpo = await req.json()
  } catch {
    return NextResponse.json({ ok: false, errore: 'Dati non leggibili.' }, { status: 400 })
  }

  try {
    const esito = await salvaPratica(
      accesso.id,
      corpo.soggiorno ?? {},
      Array.isArray(corpo.ospiti) ? corpo.ospiti : [],
      accesso.livello,
      undefined,
      { tolti: Array.isArray(corpo.tolti) ? corpo.tolti.map(String) : [] },
    )
    if (!esito) return NextResponse.json({ ok: false, errore: 'Prenotazione non trovata.' }, { status: 404 })
    return NextResponse.json(esito)
  } catch (err) {
    // Il dettaglio nei log del server: potrebbe contenere dati degli ospiti.
    console.error('[CHECKIN] salvataggio pratica fallito:', err)
    return NextResponse.json(
      { ok: false, errore: 'Non sono riuscito a salvare. Riprova.' },
      { status: 500 },
    )
  }
}

/**
 * Cancella una prenotazione e le sue schede ospite.
 *
 * Solo il gestore: un ospite non deve poter far sparire la propria pratica —
 * e con essa la comunicazione alla Questura — premendo un pulsante.
 */
export async function DELETE(req: NextRequest) {
  const { k, p } = parametri(req)
  const accesso = risolviAccesso(k, p, null, null)
  if (!accesso.ok || accesso.livello.tipo !== 'gestore') {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 401 })
  }
  if (!accesso.id) {
    return NextResponse.json({ ok: false, errore: 'Prenotazione non indicata.' }, { status: 400 })
  }

  try {
    const esito = await eliminaPratica(accesso.id)
    return NextResponse.json(esito, { status: esito.ok ? 200 : 409 })
  } catch (err) {
    console.error('[CHECKIN] eliminazione pratica fallita:', err)
    return NextResponse.json({ ok: false, errore: 'Non sono riuscito a cancellare.' }, { status: 500 })
  }
}

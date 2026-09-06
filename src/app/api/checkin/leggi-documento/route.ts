/**
 * api/checkin/leggi-documento — i dati letti dalla foto del documento.
 *
 * Restituisce dei SUGGERIMENTI e non scrive NIENTE: ne' sul foglio, ne' su
 * Drive. Serve a risparmiare la fatica di ricopiare a mano dodici campi da una
 * carta d'identita', non a decidere cosa va alla Questura.
 *
 * ── Le tre difese ────────────────────────────────────────────────────────────
 * 1. Si legge solo una foto che e' GIA' stata caricata su questa pratica, e la
 *    si prende dalla cella del foglio: non si accetta un'immagine dal corpo
 *    della richiesta, altrimenti questa diventerebbe una scrivania di lettura
 *    documenti aperta a chiunque abbia un collegamento valido.
 * 2. Un ospite puo' leggere solo la PROPRIA scheda, come per tutto il resto.
 * 3. C'e' un limite di frequenza: ogni lettura e' una chiamata a pagamento, e
 *    una pagina lasciata aperta con un difetto la ripeterebbe all'infinito.
 */

import { NextRequest, NextResponse } from 'next/server'
import { risolviAccesso } from '@/lib/checkin/accesso'
import { leggiPratica } from '@/lib/checkin/pratica'
import { leggiDocumento } from '@/lib/checkin/lettura-documento'
import { downloadFileBase64 } from '@/lib/drive'
import { rateLimit } from '@/lib/rate-limiter'

/** La lettura di un'immagine puo' prendersi qualche secondo. */
export const maxDuration = 60

function ip(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'ignoto'
}

export async function POST(req: NextRequest) {
  const s = req.nextUrl.searchParams
  const accesso = risolviAccesso(s.get('k'), s.get('p'), s.get('t'), s.get('o'))
  if (!accesso.ok) {
    return NextResponse.json({ ok: false, errore: accesso.motivo }, { status: 401 })
  }
  if (!accesso.id) {
    return NextResponse.json({ ok: false, errore: 'Prenotazione non indicata.' }, { status: 400 })
  }

  const prog = Number(s.get('prog') ?? 0)
  const lato = s.get('lato') === 'retro' ? 'retro' : 'fronte'
  if (!Number.isInteger(prog) || prog < 1) {
    return NextResponse.json({ ok: false, errore: 'Scheda non indicata.' }, { status: 400 })
  }

  // Un ospite legge solo la propria scheda. Stessa regola di tutto il resto.
  if (accesso.livello.tipo === 'ospite' && accesso.livello.progressivo !== prog) {
    return NextResponse.json({ ok: false, errore: 'Non autorizzato.' }, { status: 403 })
  }

  // Sei letture al minuto per chi chiede: piu' che sufficienti per una
  // famiglia, e abbastanza poche perche' un difetto non svuoti un budget.
  if (!rateLimit(`leggi_doc_${ip(req)}`, 60_000, 6)) {
    return NextResponse.json(
      { ok: false, errore: 'Troppe letture ravvicinate. Aspetta un momento.' },
      { status: 429 },
    )
  }

  try {
    const pratica = await leggiPratica(accesso.id)
    if (!pratica) {
      return NextResponse.json({ ok: false, errore: 'Prenotazione non trovata.' }, { status: 404 })
    }

    const scheda = pratica.ospiti.find(
      (o) => Number(String(o.dati['Progressivo'] ?? '').trim()) === prog,
    )
    const fileId = String(scheda?.dati[lato === 'retro' ? 'Doc retro' : 'Doc fronte'] ?? '').trim()
    if (!fileId) {
      return NextResponse.json(
        { ok: false, errore: `Non c'e ancora nessuna foto del ${lato}: caricala prima.` },
        { status: 400 },
      )
    }

    const { base64, mimeType } = await downloadFileBase64(fileId)
    const esito = await leggiDocumento(base64, String(mimeType || '').toLowerCase())

    return NextResponse.json(esito, { status: esito.ok ? 200 : 422 })
  } catch (err) {
    // Il dettaglio nei log: puo' contenere dati di una persona.
    console.error('[CHECKIN] lettura documento fallita:', err)
    return NextResponse.json(
      { ok: false, errore: 'Non sono riuscito a leggere la foto. Compila a mano.' },
      { status: 500 },
    )
  }
}

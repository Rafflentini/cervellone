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
import { leggiPratica, salvaPratica } from '@/lib/checkin/pratica'
import { linkScaduto } from '@/lib/checkin/token-prenotazione'
import { CAMPI_DELLA_PRENOTAZIONE } from '@/lib/checkin/merge-pratica'

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

  return NextResponse.json({
    ok: true,
    id: pratica.id,
    livello: accesso.livello.tipo,
    ...(miaScheda ? { mioProgressivo: miaScheda } : {}),
    campiBloccati: accesso.livello.tipo === 'gestore' ? [] : CAMPI_DELLA_PRENOTAZIONE,
    soggiorno: pratica.soggiorno,
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

  let corpo: { soggiorno?: Record<string, string>; ospiti?: Array<Record<string, string>> }
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

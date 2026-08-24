/**
 * api/checkin/comuni — ricerca fra i comuni italiani, per la tendina del form.
 *
 * Perche' una ricerca sul server e non l'elenco intero nel browser: sono 7904
 * comuni, cioe' circa 280 KB da scaricare su un telefono, magari in cantiere
 * con una tacca di segnale, per poi usarne uno. Si cerca dalla terza lettera e
 * si ricevono venti voci.
 *
 * Nessun dato personale passa da qui: e' un elenco di comuni. Ma resta dietro
 * il token, perche' non c'e' motivo di offrire un servizio di ricerca aperto a
 * chiunque su un dominio che ne ospita altri.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cercaComuni, etichetta } from '@/lib/checkin/comuni'
import { tokenValido } from '../registra/route'

export async function GET(req: NextRequest) {
  if (!tokenValido(req.nextUrl.searchParams.get('k'))) {
    return NextResponse.json({ ok: false, comuni: [] }, { status: 401 })
  }

  const q = req.nextUrl.searchParams.get('q') ?? ''

  return NextResponse.json({
    ok: true,
    comuni: cercaComuni(q, 20).map((c) => ({
      // `e` e' cio' che si legge nell'elenco, `n` cio' che finisce nel foglio.
      e: etichetta(c),
      n: c.nome,
      p: c.sigla,
      cap: c.cap,
    })),
  })
}

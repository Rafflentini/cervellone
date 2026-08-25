/**
 * api/checkin/prepara-foglio — prepara le schede del foglio di check-in.
 *
 * Perche' una route e non solo lo strumento del bot: la preparazione del foglio
 * e' un'operazione di messa in opera, e non deve dipendere dal modello. Il 24
 * agosto il bot era fermo per credito Anthropic esaurito — se l'unica via fosse
 * stata chiedere a lui, il foglio sarebbe rimasto vuoto per una ragione che con
 * il foglio non c'entra niente.
 *
 * L'operazione e' ripetibile senza danno (vedi foglio-init.ts): rilanciarla su
 * un foglio gia' in uso non tocca un dato.
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { inizializzaFoglioCheckin } from '@/lib/checkin/foglio-init'
import { foglioGoogle } from '@/lib/checkin/foglio-google'
import { FOGLIO_CHECKIN_ID } from '@/lib/checkin/foglio-schema'

/** Confronto a tempo costante, e chiuso se il segreto non e' configurato. */
function autorizzato(header: string | null): boolean {
  const atteso = process.env.SETUP_SECRET
  // Fail-closed: senza segreto configurato la route non si apre a nessuno,
  // altrimenti basterebbe inviare "Bearer undefined".
  if (!atteso) return false
  if (!header) return false

  const ricevuto = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

export async function POST(req: NextRequest) {
  if (!autorizzato(req.headers.get('authorization'))) {
    return NextResponse.json({ ok: false, errore: 'non autorizzato' }, { status: 401 })
  }

  const foglioId = req.nextUrl.searchParams.get('foglio_id')?.trim() || FOGLIO_CHECKIN_ID

  const esito = await inizializzaFoglioCheckin(foglioId, foglioGoogle)

  return NextResponse.json(
    {
      ok: esito.ok,
      foglio_id: foglioId,
      url: `https://docs.google.com/spreadsheets/d/${foglioId}`,
      schede_create: esito.create,
      schede_gia_pronte: esito.giaPronte,
      // Cosa e' CAMBIATO, non solo che e' andata bene. Su un foglio gia' in
      // uso l'esito sarebbe sempre "tutte gia' pronte" — una risposta vera che
      // non dice niente, e che nasconderebbe una colonna o una riga nuova non
      // aggiunta.
      colonne_aggiunte: esito.colonneAggiunte,
      righe_aggiunte: esito.righeAggiunte,
      ...(esito.errore ? { errore: esito.errore } : {}),
    },
    { status: esito.ok ? 200 : 500 },
  )
}

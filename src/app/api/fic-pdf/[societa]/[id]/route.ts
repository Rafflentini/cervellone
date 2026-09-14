import { NextRequest } from 'next/server'
import { isDocAccessAllowed } from '@/lib/doc-access'
import { chiaveLinkPdf, pdfDocumentoEmesso } from '@/lib/fic-allegato'
import { listaSocieta, type CodiceSocieta } from '@/lib/societa'

/**
 * GET /api/fic-pdf/[societa]/[id] — il PDF di un documento EMESSO su Fatture
 * in Cloud (fattura, autofattura/integrazione, nota di credito), per
 * RIVEDERLO prima di trasmetterlo allo SdI.
 *
 * Stesso identico schema di accesso di `/api/doc/[id]`: cookie di sessione
 * OPPURE collegamento firmato (`?t=…&exp=…`), verificato da `isDocAccessAllowed`.
 * Un documento fiscale porta dentro i dati di clienti veri: **nessun accesso
 * senza un token valido**, e il token nel link SCADE (la durata la decide chi
 * firma, `fic-pdf-tools.ts`).
 *
 * Perche' un LINK e non il file dentro la conversazione: su Telegram
 * Cervellone sa mandare SOLO testo (`telegram-helpers.ts` ha `sendMessage` e
 * il download degli allegati in arrivo, non `sendDocument`), e i tool
 * ricevono `conversationId`, non l'id della chat Telegram. Un link invece si
 * apre uguale sui due canali — ed e' la regola di casa che vale piu' della
 * comodita': Telegram e chat web sono equipollenti.
 *
 * ⚠️ Il file NON si salva da nessuna parte: si scarica da FIC al momento e si
 * passa. La tabella `documents` contiene HTML, non PDF binari.
 *
 * 🚨 Questa rotta LEGGE. Non modifica il documento, non lo trasmette allo SdI,
 * non lo cancella.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ societa: string; id: string }> },
) {
  const { societa, id } = await params

  // ⚠️ L'ACCESSO SI CONTROLLA PER PRIMO, sui pezzi GREZZI dell'indirizzo.
  //
  // Validare prima (societa esistente? id numerico?) vorrebbe dire rispondere
  // 404 o 400 a chi non ha alcun diritto di sapere nemmeno quello: un estraneo
  // imparerebbe quali codici societa esistono provandoli. La chiave firmata e'
  // fatta delle stesse stringhe che il tool ha firmato, quindi una richiesta
  // legittima combacia e una qualunque altra prende 401 e basta.
  const chiave = chiaveLinkPdf(societa, id)
  const cookieToken = request.cookies.get('cervellone_auth')?.value
  const url = new URL(request.url)
  const shareToken = url.searchParams.get('t') ?? undefined
  const expRaw = url.searchParams.get('exp')
  const exp = expRaw ? Number(expRaw) : undefined

  if (!isDocAccessAllowed({ id: chiave, cookieToken, shareToken, exp })) {
    return testo('Accesso non autorizzato', 401)
  }

  // La societa non si "riconosce" e non si indovina: o e' uno dei codici del
  // registro, o non e'. `listaSocieta()` e' l'unica fonte — una lista scritta
  // a mano qui diventerebbe la seconda copia che poi diverge.
  const codice = listaSocieta().map((s) => s.codice).find((c) => c === societa) as CodiceSocieta | undefined
  if (!codice) return testo(`Societa sconosciuta: ${societa}`, 404)

  const numeroId = Number(id)
  if (!Number.isInteger(numeroId) || numeroId <= 0) {
    return testo(`Id documento non valido: ${id}`, 400)
  }

  const esito = await pdfDocumentoEmesso(numeroId, codice)
  if (!esito.ok) {
    // SE NON SI LEGGE, SI DICE — con il motivo vero, non con un «documento non
    // disponibile» generico. Lo stato distingue le due cose che l'Ingegnere
    // deve poter distinguere: 404 = su Fatture in Cloud quel file non c'e';
    // 502 = c'e' e NOI non siamo riusciti a prenderlo (lo stato HTTP di FIC e
    // il motivo stanno scritti nel corpo).
    return testo(esito.messaggio, esito.motivo === 'nessun_url' ? 404 : 502)
  }

  return new Response(new Uint8Array(esito.buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      // `inline`: si apre nel visualizzatore del telefono, che e' quello che
      // serve per CONTROLLARE una fattura. Il nome e' gia' setacciato in
      // `nomeFilePdf` (solo [A-Za-z0-9._-]): nessun a capo puo' entrare qui
      // dentro e spezzare l'intestazione.
      'Content-Disposition': `inline; filename="${esito.meta.nome_file}"`,
      // Un documento fiscale non si lascia in nessuna cache condivisa.
      'Cache-Control': 'private, no-store',
    },
  })
}

function testo(messaggio: string, status: number): Response {
  return new Response(messaggio, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

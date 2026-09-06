/**
 * api/checkin/manifest — la carta d'identita' dell'app, per chi la "installa".
 *
 * ── Perche' esiste (6 settembre 2026) ────────────────────────────────────────
 * Il gestionale si apre da un indirizzo con dentro il token. Va benissimo per
 * un collegamento in chat, ma quando qualcuno lo aggiunge alla schermata home
 * del telefono succede una cosa precisa: Android non usa l'indirizzo aperto,
 * usa lo `start_url` scritto QUI. Con un manifesto statico l'icona aprirebbe
 * `/checkin/gestione` senza token — cioe' una pagina che non autorizza — e
 * sembrerebbe che "l'app non funziona piu'".
 *
 * Quindi il manifesto si genera con dentro il token di chi lo sta chiedendo.
 *
 * Non e' un buco: il token qui non si crea e non si indovina, si RIFLETTE.
 * Chi non ce l'ha gia' ottiene un manifesto senza `start_url` privato, e
 * l'icona che ne nasce porta al gestionale che chiedera' un collegamento
 * valido. Il token, del resto, e' gia' nell'indirizzo della pagina, nella
 * cronologia del browser e nella chat da cui e' arrivato: il manifesto non
 * aggiunge un posto dove possa finire.
 */

import { NextRequest, NextResponse } from 'next/server'
import { risolviAccesso } from '@/lib/checkin/accesso'

export async function GET(req: NextRequest) {
  const k = req.nextUrl.searchParams.get('k')
  const accesso = risolviAccesso(k, null, null, null)
  const valido = accesso.ok && accesso.livello.tipo === 'gestore'

  const start = valido
    ? `/checkin/gestione?k=${encodeURIComponent(k as string)}`
    : '/checkin/gestione'

  return NextResponse.json(
    {
      name: 'Check-in — LA Real Estate',
      // Sotto l'icona ci stanno pochi caratteri: quello che si legge davvero.
      short_name: 'Check-in',
      description: 'Prenotazioni, schede ospiti, Portale Alloggiati e imposta di soggiorno.',
      lang: 'it-IT',
      start_url: start,
      // `scope` sulla cartella e non sull'indirizzo con la firma: altrimenti
      // ogni collegamento di ogni ospite cadrebbe fuori dall'app installata e
      // si aprirebbe in una finestra del browser a parte.
      scope: '/checkin/',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#ffffff',
      // Il bordeaux del marchio: colora la barra di sistema quando l'app e'
      // aperta dall'icona, cosi' non sembra una pagina web capitata li'.
      theme_color: '#713d54',
      icons: [
        { src: '/checkin/icona-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/checkin/icona-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        // `maskable`: Android ritaglia l'icona a cerchio o a goccia secondo il
        // telefono. Il monogramma sta dentro il 60% centrale proprio perche'
        // nessun ritaglio possa tagliarlo.
        { src: '/checkin/icona-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        // Contiene il token di chi l'ha chiesto: non deve finire in nessuna
        // cache condivisa fra persone diverse.
        'Cache-Control': 'private, no-store',
      },
    },
  )
}

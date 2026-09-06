/**
 * /checkin/gestione — l'involucro.
 *
 * La pagina vera e' in `gestionale.tsx` e gira nel browser. Qui resta solo la
 * parte che DEVE stare sul server: le informazioni che il telefono legge
 * quando qualcuno aggiunge il gestionale alla schermata home.
 *
 * ── Perche' (6 settembre 2026) ───────────────────────────────────────────────
 * Luciana lavora dal gestionale e non dal foglio. Il collegamento le arriva su
 * WhatsApp, e da li' se lo deve poter fissare come icona sul telefono e sul
 * computer, e ritrovarlo senza cercarlo. Perche' l'icona nasca col marchio e
 * col nome giusto — invece che con la miniatura della pagina e la scritta
 * "cervellone-five.vercel.app" — servono un titolo, un'icona e un manifesto,
 * e devono essere nell'HTML che il server manda, non aggiunti dopo dal
 * browser: Safari legge quei dati nel momento esatto in cui si tocca
 * "Aggiungi alla schermata Home".
 *
 * Il manifesto porta con se' il token perche' e' lui a stabilire che cosa apre
 * l'icona: senza, l'icona aprirebbe una pagina che non autorizza. Il perche'
 * per esteso sta in `api/checkin/manifest`.
 */

import type { Metadata } from 'next'
import Gestionale from './gestionale'

export const viewport = {
  // Colora la barra di sistema del bordeaux del marchio quando l'app e'
  // aperta dall'icona.
  themeColor: '#713d54',
}

export async function generateMetadata(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
): Promise<Metadata> {
  const k = (await searchParams).k
  const token = typeof k === 'string' ? k : ''
  const manifest = token
    ? `/api/checkin/manifest?k=${encodeURIComponent(token)}`
    : '/api/checkin/manifest'

  return {
    title: 'Check-in — LA Real Estate',
    description: 'Prenotazioni, schede ospiti, Portale Alloggiati e imposta di soggiorno.',
    manifest,
    // Su iPhone: il nome sotto l'icona e la finestra senza barre del browser.
    appleWebApp: { capable: true, title: 'Check-in', statusBarStyle: 'default' },
    icons: {
      icon: [
        { url: '/checkin/icona-192.png', sizes: '192x192', type: 'image/png' },
        { url: '/checkin/icona-512.png', sizes: '512x512', type: 'image/png' },
      ],
      apple: [{ url: '/checkin/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    /*
      Fuori dai motori di ricerca. La pagina e' protetta dal token e non dal
      login, quindi l'unica cosa che la tiene al riparo e' che nessuno ne
      conosca l'indirizzo: indicizzarla sarebbe pubblicarlo.
    */
    robots: { index: false, follow: false },
  }
}

export default function Pagina() {
  return <Gestionale />
}

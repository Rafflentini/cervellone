/**
 * Titolo e icona comuni a tutte le pagine del check-in.
 *
 * Senza questo, la linguetta del browser e il segnalibro dicevano
 * "Cervellone" — il nome del programma, non quello che l'ospite ha davanti.
 * Chi riceve il collegamento su WhatsApp e lo salva fra i preferiti si
 * ritrovava una voce che non gli dice niente, e chi lo fissa sulla schermata
 * home un'icona vuota.
 *
 * Le pagine che hanno qualcosa di piu' preciso da dire lo sovrascrivono:
 * `gestione` (che porta anche il manifesto col token) e `privacy`.
 */

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Check-in — LA Real Estate',
  description: 'Registrazione degli ospiti per il soggiorno.',
  icons: {
    icon: [
      { url: '/checkin/icona-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/checkin/icona-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/checkin/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // Il modulo si apre solo col collegamento: indicizzarlo vorrebbe dire
  // pubblicare l'indirizzo che lo protegge.
  robots: { index: false, follow: false },
}

export const viewport = { themeColor: '#713d54' }

export default function LayoutCheckin({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

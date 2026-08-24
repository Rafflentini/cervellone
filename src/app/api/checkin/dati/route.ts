/**
 * api/checkin/dati — cosa serve al form per disegnarsi: le unita', i parametri
 * dell'imposta per il calcolo dal vivo, e l'elenco dei luoghi.
 *
 * Restituisce SOLO dati di configurazione. Nessun soggiorno, nessun ospite:
 * questa route non e' una finestra su chi ha dormito dove.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  leggiConfig, regoleDaConfig, unitaDaConfig, leggiTabelle,
} from '@/lib/checkin/foglio-lettura'
import { tokenValido } from '../registra/route'

export async function GET(req: NextRequest) {
  if (!tokenValido(req.nextUrl.searchParams.get('k'))) {
    return NextResponse.json({ ok: false, errore: 'Collegamento non valido.' }, { status: 401 })
  }

  try {
    const [cfg, tabelle] = await Promise.all([leggiConfig(), leggiTabelle()])

    return NextResponse.json({
      ok: true,
      ragioneSociale: cfg.ragione_sociale || 'LA REAL ESTATE SRLS',
      unita: unitaDaConfig(cfg),
      regole: regoleDaConfig(cfg),
      comuni: tabelle.filter((t) => t.tipo === 'COMUNE').map((t) => ({ n: t.denominazione, p: t.provincia })),
      stati: tabelle.filter((t) => t.tipo === 'STATO').map((t) => ({ n: t.denominazione })),
    })
  } catch (err) {
    console.error('[CHECKIN] lettura configurazione fallita:', err)
    return NextResponse.json({ ok: false, errore: 'Configurazione non leggibile.' }, { status: 500 })
  }
}

/**
 * Cervellone V19 — Identità Restruktura
 * Costanti immutabili per il system prompt.
 */

export const RESTRUKTURA = {
  ragioneSociale: 'RESTRUKTURA S.r.l.',
  partitaIva: '02087420762',
  /**
   * La sede come risulta all'Agenzia, non la frazione.
   *
   * Fino al 12 set 2026 qui c'era "Villa d'Agri (PZ), Italia": Villa d'Agri e'
   * la FRAZIONE di Marsicovetere, non l'indirizzo fiscale. Corretto con il dato
   * di una fattura elettronica ricevuta (Edil Limongi 2/1144 del 27/07/2026),
   * dove il riquadro "Cessionario/committente" intestato a Restruktura riporta
   * `VIA ROMA, 60 — MARSICOVETERE (PZ) — 85050`: e' l'indirizzo che il sistema
   * di interscambio associa alla partita IVA, quindi la forma da stampare.
   *
   * Questa costante e' l'unica fonte: `src/lib/societa.ts` la riusa per il
   * campo `sede` del registro, e `src/v19/memory/bootstrap.ts` per il contesto.
   */
  sedeLegale: 'Via Roma 60, 85050 Marsicovetere (PZ)',
  email: 'restruktura.drive@gmail.com',
} as const

export const UTENTE_PRINCIPALE = {
  nome: 'Raffaele Lentini',
  qualifica: 'Ingegnere strutturale, CEO, Direttore Lavori',
  email: 'raffaele.lentini@restruktura.it',
} as const

/**
 * Chi firma un documento generato, in fondo alla pagina.
 *
 * Sta in un file suo perche' le societa' sono DUE e i punti che generano
 * documenti sono sei: prima questa stessa funzione era stata copiata in
 * `tools.ts` e in `document-template-tools.ts`, e due copie della stessa cosa
 * sono due cose destinate a divergere.
 *
 * Best-effort: se non si riesce a risolvere la societa' attiva resta
 * Restruktura, che e' il caso di gran lunga piu' frequente.
 */
export async function societaAttivaPerDocumenti(
  conversationId?: string,
): Promise<{ denominazione: string; piva: string } | undefined> {
  try {
    const { getSocietaAttiva } = await import('./societa-attiva')
    const { getSocieta } = await import('./societa')
    const s = getSocieta(await getSocietaAttiva(conversationId ?? ''))
    return { denominazione: s.denominazione, piva: s.piva }
  } catch {
    return undefined
  }
}

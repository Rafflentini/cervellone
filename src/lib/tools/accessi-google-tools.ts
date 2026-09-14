/**
 * La prova di vita degli accessi Google.
 *
 * Nasce il 14 settembre 2026, il giorno in cui — autorizzata la casella de La
 * Real Estate — alla domanda «funziona?» non sapeva rispondere nessuno. La
 * credenziale era salvata ma non era mai stata esercitata: l'indirizzo mostrato
 * dal callback viene da un decode LOCALE del JWT, non da una chiamata a Google.
 *
 * `getAuthorizedClient` esercita gia' la credenziale (`getAccessToken()`): qui
 * la si chiama per OGNI casella Google e si riporta l'esito — anche quello buono.
 */
import type { ToolDefinition } from './types'
import { caselleDiTrasporto } from '@/lib/caselle'
import { getAuthorizedClient } from '@/lib/google-oauth'

export const ACCESSI_GOOGLE_TOOLS: ToolDefinition[] = [
  {
    name: 'verifica_accessi_google',
    description:
      'Prova UNA PER UNA le credenziali Google di Cervellone (le caselle Gmail di Restruktura e de La Real Estate) e dice quali sono VIVE e quali no, col motivo. USALO quando l Ingegnere chiede "riesci a leggere la posta di X?", "l accesso a quella casella funziona?", oppure quando un tool di posta fallisce e non si capisce se sia un problema di credenziali. Riporta l esito COM E, anche quando e buono: un controllo che parla solo nei guai e indistinguibile da uno che non gira.',
    input_schema: { type: 'object', properties: {} },
  },
]

export async function executeAccessiGoogleTools(
  name: string,
  _input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'verifica_accessi_google') return null

  const righe: string[] = ['Accessi Google, provati uno per uno:', '']
  for (const casella of caselleDiTrasporto('google')) {
    const email = casella.accountEmail!
    try {
      const client = await getAuthorizedClient(email)
      righe.push(client
        ? `✅ ${email} (${casella.chiave}) — credenziale VIVA.`
        : `❌ ${email} (${casella.chiave}) — nessuna credenziale salvata: va autorizzata su /api/auth/google.`)
    } catch (e) {
      righe.push(`❌ ${email} (${casella.chiave}) — NON funziona: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return righe.join('\n')
}

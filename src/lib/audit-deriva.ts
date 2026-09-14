// src/lib/audit-deriva.ts
import { executeDerivaTools } from '@/lib/tools/deriva-schema-tools'

/**
 * La deriva fra quello che il repository promette e quello che il database ha.
 *
 * La sezione c'e' SEMPRE, anche a deriva zero: un sorvegliante che parla solo
 * quando c'e' un guasto e' indistinguibile da uno morto — ed e' esattamente il
 * difetto che ha tenuto sei rapporti di autodiagnosi nel cassetto.
 */
export async function sezioneDeriva(): Promise<string> {
  const intestazione = '— Deriva fra repository e database —'
  try {
    const testo = await executeDerivaTools('verifica_deriva_schema', {})
    return `${intestazione}\n${testo ?? 'il controllo non ha risposto niente.'}`
  } catch (e) {
    return `${intestazione}\nNON sono riuscito a fare il controllo: ${e instanceof Error ? e.message : String(e)}`
  }
}

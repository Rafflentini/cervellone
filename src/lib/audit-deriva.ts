// src/lib/audit-deriva.ts
import { derivaPerIlRapporto } from '@/lib/tools/deriva-schema-tools'

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
    // `derivaPerIlRapporto` torna sempre una stringa: o il confronto, o il
    // motivo per cui non e' riuscito a guardare. Non c'e' il caso «niente».
    return `${intestazione}\n${await derivaPerIlRapporto()}`
  } catch (e) {
    return `${intestazione}\nNON sono riuscito a fare il controllo: ${e instanceof Error ? e.message : String(e)}`
  }
}

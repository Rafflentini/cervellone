/**
 * Il tool con cui Cervellone sa dire se il proprio database e' allineato al
 * repository.
 *
 * Nasce il 14 settembre 2026, il giorno in cui si e' scoperto che cinque
 * migrazioni su 43 non erano mai state applicate — e che due di quelle
 * reggevano codice vivo, da mesi, in silenzio.
 *
 * Un tool e non un comando slash: `getToolDefinitions()` non conosce i canali,
 * quindi nasce equipollente su Telegram e sulla chat web per costruzione.
 */
import type { ToolDefinition } from './types'
import { confronta, descriviDeriva, type OggettiAttesi } from '@/lib/deriva-schema'
import { fotografaSchema } from '@/lib/deriva-schema-db'
import ATTESI from '@/lib/deriva-schema-attesi.json'

export const DERIVA_TOOLS: ToolDefinition[] = [
  {
    name: 'verifica_deriva_schema',
    description:
      'Dice se il database di produzione ha davvero tutto quello che le migrazioni del repository promettono: tabelle, colonne, chiavi primarie, indici e chiavi di configurazione. USALO quando l Ingegnere chiede "il database e allineato?", quando una funzione sembra non salvare o non leggere niente senza un motivo, o quando un errore parla di una colonna che non esiste. Il 14 settembre 2026 cinque migrazioni su 43 risultavano mai applicate e due reggevano codice vivo da mesi, senza che nessuno se ne accorgesse. RIPORTA SEMPRE ANCHE il numero di statement che il controllo non sa interpretare: quel numero dice quanto NON e stato guardato, e senza di esso "nessuna deriva" non significa niente. Se il controllo dice che non e riuscito a guardare, DILLO cosi com e: non e la stessa cosa di "va tutto bene".',
    input_schema: { type: 'object', properties: {} },
  },
]

export async function executeDerivaTools(
  name: string,
  _input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'verifica_deriva_schema') return null

  const esito = await fotografaSchema()
  if (!esito.ok) {
    // Non si degrada in «nessuna deriva»: un guardiano che tace quando non
    // riesce a guardare fa credere che qualcuno stia controllando.
    return `NON sono riuscito a leggere la forma del database, quindi NON so dire se sia allineato al repository.\nMotivo: ${esito.errore}`
  }

  const deriva = confronta(ATTESI as unknown as OggettiAttesi, esito.foto)
  return descriviDeriva(deriva)
}

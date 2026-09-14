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

/**
 * L'elenco congelato si carica QUI DENTRO e non in cima al modulo.
 *
 * `deriva-schema-attesi.json` pesa **77 KB**, e `tools.ts` importa questo
 * modulo: in cima, quei 77 KB entrerebbero nel grafo dei moduli a OGNI
 * conversazione, anche in quelle che non parlano di database. E' lo stesso
 * motivo per cui `automazioni.ts` tiene l'import della routine mail dentro la
 * funzione invece che in cima.
 *
 * ⚠️ Un JSON importato dinamicamente puo' arrivare come `{ default: … }` o
 * come l'oggetto stesso, a seconda della configurazione. Si accettano tutte e
 * due le forme, perche' sbagliarla NON esplode: darebbe zero oggetti attesi e
 * un «Nessuna deriva: 0 oggetti» — un «va tutto bene» falso. C'e' un test che
 * pretende il numero vero.
 */
async function elencoCongelato(): Promise<OggettiAttesi> {
  const modulo = await import('@/lib/deriva-schema-attesi.json')
  const contenuto = (modulo as { default?: unknown }).default ?? modulo
  return contenuto as unknown as OggettiAttesi
}

export const DERIVA_TOOLS: ToolDefinition[] = [
  {
    name: 'verifica_deriva_schema',
    description:
      'Dice se il database di produzione ha davvero tutto quello che le migrazioni del repository promettono: tabelle, colonne, chiavi primarie, indici e chiavi di configurazione. USALO quando l Ingegnere chiede "il database e allineato?", quando una funzione sembra non salvare o non leggere niente senza un motivo, o quando un errore parla di una colonna che non esiste. Il 14 settembre 2026 cinque migrazioni su 43 risultavano mai applicate e due reggevano codice vivo da mesi, senza che nessuno se ne accorgesse. RIPORTA SEMPRE ANCHE il numero di statement che il controllo non sa interpretare: quel numero dice quanto NON e stato guardato, e senza di esso "nessuna deriva" non significa niente. Se il controllo dice che non e riuscito a guardare, DILLO cosi com e: non e la stessa cosa di "va tutto bene".',
    input_schema: { type: 'object', properties: {} },
  },
]

async function testoDeriva(elencoFile: 'completo' | 'sintetico'): Promise<string> {
  const esito = await fotografaSchema()
  if (!esito.ok) {
    // Non si degrada in «nessuna deriva»: un guardiano che tace quando non
    // riesce a guardare fa credere che qualcuno stia controllando.
    return `NON sono riuscito a leggere la forma del database, quindi NON so dire se sia allineato al repository.\nMotivo: ${esito.errore}`
  }

  const deriva = confronta(await elencoCongelato(), esito.foto)
  return descriviDeriva(deriva, { elencoFile })
}

export async function executeDerivaTools(
  name: string,
  _input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'verifica_deriva_schema') return null
  // Il tool non passa da Telegram: qui l'elenco dei file non letti ci sta per
  // intero, ed e' il posto dove l'Ingegnere lo puo' andare a prendere.
  return testoDeriva('completo')
}

/**
 * Lo stesso controllo, per il rapporto settimanale di autodiagnosi.
 *
 * Cambia solo l'elenco dei file con statement non letti: nel rapporto e' un
 * numero piu' tre nomi. Il rapporto viene tagliato a 3.500 caratteri su 4.096
 * e questa sezione sta in coda: i ~1.420 caratteri di nomi — gli stessi ogni
 * settimana — facevano cadere il taglio esattamente sulla notizia.
 * ⚠️ Le righe che dicono cosa MANCA non si accorciano mai: sono la notizia.
 */
export async function derivaPerIlRapporto(): Promise<string> {
  return testoDeriva('sintetico')
}

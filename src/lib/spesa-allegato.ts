/**
 * src/lib/spesa-allegato.ts — l'allegato di una mail che diventa il PDF di
 * una spesa su Fatture in Cloud.
 *
 * ⚠️ Perche' sta in un modulo suo. Sceglierlo e scaricarlo sono DUE momenti
 * diversi e devono restarlo:
 *
 * - la SCELTA avviene quando si prepara l'anteprima, e non tocca niente:
 *   legge la mail, dice quale file userebbe, e se non lo sa **si rifiuta e li
 *   elenca** invece di indovinare (stessa forma di `gmail_leggi_allegato`:
 *   aprire il PDF sbagliato vuol dire registrare una spesa vera con il
 *   documento di un'altra);
 * - lo SCARICAMENTO avviene dopo la conferma, un attimo prima di caricare il
 *   file su Fatture in Cloud. Tenere il PDF dentro la riga del pending
 *   avrebbe voluto dire parcheggiare un file in un campo JSON del database
 *   per il tempo di una conferma, e per niente.
 *
 * Quello che questo modulo NON fa e' altrettanto importante: non legge il
 * contenuto del PDF e non ne ricava nessun importo. L'imponibile lo dice
 * l'Ingegnere — «deve solo mettere PDF e importo».
 */
import { readMessage, scaricaAllegato } from './gmail-tools'
import { FORMATI_ALLEGATO_FIC } from './fatture-in-cloud'
import { caselleDiTrasporto, type ChiaveCasella } from './caselle'

/**
 * Le caselle Google da cui puo' arrivare la fattura di un fornitore. Si
 * ricavano dal registro delle caselle, non da un elenco scritto a mano qui: le
 * due societa' hanno caselle diverse, e una lista cablata invecchierebbe in
 * silenzio (v. `gmail-allegati-tools.ts`, stessa forma).
 */
export const CASELLE_GOOGLE = caselleDiTrasporto('google').map((c) => c.chiave)

/**
 * Oltre questa soglia il file non si carica. E' il tetto usato dagli altri
 * allegati di casa (`gmail_leggi_allegato`, `fic-allegato`): una fattura di un
 * fornitore che pesa piu' di 10 MB non e' il caso normale, e un caricamento
 * che fa scadere il turno lascerebbe l'esito nel dubbio.
 */
export const MAX_BYTE_ALLEGATO = 10 * 1024 * 1024

export interface AllegatoScelto {
  filename: string
  attachmentId: string
  sizeBytes: number
}

function estensione(filename: string): string {
  const punto = filename.lastIndexOf('.')
  return punto >= 0 ? filename.slice(punto + 1).toLowerCase() : ''
}

/**
 * Sceglie l'allegato della mail, o dice perche' non lo sceglie.
 *
 * Non restituisce mai «il primo»: con piu' di un allegato e senza `nome_file`
 * si ferma. E' copiato apposta da `gmail-allegati-tools.ts`, dove la stessa
 * scelta serve solo a LEGGERE un testo; qui a valle c'e' un documento
 * contabile con quel file attaccato, quindi la regola vale a maggior ragione.
 */
export async function scegliAllegatoMail(
  casella: ChiaveCasella,
  messageId: string,
  nomeFile?: string,
): Promise<{ ok: true; oggetto: string; allegato: AllegatoScelto } | { ok: false; error: string }> {
  // Una casella che non esiste non e' «nessun allegato»: e' una richiesta che
  // non so eseguire, e va detta come tale.
  if (!(CASELLE_GOOGLE as string[]).includes(casella)) {
    return { ok: false, error: `non so quale casella aprire: «${casella}» non e' fra quelle Google (${CASELLE_GOOGLE.join(', ')})` }
  }

  let mail
  try {
    mail = await readMessage(casella, messageId)
  } catch (e) {
    // Un guasto di lettura NON diventa «la mail non ha allegati».
    return { ok: false, error: `non sono riuscito ad aprire la mail ${messageId} su ${casella}: ${e instanceof Error ? e.message : String(e)}` }
  }

  const allegati = mail.attachments ?? []
  if (allegati.length === 0) return { ok: false, error: `la mail «${mail.subject}» non ha allegati: non c'e' nessun PDF da mettere sulla spesa` }

  const chiesto = (nomeFile ?? '').trim()
  const scelto = chiesto
    ? allegati.find((a) => a.filename === chiesto) ?? allegati.find((a) => a.filename.includes(chiesto))
    : allegati.length === 1 ? allegati[0] : undefined

  if (!scelto) {
    const elenco = allegati.map((a) => `«${a.filename}» (${Math.round(a.sizeBytes / 1024)} KB)`).join(', ')
    return {
      ok: false,
      error: chiesto
        ? `nella mail «${mail.subject}» non c'e' nessun allegato che si chiami «${chiesto}». Ci sono: ${elenco}`
        : `la mail «${mail.subject}» ha ${allegati.length} allegati e non so quale sia la fattura: ${elenco}. Dimmi quale con nome_file`,
    }
  }

  const ext = estensione(scelto.filename)
  if (!(FORMATI_ALLEGATO_FIC as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: `«${scelto.filename}» non e' in un formato che Fatture in Cloud accetta come allegato `
        + `(${FORMATI_ALLEGATO_FIC.join(', ')}): non lo carico`,
    }
  }

  if (scelto.sizeBytes > MAX_BYTE_ALLEGATO) {
    return {
      ok: false,
      error: `«${scelto.filename}» pesa ${Math.round(scelto.sizeBytes / 1024 / 1024)} MB, oltre il tetto di `
        + `${MAX_BYTE_ALLEGATO / 1024 / 1024} MB: non lo carico`,
    }
  }

  return { ok: true, oggetto: mail.subject, allegato: scelto }
}

/**
 * Scarica i byte dell'allegato gia' scelto.
 *
 * Il tetto si ricontrolla QUI sui byte veri: `sizeBytes` e' quello che Gmail
 * dichiara nei metadati, e un dato dichiarato non e' il dato.
 */
export async function scaricaAllegatoScelto(
  casella: ChiaveCasella,
  messageId: string,
  allegato: { filename: string; attachmentId: string },
): Promise<{ ok: true; contenuto: Buffer } | { ok: false; error: string }> {
  let base64: string
  try {
    base64 = await scaricaAllegato(casella, messageId, allegato.attachmentId)
  } catch (e) {
    return { ok: false, error: `non sono riuscito a scaricare «${allegato.filename}» da ${casella}: ${e instanceof Error ? e.message : String(e)}` }
  }

  const contenuto = Buffer.from(base64, 'base64')
  if (contenuto.length === 0) {
    return { ok: false, error: `«${allegato.filename}» e' arrivato VUOTO da Gmail: non carico un file di zero byte su una fattura` }
  }
  if (contenuto.length > MAX_BYTE_ALLEGATO) {
    return {
      ok: false,
      error: `«${allegato.filename}» scaricato pesa ${Math.round(contenuto.length / 1024 / 1024)} MB, oltre il tetto di `
        + `${MAX_BYTE_ALLEGATO / 1024 / 1024} MB: non lo carico`,
    }
  }
  return { ok: true, contenuto }
}

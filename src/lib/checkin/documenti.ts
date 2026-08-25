/**
 * src/lib/checkin/documenti.ts
 *
 * Le foto dei documenti d'identita': dove finiscono, e quando spariscono.
 *
 * Sono la parte piu' delicata di tutto il sottosistema, e non per ragioni
 * tecniche. Il Garante privacy e' intervenuto piu' volte sulle strutture
 * ricettive: si possono acquisire i DATI necessari alla comunicazione alla
 * Questura, ma conservare copia del documento e' quasi sempre eccedente
 * rispetto allo scopo. Un archivio di documenti d'identita' di decine di
 * persone, se qualcuno ci mette le mani, e' una violazione grave.
 *
 * Percio' qui la cancellazione non e' una funzione aggiunta dopo: e' costruita
 * insieme al caricamento, e i giorni di conservazione stanno in una cella del
 * Config, non nel codice.
 *
 * Tre scelte che seguono da questo:
 *
 *  - le foto stanno in una cartella Drive PRIVATA, e non vengono mai condivise:
 *    nel foglio finisce l'identificativo del file, non un collegamento che
 *    chiunque possa aprire;
 *  - ogni ospite carica e vede SOLO le proprie;
 *  - quando si cancellano, si svuotano anche le celle: un identificativo che
 *    punta a un file che non c'e' piu' e' peggio di una cella vuota, perche'
 *    sembra che il documento ci sia.
 */

import { getDrive } from '../drive'

/** Cartella che raccoglie le cartelle delle singole prenotazioni. */
const NOME_CARTELLA_RADICE = 'Documenti check-in'

/**
 * Il tetto vale per il file GIA' ridotto dal telefono. Una foto di un
 * documento a 1600px di lato lungo pesa qualche centinaio di kilobyte ed e'
 * ampiamente leggibile: caricare l'originale da 12 megapixel non aggiunge
 * niente e fallirebbe sul limite della piattaforma.
 */
export const MAX_BYTE = 3_000_000

const MIME_AMMESSI = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export function tipoAmmesso(mime: string): boolean {
  return MIME_AMMESSI.includes(String(mime || '').toLowerCase())
}

/** Cerca una cartella per nome dentro un genitore. Null se non c'e'. */
async function cercaCartella(nome: string, genitore: string): Promise<string | null> {
  const drive = await getDrive()
  const res = await drive.files.list({
    q: `name = '${nome.replace(/'/g, "\\'")}' and '${genitore}' in parents `
      + `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
  })
  return res.data.files?.[0]?.id ?? null
}

async function creaCartella(nome: string, genitore: string): Promise<string> {
  const drive = await getDrive()
  const res = await drive.files.create({
    requestBody: {
      name: nome,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [genitore],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  if (!res.data.id) throw new Error(`Cartella "${nome}" non creata.`)
  return res.data.id
}

async function cartellaOCrea(nome: string, genitore: string): Promise<string> {
  return (await cercaCartella(nome, genitore)) ?? creaCartella(nome, genitore)
}

/**
 * La cartella della singola prenotazione, creata alla prima foto.
 *
 * Una cartella per prenotazione, e non un unico calderone: cosi' cancellare
 * significa togliere una cartella, non cercare file sparsi — e cercare file
 * sparsi e' il modo in cui qualcuno resta indietro.
 */
export async function cartellaPrenotazione(
  idSoggiorno: string,
  cartellaGenitore: string,
): Promise<string> {
  const radice = await cartellaOCrea(NOME_CARTELLA_RADICE, cartellaGenitore)
  return cartellaOCrea(idSoggiorno, radice)
}

export type Lato = 'fronte' | 'retro'

/** Nome del file: si capisce di chi e' e cosa e' senza aprirlo. */
export function nomeFile(idSoggiorno: string, progressivo: number, lato: Lato, mime: string): string {
  const est = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'
  return `${idSoggiorno}_ospite${progressivo}_${lato}.${est}`
}

export async function salvaDocumento(params: {
  idSoggiorno: string
  progressivo: number
  lato: Lato
  contenuto: Buffer
  mime: string
  cartellaGenitore: string
}): Promise<{ fileId: string }> {
  const { idSoggiorno, progressivo, lato, contenuto, mime, cartellaGenitore } = params

  if (!tipoAmmesso(mime)) throw new Error(`Tipo di file non ammesso: ${mime}`)
  if (contenuto.length > MAX_BYTE) throw new Error('File troppo grande.')

  const cartella = await cartellaPrenotazione(idSoggiorno, cartellaGenitore)
  const drive = await getDrive()

  const { Readable } = await import('stream')
  const res = await drive.files.create({
    requestBody: {
      name: nomeFile(idSoggiorno, progressivo, lato, mime),
      parents: [cartella],
    },
    media: { mimeType: mime, body: Readable.from(contenuto) },
    fields: 'id',
    supportsAllDrives: true,
  })

  if (!res.data.id) throw new Error('Caricamento non riuscito.')
  // Mai il contenuto nei log: e' un documento d'identita'.
  console.log(`[CHECKIN] documento salvato ${idSoggiorno} ospite${progressivo} ${lato}`)
  return { fileId: res.data.id }
}

/**
 * Cancella un file. Non fallisce se il file non c'e' gia' piu': la
 * cancellazione deve poter essere rieseguita senza rompersi, altrimenti un
 * errore su una foto bloccherebbe la pulizia di tutte le altre.
 */
export async function eliminaDocumento(fileId: string): Promise<boolean> {
  if (!fileId?.trim()) return false
  try {
    const drive = await getDrive()
    await drive.files.delete({ fileId: fileId.trim(), supportsAllDrives: true })
    return true
  } catch (err) {
    const messaggio = err instanceof Error ? err.message : String(err)
    if (messaggio.includes('404') || messaggio.toLowerCase().includes('not found')) return false
    throw err
  }
}

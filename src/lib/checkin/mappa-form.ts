/**
 * src/lib/checkin/mappa-form.ts
 *
 * Traduce fra i nomi che usa il form e le intestazioni del foglio.
 *
 * Sembra lavoro inutile, e invece e' il punto in cui un sistema del genere si
 * rompe di solito: il form chiama un campo `citta`, il foglio lo chiama
 * `Città`, e chi scrive il codice mescola le due forme finche' un campo smette
 * di arrivare a destinazione — senza errori, solo una cella vuota.
 *
 * Stando tutto qui, la traduzione si prova, e il resto del codice usa una forma
 * sola per volta.
 */

export interface FormSoggiorno {
  unita: string
  portale: string
  codPrenotazione: string
  checkin: string
  checkout: string
  ospitiAttesi: string
  importoLordo: string
  intestatario: string
  codiceFiscale: string
  piva: string
  sdi: string
  indirizzo: string
  cap: string
  citta: string
  provincia: string
  nazione: string
  email: string
  telefono: string
  note: string
}

export interface FormOspite {
  progressivo: string
  tipoAlloggiato: string
  cognome: string
  nome: string
  sesso: string
  dataNascita: string
  comuneNascita: string
  provNascita: string
  statoNascita: string
  cittadinanza: string
  tipoDocumento: string
  numeroDocumento: string
  luogoRilascio: string
  codiceFiscale: string
  esente: boolean
  motivoEsenzione: string
}

/** campo del form -> intestazione di colonna. Unica fonte della traduzione. */
export const COLONNA_SOGGIORNO: Record<keyof FormSoggiorno, string> = {
  unita: 'Unità',
  portale: 'Portale',
  codPrenotazione: 'Cod. prenotazione',
  checkin: 'Check-in',
  checkout: 'Check-out',
  ospitiAttesi: 'N. ospiti',
  importoLordo: 'Importo lordo €',
  intestatario: 'Intestatario fattura',
  codiceFiscale: 'Codice fiscale',
  piva: 'P.IVA',
  sdi: 'Codice SDI / PEC',
  indirizzo: 'Indirizzo',
  cap: 'CAP',
  citta: 'Città',
  provincia: 'Provincia',
  nazione: 'Nazione',
  email: 'Email',
  telefono: 'Telefono',
  note: 'Note',
}

export const COLONNA_OSPITE: Record<Exclude<keyof FormOspite, 'esente'>, string> = {
  progressivo: 'Progressivo',
  tipoAlloggiato: 'Tipo alloggiato',
  cognome: 'Cognome',
  nome: 'Nome',
  sesso: 'Sesso',
  dataNascita: 'Data nascita',
  comuneNascita: 'Comune nascita',
  provNascita: 'Prov. nascita',
  statoNascita: 'Stato nascita',
  cittadinanza: 'Cittadinanza',
  tipoDocumento: 'Tipo documento',
  numeroDocumento: 'Numero documento',
  luogoRilascio: 'Luogo rilascio',
  codiceFiscale: 'Codice fiscale',
  motivoEsenzione: 'Motivo esenzione',
}

export function soggiornoDaColonne(m: Record<string, string>): FormSoggiorno {
  const out = {} as FormSoggiorno
  for (const [campo, colonna] of Object.entries(COLONNA_SOGGIORNO)) {
    out[campo as keyof FormSoggiorno] = String(m[colonna] ?? '')
  }
  return out
}

export function soggiornoAColonne(f: Partial<FormSoggiorno>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [campo, colonna] of Object.entries(COLONNA_SOGGIORNO)) {
    const v = f[campo as keyof FormSoggiorno]
    if (v !== undefined) out[colonna] = String(v)
  }
  return out
}

export function ospiteDaColonne(m: Record<string, string>): FormOspite {
  const out = {} as FormOspite
  for (const [campo, colonna] of Object.entries(COLONNA_OSPITE)) {
    // @ts-expect-error indicizzazione dinamica su chiavi note
    out[campo] = String(m[colonna] ?? '')
  }
  // Sul foglio l'esenzione e' la parola SI, nel form una casella: due forme
  // dello stesso fatto, e la conversione va fatta in un punto solo.
  out.esente = String(m['Esente imposta'] ?? '').trim().toUpperCase() === 'SI'
  return out
}

export function ospiteAColonne(f: Partial<FormOspite>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [campo, colonna] of Object.entries(COLONNA_OSPITE)) {
    const v = f[campo as keyof FormOspite]
    if (v !== undefined) out[colonna] = String(v)
  }
  if (f.esente !== undefined) out['Esente imposta'] = f.esente ? 'SI' : 'NO'
  return out
}

/** Il campo del form corrisponde a una colonna bloccata? */
export function campoBloccato(campo: keyof FormSoggiorno, colonneBloccate: string[]): boolean {
  return colonneBloccate.includes(COLONNA_SOGGIORNO[campo])
}

/**
 * Cervellone V19 — Tipi per pacchetto CIGO Eventi Meteo
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 9.3
 */

export type Azienda = {
  denominazione: string
  codice_fiscale: string
  matricola_inps: string
  unita_produttiva?: string
  data_inizio_attivita?: string // YYYY-MM-DD
}

export type LegaleRappresentante = {
  nome_cognome: string
  qualifica?: 'titolare' | 'legale_rappresentante'
  luogo_nascita?: string
  data_nascita?: string // YYYY-MM-DD
  residenza?: string
  telefono?: string
}

export type Periodo = {
  data_inizio: string // YYYY-MM-DD
  data_fine: string // YYYY-MM-DD
}

export type Beneficiario = {
  cognome: string
  nome: string
  codice_fiscale: string
  qualifica?: string
  data_assunzione?: string // YYYY-MM-DD
  tipo_contratto?: string
  ore_contrattuali_settimana?: number
  ore_perse_settimana_1?: number
  ore_perse_settimana_2?: number
  ore_perse_settimana_3?: number
  ore_perse_settimana_4?: number
}

export type Allegato10Input = {
  azienda: Azienda
  legale_rappresentante: LegaleRappresentante
  periodo: Periodo
  attivita_svolta: string
  evento_meteo: string
  conseguenze: string
  ulteriori_annotazioni?: string
  beneficiari: Beneficiario[]
  pagamento_diretto?: boolean
  /** Cartella Drive id per upload finale (semantic). Default: cartella RELAZIONI CIG. */
  drive_folder_id?: string
}

export type CigoFileEntry = {
  name: string
  buffer: Buffer
  contentType: string
}

export type Allegato10Output = {
  files: CigoFileEntry[]
  bollettinoUrl?: string
  bollettinoDate?: string
  zipBuffer?: Buffer
  driveLink?: string // se uploadato
  warnings?: string[]
}

export type GeneraAllegato10Options = {
  /** Se true, NON fa upload Drive: utile per test. */
  dryRun?: boolean
  /** Override del fetch del bollettino (per test). */
  fetchImpl?: typeof fetch
}

/**
 * Cervellone V19 — Tool genera_allegato10_cigo
 *
 * Pipeline:
 * 1. Scarica bollettino CFD Basilicata (data inizio periodo).
 * 2. Genera Allegato 10 DOCX semantico.
 * 3. Genera CSV beneficiari (tracciato Msg INPS 3566/2018).
 * 4. (opz) Compila SR41 placeholder.
 * 5. Crea ZIP con tutti i file.
 * 6. (non-dryRun) Upload ZIP su Drive cartella RELAZIONI CIG.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 9.3
 */

import type Anthropic from '@anthropic-ai/sdk'
import { renderAllegato10 } from './build-allegato10'
import { buildBeneficiariCsv } from './build-beneficiari-csv'
import { compilaSr41Placeholder } from './build-sr41'
import { zipCigoFiles } from './zip'
import {
  scaricaBollettinoBasilicata,
  type BollettinoResult,
} from '../meteo-basilicata'
import { BollettinoNotFoundError } from '../meteo-basilicata.errors'
import type {
  Allegato10Input,
  Allegato10Output,
  CigoFileEntry,
  GeneraAllegato10Options,
} from './types'

export async function generaAllegato10Cigo(
  input: Allegato10Input,
  opts: GeneraAllegato10Options = {},
): Promise<Allegato10Output> {
  const warnings: string[] = []
  const files: CigoFileEntry[] = []

  // 1. Bollettino CFD Basilicata
  let bollettino: BollettinoResult | null = null
  try {
    const startDate = new Date(input.periodo.data_inizio)
    bollettino = await scaricaBollettinoBasilicata(startDate, {
      fetchImpl: opts.fetchImpl,
    })
    files.push({
      name: bollettino.filename,
      buffer: bollettino.pdfBuffer,
      contentType: 'application/pdf',
    })
  } catch (err) {
    if (err instanceof BollettinoNotFoundError) {
      warnings.push(
        `Bollettino CFD Basilicata non disponibile per ${err.date}. Procedo senza. Allegare manualmente o richiedere via PEC.`,
      )
    } else {
      warnings.push(`Errore scaricamento bollettino: ${String(err)}`)
    }
  }

  // 2. Allegato 10 DOCX
  const allegato10Buffer = await renderAllegato10(input)
  files.push({
    name: 'Allegato10_RelazioneTecnica.docx',
    buffer: allegato10Buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })

  // 3. CSV beneficiari
  const csv = buildBeneficiariCsv(input.beneficiari, input.periodo)
  files.push({
    name: 'ElencoBeneficiari.csv',
    buffer: Buffer.from(csv, 'utf-8'),
    contentType: 'text/csv; charset=utf-8',
  })

  // 4. SR41 placeholder (solo se pagamento diretto)
  if (input.pagamento_diretto) {
    const sr41Buffer = await compilaSr41Placeholder(input)
    files.push({
      name: 'SR41_PagamentoDiretto.docx',
      buffer: sr41Buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  }

  // 5. ZIP
  const zipBuffer = await zipCigoFiles(files)

  // 6. Upload Drive (solo se NON dryRun e cartella configurata)
  let driveLink: string | undefined = undefined
  if (!opts.dryRun && input.drive_folder_id) {
    // TODO post-foundation: integrare wrapper drive_upload_binary V19.
    // Per ora ritorniamo solo il buffer; l'orchestrator chiamerà drive_upload_binary.
    warnings.push('Upload Drive non eseguito automaticamente in V19 foundation. Usare tool drive_upload_binary separatamente.')
  }

  return {
    files,
    bollettinoUrl: bollettino?.pdfUrl,
    bollettinoDate: bollettino?.date,
    zipBuffer,
    driveLink,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

export const GENERA_ALLEGATO10_TOOL: Anthropic.Tool = {
  name: 'genera_allegato10_cigo',
  description:
    'Genera pacchetto CIGO Eventi Meteo per microimpresa edile (Allegato 10 + CSV beneficiari + bollettino CFD Basilicata + opzionalmente SR41). Causale: D.M. 95442/2016. Bollettino: SOLO Centro Funzionale Decentrato Regione Basilicata (vincolante per Restruktura). Output: ZIP da caricare su Drive cartella RELAZIONI CIG via drive_upload_binary.',
  input_schema: {
    type: 'object',
    properties: {
      azienda: {
        type: 'object',
        properties: {
          denominazione: { type: 'string' },
          codice_fiscale: { type: 'string' },
          matricola_inps: { type: 'string' },
          unita_produttiva: { type: 'string' },
          data_inizio_attivita: { type: 'string' },
        },
        required: ['denominazione', 'codice_fiscale', 'matricola_inps'],
      },
      legale_rappresentante: {
        type: 'object',
        properties: {
          nome_cognome: { type: 'string' },
          qualifica: { type: 'string', enum: ['titolare', 'legale_rappresentante'] },
          luogo_nascita: { type: 'string' },
          data_nascita: { type: 'string' },
          residenza: { type: 'string' },
          telefono: { type: 'string' },
        },
        required: ['nome_cognome'],
      },
      periodo: {
        type: 'object',
        properties: {
          data_inizio: { type: 'string', description: 'YYYY-MM-DD' },
          data_fine: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['data_inizio', 'data_fine'],
      },
      attivita_svolta: { type: 'string' },
      evento_meteo: { type: 'string' },
      conseguenze: { type: 'string' },
      ulteriori_annotazioni: { type: 'string' },
      beneficiari: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cognome: { type: 'string' },
            nome: { type: 'string' },
            codice_fiscale: { type: 'string' },
            qualifica: { type: 'string' },
            data_assunzione: { type: 'string' },
            tipo_contratto: { type: 'string' },
            ore_contrattuali_settimana: { type: 'number' },
            ore_perse_settimana_1: { type: 'number' },
            ore_perse_settimana_2: { type: 'number' },
            ore_perse_settimana_3: { type: 'number' },
            ore_perse_settimana_4: { type: 'number' },
          },
          required: ['cognome', 'nome', 'codice_fiscale'],
        },
      },
      pagamento_diretto: { type: 'boolean', default: false },
      drive_folder_id: { type: 'string', description: "ID cartella Drive RELAZIONI CIG (opzionale)" },
    },
    required: ['azienda', 'legale_rappresentante', 'periodo', 'attivita_svolta', 'evento_meteo', 'conseguenze', 'beneficiari'],
  },
}

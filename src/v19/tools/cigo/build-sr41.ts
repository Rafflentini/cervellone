/**
 * Cervellone V19 — SR41 (placeholder)
 *
 * Il modello SR41 INPS è un PDF compilabile (Mod. IG Str Aut). Per V19
 * foundation forniamo un placeholder DOCX con i dati pre-compilati.
 * In fase polish (post-foundation) si potrà integrare pdf-lib per
 * compilare il PDF AcroForm ufficiale INPS direttamente.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 9.1
 */

import { renderDocx } from '../../render/docx'
import type { DocxDocument } from '../../render/types'
import type { Allegato10Input } from './types'

export async function compilaSr41Placeholder(input: Allegato10Input): Promise<Buffer> {
  const doc: DocxDocument = {
    title: 'SR41 - Pagamento diretto integrazioni salariali',
    sections: [
      {
        kind: 'paragraph',
        text: 'MOD. SR41 (Placeholder V19 — sostituire con PDF AcroForm ufficiale INPS in fase polish)',
        align: 'center',
        style: { bold: true, color: 'C00000' },
      },
      {
        kind: 'table',
        columns: [{ header: "QUADRO A — DATI AZIENDA", align: 'left', width: 100 }],
        headerStyle: { bgColor: 'D9D9D9', color: '000000', bold: true },
        cellBorders: 'all',
        rows: [
          [`Denominazione: ${input.azienda.denominazione}`],
          [`Codice fiscale: ${input.azienda.codice_fiscale}`],
          [`Matricola INPS: ${input.azienda.matricola_inps}`],
          [`Periodo: dal ${input.periodo.data_inizio} al ${input.periodo.data_fine}`],
        ],
      },
      { kind: 'paragraph', text: ' ' },
      {
        kind: 'table',
        columns: [
          { header: 'Cognome', align: 'left', width: 20 },
          { header: 'Nome', align: 'left', width: 20 },
          { header: 'Codice Fiscale', align: 'left', width: 25 },
          { header: 'Ore CIG', align: 'right', width: 15 },
          { header: 'Importo (auto)', align: 'right', width: 20 },
        ],
        headerStyle: { bgColor: 'C00000', color: 'FFFFFF', bold: true },
        cellBorders: 'all',
        rows: input.beneficiari.map((b) => [
          b.cognome,
          b.nome,
          b.codice_fiscale,
          String(
            (b.ore_perse_settimana_1 ?? 0) +
              (b.ore_perse_settimana_2 ?? 0) +
              (b.ore_perse_settimana_3 ?? 0) +
              (b.ore_perse_settimana_4 ?? 0),
          ),
          'A cura INPS',
        ]),
      },
      { kind: 'paragraph', text: ' ' },
      {
        kind: 'paragraph',
        text:
          "TODO post-foundation: integrare pdf-lib + template AcroForm SR41 ufficiale " +
          "INPS (4 pagine, quadri A-G). Riferimento: " +
          "https://www.studio74.it/images/pdf-modulistica/inps/inps-cig-cartacei-sr41-pospetto-per-pagamento-diretto-integrazioni-salariali.pdf",
        style: { italics: true, size: 18 },
      },
    ],
    footer: `SR41 (placeholder) — Restruktura — Periodo ${input.periodo.data_inizio}/${input.periodo.data_fine}`,
  }
  return await renderDocx(doc)
}

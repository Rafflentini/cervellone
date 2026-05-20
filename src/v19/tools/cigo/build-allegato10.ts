/**
 * Cervellone V19 — Builder Allegato 10 (relazione tecnica art. 2 D.M. 95442/2016)
 *
 * Trasforma Allegato10Input in DocxDocument semantico, poi rendere via
 * src/v19/render/docx.ts.
 *
 * Layout fedele al fac-simile INPS scaricato durante research:
 * - Header "All.10" in alto a destra
 * - Titolo grande centrato
 * - Box "DATI RELATIVI ALL'AZIENDA" (tabella 1 colonna)
 * - Box "DICHIARAZIONE SOSTITUTIVA DELL'ATTO DI NOTORIETÀ"
 * - Sezioni dichiarazione (1, 2, 3)
 * - Footer con data + firma
 */

import type { DocxDocument, DocxSection } from '../../render/types'
import { renderDocx } from '../../render/docx'
import type { Allegato10Input } from './types'

const GREY_BG = 'D9D9D9'

export function buildAllegato10Doc(input: Allegato10Input): DocxDocument {
  const sections: DocxSection[] = []

  // Header "All.10" a destra
  sections.push({
    kind: 'paragraph',
    text: 'All.10',
    align: 'right',
    style: { bold: true },
  })

  // Titolo grande
  sections.push({
    kind: 'paragraph',
    text: 'FAC-SIMILE DI RELAZIONE TECNICA DETTAGLIATA',
    align: 'center',
    style: { bold: true, size: 28 }, // 14pt
  })
  sections.push({
    kind: 'paragraph',
    text: "DI CUI ALL'ART. 2 DEL D.M. 95442/2016",
    align: 'center',
    style: { bold: true, size: 28 },
  })
  sections.push({
    kind: 'paragraph',
    text: 'CAUSALE: EVENTI METEOROLOGICI',
    align: 'center',
    style: { bold: true, size: 32, color: 'C00000' }, // 16pt rosso
  })

  // Spaziatore
  sections.push({ kind: 'paragraph', text: ' ' })

  // DATI RELATIVI ALL'AZIENDA (tabella 1 colonna con header grigio)
  sections.push({
    kind: 'table',
    columns: [{ header: "DATI RELATIVI ALL'AZIENDA", align: 'left', width: 100 }],
    headerStyle: { bgColor: GREY_BG, color: '000000', bold: true },
    cellBorders: 'all',
    rows: [
      [`Denominazione: ${input.azienda.denominazione}`],
      [`Codice fiscale: ${input.azienda.codice_fiscale}`],
      [`Matricola INPS: ${input.azienda.matricola_inps}`],
      ...(input.azienda.unita_produttiva
        ? [[`Unità Produttiva: ${input.azienda.unita_produttiva}`]]
        : []),
      ...(input.azienda.data_inizio_attivita
        ? [[`Data inizio attività produttiva: ${formatDateIt(input.azienda.data_inizio_attivita)}`]]
        : []),
    ],
  })

  // Spaziatore
  sections.push({ kind: 'paragraph', text: ' ' })

  // DICHIARAZIONE SOSTITUTIVA — titolo
  sections.push({
    kind: 'paragraph',
    text: "DICHIARAZIONE SOSTITUTIVA DELL'ATTO DI NOTORIETÀ",
    align: 'center',
    style: { bold: true, size: 24 }, // 12pt
  })
  sections.push({
    kind: 'paragraph',
    text: '(Art. 47 D.P.R. 28 dicembre 2000, n. 445 e ss.mm.ii.)',
    align: 'center',
    style: { italics: true, size: 20 },
  })

  // Spaziatore
  sections.push({ kind: 'paragraph', text: ' ' })

  // Anagrafica firmatario
  const lr = input.legale_rappresentante
  sections.push({
    kind: 'paragraph',
    text: `Il sottoscritto ${lr.nome_cognome}` +
      (lr.luogo_nascita ? `, nato a ${lr.luogo_nascita}` : '') +
      (lr.data_nascita ? ` il ${formatDateIt(lr.data_nascita)}` : '') +
      (lr.residenza ? `, residente in ${lr.residenza}` : '') +
      (lr.telefono ? `, tel. ${lr.telefono}` : '') + ',',
  })

  sections.push({
    kind: 'paragraph',
    text: `IN QUALITÀ DI: ${lr.qualifica === 'titolare' ? '☒ titolare    ☐ legale rappresentante' : '☐ titolare    ☒ legale rappresentante'}`,
  })

  sections.push({
    kind: 'paragraph',
    text: `dell'azienda ${input.azienda.denominazione}, codice fiscale ${input.azienda.codice_fiscale}, posizione INPS ${input.azienda.matricola_inps}, in riferimento alla richiesta delle integrazioni salariali per il periodo dal ${formatDateIt(input.periodo.data_inizio)} al ${formatDateIt(input.periodo.data_fine)},`,
  })

  // DICHIARA centrato
  sections.push({ kind: 'paragraph', text: ' ' })
  sections.push({
    kind: 'paragraph',
    text: 'D I C H I A R A',
    align: 'center',
    style: { bold: true, size: 28 },
  })
  sections.push({ kind: 'paragraph', text: ' ' })

  // Sezione 1
  sections.push({
    kind: 'paragraph',
    text: '1. ATTIVITÀ AZIENDALE E FASE LAVORATIVA AL VERIFICARSI DELL\'EVENTO',
    style: { bold: true },
  })
  sections.push({ kind: 'paragraph', text: input.attivita_svolta })
  sections.push({ kind: 'paragraph', text: ' ' })

  // Sezione 2
  sections.push({
    kind: 'paragraph',
    text: '2. EVENTO METEOROLOGICO E ORARIO',
    style: { bold: true },
  })
  sections.push({ kind: 'paragraph', text: input.evento_meteo })
  sections.push({
    kind: 'paragraph',
    text: 'Si allega bollettino meteo ufficiale del Centro Funzionale Decentrato (CFD) della Protezione Civile Regione Basilicata.',
    style: { italics: true },
  })
  sections.push({ kind: 'paragraph', text: ' ' })

  // Sezione 3 — conseguenze
  sections.push({
    kind: 'paragraph',
    text: '3. CONSEGUENZE DELL\'EVENTO SULL\'ATTIVITÀ',
    style: { bold: true },
  })
  sections.push({ kind: 'paragraph', text: input.conseguenze })
  sections.push({ kind: 'paragraph', text: ' ' })

  if (input.ulteriori_annotazioni) {
    sections.push({
      kind: 'paragraph',
      text: '4. ULTERIORI ANNOTAZIONI',
      style: { bold: true },
    })
    sections.push({ kind: 'paragraph', text: input.ulteriori_annotazioni })
    sections.push({ kind: 'paragraph', text: ' ' })
  }

  // Riepilogo beneficiari (tabella sintetica — il dettaglio è nel CSV separato)
  if (input.beneficiari.length > 0) {
    sections.push({
      kind: 'paragraph',
      text: 'RIEPILOGO BENEFICIARI',
      style: { bold: true },
    })
    sections.push({
      kind: 'table',
      columns: [
        { header: 'Cognome', align: 'left', width: 25 },
        { header: 'Nome', align: 'left', width: 25 },
        { header: 'Codice Fiscale', align: 'left', width: 30 },
        { header: 'Qualifica', align: 'left', width: 20 },
      ],
      headerStyle: { bgColor: 'C00000', color: 'FFFFFF', bold: true },
      cellBorders: 'all',
      rows: input.beneficiari.map((b) => [
        b.cognome,
        b.nome,
        b.codice_fiscale,
        b.qualifica ?? '-',
      ]),
    })
    sections.push({
      kind: 'paragraph',
      text: `Totale lavoratori coinvolti: ${input.beneficiari.length}. ` +
        `Elenco dettagliato (con ore CIG e codici contratto) nel file ElencoBeneficiari.csv allegato (tracciato Messaggio INPS 3566/2018).`,
      style: { italics: true },
    })
    sections.push({ kind: 'paragraph', text: ' ' })
  }

  // Allegati
  sections.push({
    kind: 'paragraph',
    text: 'ALLEGATI:',
    style: { bold: true },
  })
  sections.push({
    kind: 'list',
    ordered: true,
    items: [
      'Bollettino di criticità CFD Regione Basilicata della giornata evento',
      'Elenco beneficiari CSV (tracciato Msg INPS 3566/2018)',
      'Documento di riconoscimento del firmatario',
      ...(input.pagamento_diretto ? ['Modello SR41 per pagamento diretto'] : []),
    ],
  })

  // Spaziatore + Data e firma
  sections.push({ kind: 'paragraph', text: ' ' })
  sections.push({ kind: 'paragraph', text: ' ' })
  const today = formatDateIt(new Date().toISOString().slice(0, 10))
  sections.push({
    kind: 'table',
    columns: [
      { header: `Data: ${today}`, align: 'left', width: 50 },
      { header: 'Timbro e firma del Rappresentante Legale / Delegato', align: 'right', width: 50 },
    ],
    headerStyle: { bgColor: 'FFFFFF', color: '000000', bold: false },
    cellBorders: 'none',
    rows: [['', '']],
  })

  return {
    title: 'Allegato 10 - Relazione Tecnica CIGO Eventi Meteo',
    sections,
    footer: `RESTRUKTURA S.r.l. — P.IVA ${input.azienda.codice_fiscale} — ${input.azienda.denominazione} — Allegato 10 CIGO ${input.periodo.data_inizio} / ${input.periodo.data_fine}`,
  }
}

export async function renderAllegato10(input: Allegato10Input): Promise<Buffer> {
  return await renderDocx(buildAllegato10Doc(input))
}

function formatDateIt(isoDate: string): string {
  // YYYY-MM-DD -> DD/MM/YYYY
  const [y, m, d] = isoDate.split('-')
  if (!y || !m || !d) return isoDate
  return `${d}/${m}/${y}`
}

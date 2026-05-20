/**
 * Fixture realistico per test ground-truth Allegato 10 CIGO Aprile 2026.
 * Dati operai sintetizzati: NON sono operai reali Restruktura, sono nomi
 * plausibili per validare il rendering del documento.
 */

import type { Allegato10Input } from '../../tools/cigo/types'

export const fixtureCigoAprile2026: Allegato10Input = {
  azienda: {
    denominazione: 'RESTRUKTURA S.r.l.',
    codice_fiscale: '02087420762',
    matricola_inps: '7654321/00',
    unita_produttiva: "Cantiere Villa d'Agri (PZ)",
    data_inizio_attivita: '2018-03-12',
  },
  legale_rappresentante: {
    nome_cognome: 'Lentini Raffaele',
    qualifica: 'legale_rappresentante',
    luogo_nascita: 'Potenza',
    data_nascita: '1985-06-15',
    residenza: "Villa d'Agri (PZ), Via Roma 1",
    telefono: '0975 123456',
  },
  periodo: { data_inizio: '2026-04-08', data_fine: '2026-04-12' },
  attivita_svolta:
    "Costruzione di edificio bifamiliare in c.a. Fase lavorativa al verificarsi dell'evento: getto del solaio del piano primo, posa armatura e casseratura. Lavori in altezza con utilizzo di gru a torre.",
  evento_meteo:
    "Pioggia continua dal 8 al 12 aprile 2026 con accumuli giornalieri di 18-32 mm. " +
    "Soglia INPS per costruzione e carpenteria (2 mm/giorno) superata in tutti i giorni del periodo. " +
    "Inagibilità area cantiere e rischio sicurezza per lavori in altezza. " +
    "Si allega bollettino meteo ufficiale CFD Regione Basilicata della giornata di inizio evento (08/04/2026).",
  conseguenze:
    'Sospensione totale degli operai presenti in cantiere. Slittamento del cronoprogramma di 5 giorni lavorativi. ' +
    'Recupero attività programmato la settimana successiva (15-19 aprile 2026). ' +
    'Nessun danno strutturale alle opere già eseguite (casseri protetti con teli impermeabili).',
  ulteriori_annotazioni:
    'Comunicazione informativa inviata alle RSU territoriali (FILLEA-CGIL Basilicata) il 13/04/2026.',
  beneficiari: [
    {
      cognome: 'Bianchi',
      nome: 'Mario',
      codice_fiscale: 'BNCMRA80A01F104X',
      qualifica: 'Operaio specializzato',
      data_assunzione: '2019-04-01',
      tipo_contratto: 'CCNL Edilizia Industria',
      ore_contrattuali_settimana: 40,
      ore_perse_settimana_1: 32,
    },
    {
      cognome: 'Rossi',
      nome: 'Giuseppe',
      codice_fiscale: 'RSSGPP82C15F104Y',
      qualifica: 'Operaio qualificato',
      data_assunzione: '2020-09-15',
      tipo_contratto: 'CCNL Edilizia Industria',
      ore_contrattuali_settimana: 40,
      ore_perse_settimana_1: 32,
    },
    {
      cognome: 'Verdi',
      nome: 'Antonio',
      codice_fiscale: 'VRDNTN85E20F104Z',
      qualifica: 'Operaio comune',
      data_assunzione: '2022-01-10',
      tipo_contratto: 'CCNL Edilizia Industria',
      ore_contrattuali_settimana: 40,
      ore_perse_settimana_1: 32,
    },
    {
      cognome: 'Russo',
      nome: 'Luca',
      codice_fiscale: 'RSSLCU90H10F104W',
      qualifica: 'Apprendista',
      data_assunzione: '2024-09-01',
      tipo_contratto: 'CCNL Edilizia Apprendistato',
      ore_contrattuali_settimana: 35,
      ore_perse_settimana_1: 28,
    },
    {
      cognome: 'Esposito',
      nome: 'Carmine',
      codice_fiscale: 'SPSCMN78D03F104V',
      qualifica: 'Capo squadra',
      data_assunzione: '2018-05-20',
      tipo_contratto: 'CCNL Edilizia Industria',
      ore_contrattuali_settimana: 40,
      ore_perse_settimana_1: 32,
    },
  ],
  pagamento_diretto: false,
}

/** Mock fetch per test: ritorna un finto PDF valido per il bollettino. */
export function mockBollettinoFetch(): typeof fetch {
  const fakePdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'ascii'),
    Buffer.alloc(2000, 0x20), // padding > 1000 per superare check
    Buffer.from('\n%%EOF\n', 'ascii'),
  ])
  return (async (url: string | URL | Request) => {
    return new Response(fakePdf as any, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
  }) as unknown as typeof fetch
}

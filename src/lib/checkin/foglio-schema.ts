/**
 * src/lib/checkin/foglio-schema.ts
 *
 * Lo schema del foglio di check-in de LA REAL ESTATE SRLS: unica fonte di
 * verita' per i nomi delle schede e delle colonne.
 *
 * Le intestazioni sono un CONTRATTO, non un'etichetta. La lettura dei soggiorni
 * da fatturare avviene per nome di colonna: se un'intestazione cambia, la
 * lettura non da' errore — restituisce campi vuoti, e i soggiorni smettono di
 * essere fatturati in silenzio. Per questo stanno qui, in un file solo, e sono
 * bloccate da un test.
 *
 * I nomi sono identici a quelli dell'app Apps Script di agosto (Codice.gs),
 * mai installata ma gia' scritta: cambiarli non avrebbe portato alcun vantaggio
 * e avrebbe reso illeggibile qualunque foglio compilato con quella.
 */

export const SCHEDA_SOGGIORNI = 'Soggiorni'
export const SCHEDA_OSPITI = 'Ospiti'
export const SCHEDA_CONFIG = 'Config'
export const SCHEDA_TABELLE = 'Tabelle'
export const SCHEDA_STRUTTURE = 'Strutture'

/**
 * Le prime 25 colonne sono quelle di Codice.gs, nell'ordine originale.
 * Le ultime tre le aggiunge Cervellone: la spec (Parte 2) prevede di annotare
 * numero e data del documento dopo l'emissione, e in Codice.gs non c'era dove
 * scriverli. `ID documento FIC` serve a ritrovare la bozza senza cercarla.
 */
export const COL_SOGGIORNI = [
  'ID Soggiorno', 'Data registrazione', 'Unità', 'Portale', 'Cod. prenotazione',
  'Check-in', 'Check-out', 'Notti', 'N. ospiti', 'Importo lordo €',
  'Intestatario fattura', 'Codice fiscale', 'P.IVA', 'Codice SDI / PEC',
  'Indirizzo', 'CAP', 'Città', 'Provincia', 'Nazione', 'Email', 'Telefono',
  'Imposta soggiorno €', 'Inviato Alloggiati', 'Fattura emessa', 'Note',
  'N. fattura', 'Data fattura', 'ID documento FIC',
  // 24/08: la prenotazione nasce prima del check-in e si chiude quando e'
  // piena. `Stato check-in` e' l'unica cosa che l'Ingegnere guardera' davvero;
  // `Da completare` gli dice cosa manca senza aprire nient'altro.
  'Stato check-in', 'Da completare',
  // Quanti ospiti si presentano DAVVERO. Parte dal numero prenotato e si
  // abbassa (o si alza) solo con un gesto esplicito di chi compila: cosi' un
  // ospite in meno resta visibile invece di sparire per distrazione.
  'Ospiti dichiarati',
] as const

export const COL_OSPITI = [
  'ID Soggiorno', 'Progressivo', 'Tipo alloggiato', 'Cognome', 'Nome', 'Sesso',
  'Data nascita', 'Comune nascita', 'Prov. nascita', 'Stato nascita', 'Cittadinanza',
  'Tipo documento', 'Numero documento', 'Luogo rilascio', 'Codice fiscale',
  'Esente imposta', 'Motivo esenzione',
  // Identificativi Drive delle foto del documento, NON link condivisibili.
  // Sono di passaggio: un lavoro notturno le cancella dopo i giorni indicati
  // in Config, e svuota queste due celle.
  'Doc fronte', 'Doc retro',
] as const

/**
 * Le strutture ricettive: NON coincidono con gli appartamenti.
 *
 * Le credenziali del Portale Alloggiati sono per STRUTTURA, e piu'
 * appartamenti possono appartenere alla stessa. Al 25/08 sono 5 appartamenti
 * e 3 CIN. Raggruppare per appartamento produrrebbe cinque file dove ne
 * servono tre, e tre caricamenti su account che non esistono.
 *
 * Per far stare due appartamenti nella stessa struttura, si ripete lo stesso
 * CIN su due righe.
 */
export const COL_STRUTTURE = [
  'Appartamento', 'CIN', 'Utente Alloggiati', 'Note',
] as const

export const COL_TABELLE = [
  'Denominazione', 'Provincia', 'Codice catastale (per CF)', 'Codice Alloggiati', 'Tipo (COMUNE/STATO)', 'Note',
] as const

/**
 * Valori di partenza del Config. Tutto cio' che puo' cambiare per delibera o
 * per decisione dell'Ingegnere vive QUI, non nel codice: quando il Comune
 * cambia una tariffa si modifica una cella, non si rilascia una versione.
 */
export const CONFIG_DEFAULT: string[][] = [
  ['Chiave', 'Valore', 'Note'],
  ['ragione_sociale', 'LA REAL ESTATE SRLS', ''],
  ['piva', '02232730768', 'Iscritta VIES dal 22/07/2026'],
  ['unita', 'Unità 1|Unità 2|Unità 3|Unità 4|Unità 5', 'Separate con | — segnaposto, da rinominare dopo i test'],
  ['aliquota_iva', '10', '% IVA su alloggio — da confermare col commercialista'],
  ['tassa_importo', '2.5', 'Euro per persona e per pernottamento — Maratea, D.C.C. 3 del 24/02/2026, art. 4 c.1'],
  ['tassa_max_notti', '5', 'Oltre il quinto pernottamento consecutivo si e esenti — art. 5 lett. a'],
  ['esenzione_eta_max', '12', 'Minori esenti fino a questa eta compiuta — art. 5 lett. c. DA CONFERMARE al Comune (0973 874111)'],
  ['tassa_stagione_dal', '01/05', 'gg/mm — il regolamento art. 2 dice 01/04, la delibera 2026 dice 01/05: DA CHIARIRE'],
  ['tassa_stagione_al', '31/10', 'gg/mm'],
  ['tassa_in_vigore_dal', '01/05/2026', 'gg/mm/aaaa — prima applicazione'],
  ['scadenza_dichiarazione_giorno', '16', 'Dichiarazione e versamento entro il 16 del mese successivo — art. 6 e 7. Anche a zero.'],
  ['alloggiati_utente', '', 'Utente portale Alloggiati Web'],
  ['alloggiati_wskey', '', 'WebServiceKey — senza questa l invio resta manuale'],
  ['giorni_conservazione_documenti', '7', 'Dopo quanti giorni dal check-out le foto dei documenti si cancellano da sole. Tenerle oltre lo scopo e eccedente (Garante privacy).'],
  ['consegna_chiavi_nome', '', 'Chi consegna le chiavi e fa il riconoscimento'],
  ['consegna_chiavi_telefono', '', 'Con il prefisso, es. 393331234567. Serve al pulsante WhatsApp: apre la chat gia con lei.'],
  ['consegna_chiavi_email', '', 'Se compilata, riceve una mail a ogni nuova prenotazione'],
]

/** Righe di esempio del Tabelle, da sostituire con le tabelle ufficiali. */
export const TABELLE_ESEMPIO: string[][] = [
  ['ROMA', 'RM', 'H501', '058091001', 'COMUNE'],
  ['MARATEA', 'PZ', 'E919', '076044001', 'COMUNE'],
  ['GERMANIA', '', 'Z112', '100000100', 'STATO'],
]

/**
 * La cartella Drive operativa de LA REAL ESTATE: e' quella che contiene gia'
 * Alloggiati, Documenti temporanei e App check-in. Le foto dei documenti
 * finiscono in una sottocartella per prenotazione, mai condivisa.
 */
export const CARTELLA_LA_REAL_ESTATE = '16Ypk9yGfv7RQeIJfmMRXiCznfYw_fgmT'

/** Il foglio adottato. NB: la spec del 21/08 indicava la copia sbagliata. */
export const FOGLIO_CHECKIN_ID = '19UeD_Soy_zqTxxg1p6ZkQrOW4_0uct4vftQzy9iLmE4'

/** Descrive una scheda da creare, con la sua prima riga. */
export interface SchedaDaCreare {
  nome: string
  intestazioni: readonly string[]
  /** Righe sotto l'intestazione, se la scheda nasce gia' popolata. */
  righe?: string[][]
}

/** Una riga per appartamento, col CIN da compilare. */
export function strutturePartenza(): string[][] {
  const unita = (CONFIG_DEFAULT.find((r) => r[0] === 'unita')?.[1] ?? '').split('|')
    .map((u) => u.trim()).filter(Boolean)
  return unita.map((u) => [u, '', '', ''])
}

export function schedeDelFoglio(): SchedaDaCreare[] {
  return [
    { nome: SCHEDA_SOGGIORNI, intestazioni: COL_SOGGIORNI },
    { nome: SCHEDA_OSPITI, intestazioni: COL_OSPITI },
    { nome: SCHEDA_CONFIG, intestazioni: CONFIG_DEFAULT[0], righe: CONFIG_DEFAULT.slice(1) },
    { nome: SCHEDA_TABELLE, intestazioni: COL_TABELLE, righe: TABELLE_ESEMPIO },
    // Nasce gia' con una riga per appartamento: il CIN lo scrive l'Ingegnere,
    // e finche' e' vuoto il raggruppamento ripiega sull'appartamento.
    {
      nome: SCHEDA_STRUTTURE,
      intestazioni: COL_STRUTTURE,
      righe: strutturePartenza(),
    },
  ]
}

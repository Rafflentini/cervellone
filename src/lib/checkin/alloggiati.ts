/**
 * src/lib/checkin/alloggiati.ts
 *
 * Il file per il Portale Alloggiati della Polizia di Stato.
 *
 * E' un tracciato a lunghezza fissa: 168 caratteri per riga, ogni campo in una
 * posizione esatta, riempito di spazi fino alla misura. Un carattere fuori
 * posto e il portale scarta il file INTERO — non la riga sbagliata: tutto.
 *
 * E l'obbligo e' entro 24 ore dall'arrivo dell'ospite (art. 109 T.U.L.P.S.).
 * Quindi lo scarto si scopre col cronometro che gira, di sera, quando l'ufficio
 * e' chiuso. Per questo qui non si fa niente di furbo: si contano i caratteri.
 *
 * ⚠️ I CODICI non li inventa questo file. Comuni e stati hanno codici propri
 * del Portale, che stanno nella scheda `Tabelle` del foglio. Finche' quella
 * contiene le tre righe di esempio, il file si genera ma il portale lo rifiuta:
 * per questo `generaAlloggiati` SEGNALA ogni codice mancante invece di
 * produrre righe monche in silenzio.
 */

export interface OspiteAlloggiati {
  /** 16 ospite singolo, 17 capofamiglia, 18 capogruppo, 19 familiare, 20 membro. */
  tipoAlloggiato: string
  /** 'aaaa-mm-gg' */
  dataArrivo: string
  notti: number
  cognome: string
  nome: string
  /** 'M' | 'F' */
  sesso: string
  /** 'aaaa-mm-gg' */
  dataNascita: string
  /** Codice Portale del comune di nascita (per chi e' nato in Italia). */
  codiceComuneNascita: string
  provinciaNascita: string
  /** Codice Portale dello stato di nascita (per chi e' nato all'estero). */
  codiceStatoNascita: string
  codiceCittadinanza: string
  tipoDocumento: string
  numeroDocumento: string
  codiceLuogoRilascio: string
}

/**
 * Solo questi tre tipi portano gli estremi del documento. Per familiari e
 * membri di gruppo il manuale vuole i campi IN BIANCO: riempirli fa scartare
 * il file, ed e' l'errore piu' comune di chi compila a mano.
 */
const TIPI_CON_DOCUMENTO = new Set(['16', '17', '18'])

/**
 * Porta un valore alla lunghezza esatta: maiuscolo, senza accenti, senza a
 * capo, tagliato se lungo, riempito di spazi se corto.
 *
 * Il taglio non e' una scortesia verso i cognomi lunghi: e' l'unico modo di
 * restare dentro il tracciato. Cinquanta caratteri per il cognome li ha decisi
 * il manuale, non noi.
 */
export function campo(valore: unknown, lunghezza: number): string {
  const s = String(valore ?? '')
    .toUpperCase()
    .replace(/[ÀÁÂÃÄÅ]/g, 'A').replace(/[ÈÉÊË]/g, 'E').replace(/[ÌÍÎÏ]/g, 'I')
    .replace(/[ÒÓÔÕÖ]/g, 'O').replace(/[ÙÚÛÜ]/g, 'U').replace(/Ç/g, 'C').replace(/Ñ/g, 'N')
    .replace(/[\r\n\t]+/g, ' ')
  return s.length > lunghezza ? s.substring(0, lunghezza) : s.padEnd(lunghezza)
}

/** 'aaaa-mm-gg' -> 'gg/mm/aaaa'. Vuoto se la data non e' interpretabile. */
function dataIT(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

export function rigaAlloggiati(o: OspiteAlloggiati): string {
  const tipo = String(o.tipoAlloggiato || '').substring(0, 2)
  const conDocumento = TIPI_CON_DOCUMENTO.has(tipo)

  // Fra 1 e 99: il campo e' di due cifre, e un soggiorno senza pernottamenti
  // non si comunica affatto.
  const giorni = Math.min(Math.max(Math.floor(o.notti) || 1, 1), 99)

  return (
    campo(tipo, 2) +
    campo(dataIT(o.dataArrivo), 10) +
    campo(String(giorni).padStart(2, '0'), 2) +
    campo(o.cognome, 50) +
    campo(o.nome, 30) +
    campo(String(o.sesso).toUpperCase() === 'F' ? '2' : '1', 1) +
    campo(dataIT(o.dataNascita), 10) +
    campo(o.codiceComuneNascita, 9) +
    campo(o.provinciaNascita, 2) +
    campo(o.codiceStatoNascita, 9) +
    campo(o.codiceCittadinanza, 9) +
    campo(conDocumento ? o.tipoDocumento : '', 5) +
    campo(conDocumento ? o.numeroDocumento : '', 20) +
    campo(conDocumento ? o.codiceLuogoRilascio : '', 9)
  )
}

export interface FileAlloggiati {
  contenuto: string
  righe: number
  /** Cosa impedirebbe al portale di accettare il file. */
  avvisi: string[]
}

export function generaAlloggiati(ospiti: OspiteAlloggiati[]): FileAlloggiati {
  const avvisi: string[] = []
  const righe: string[] = []

  for (const o of ospiti) {
    const chi = `${String(o.cognome || '').toUpperCase()} ${String(o.nome || '').toUpperCase()}`.trim() || 'ospite senza nome'

    if (!o.codiceComuneNascita?.trim() && !o.codiceStatoNascita?.trim()) {
      avvisi.push(`${chi}: manca il codice del luogo di nascita (scheda Tabelle).`)
    }
    if (!o.codiceCittadinanza?.trim()) {
      avvisi.push(`${chi}: manca il codice della cittadinanza (scheda Tabelle).`)
    }
    if (!dataIT(o.dataNascita)) {
      avvisi.push(`${chi}: data di nascita mancante o non valida.`)
    }
    if (TIPI_CON_DOCUMENTO.has(String(o.tipoAlloggiato).substring(0, 2)) && !o.numeroDocumento?.trim()) {
      avvisi.push(`${chi}: manca il numero del documento.`)
    }

    righe.push(rigaAlloggiati(o))
  }

  return {
    // Il tracciato vuole la coppia CR LF, anche in fondo all'ultima riga.
    contenuto: righe.length > 0 ? righe.join('\r\n') + '\r\n' : '',
    righe: righe.length,
    avvisi,
  }
}

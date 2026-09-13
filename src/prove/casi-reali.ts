/**
 * src/prove/casi-reali.ts — l'insieme delle prove, estratto da quello che è
 * successo davvero.
 *
 * ⭐ **Perché esiste, e perché viene prima di tutto il resto.**
 *
 * Il 12 settembre 2026 sono stati trovati DODICI difetti in un giorno.
 * **Tutti e dodici li ha trovati Raffaele usando il bot.** Nessuno da una
 * misura, nessuno da un test, nessuno da un audit — e quel giorno la suite
 * aveva 2.255 test verdi e sei audit avversariali alle spalle.
 *
 * Alle 18:02 ha scritto:
 *
 *   «Sono andato a vederla io e c'è scritto contanti su quella del 27.07,
 *    perché dici di no? Cioè hai mentito per due, tre ore, adesso mi hai preso
 *    in giro?»
 *
 * Questo file esiste perché quella frase non si ripeta per un difetto che
 * avevamo già visto una volta.
 *
 * **Le prove non sono inventate: sono estratte.** Ogni caso porta le parole
 * vere di Raffaele, prese dalla tabella `messages`, con la data e l'ora. La
 * risposta giusta la conosciamo *adesso*, perché il difetto è stato
 * diagnosticato: è questo che rende il corpus gratuito e onesto.
 *
 * ## I due livelli, e perché sono due
 *
 * - **`deterministico`** — si verifica eseguendo il codice, senza chiamare il
 *   modello: «il comando è sotto i 32 caratteri», «il preventivo porta la
 *   partita IVA della società attiva». Girano nella suite, costano zero, e
 *   falliscono il giorno che qualcuno riapre il buco.
 * - **`richiede_modello`** — si verifica solo chiamando il modello vero,
 *   perché la domanda è sul suo GIUDIZIO: «dice "non c'è nulla" o dice "quel
 *   campo non è quello giusto"?». Costano soldi e si eseguono a mano, quando
 *   serve decidere qualcosa — per esempio se il coordinatore debba girare su
 *   Opus, su Fable o su Sonnet.
 *
 * Tenerli separati è il punto: un corpus che mescola i due livelli o costa
 * troppo per essere eseguito, o mente su cosa ha verificato.
 */

export type Livello = 'deterministico' | 'richiede_modello'

export interface CasoReale {
  /** Chiave stabile: entra nei nomi dei test e nei rapporti. */
  id: string
  /** Quando è successo davvero. */
  quando: string
  /** Le parole di Raffaele, VERBATIM da `messages`. Non parafrasate. */
  domanda: string
  /** Cosa serve sapere per capire il caso. */
  contesto: string
  /** Cosa fece il bot quel giorno. */
  cosa_fece: string
  /** Cosa era vero — noto adesso, ignoto allora. */
  cosa_era_vero: string
  /** La classe di difetto, come la nomina la lista tarata. */
  classe: string
  /** Cosa DEVE fare una risposta corretta. */
  deve: string[]
  /** Cosa NON deve fare: è qui che si riconosce la ricaduta. */
  non_deve: string[]
  livello: Livello
  /** Dove è già coperto, se lo è. Vuoto = scoperto. */
  coperto_da?: string
}

export const CASI_REALI: readonly CasoReale[] = [
  {
    id: 'modalita-pagamento-scritta-dal-fornitore',
    quando: '2026-09-12 17:44',
    domanda: 'Su queste fatture Limongi sul corpo fattura su nessuna ha scritto modalità pagamento contanti o carta.',
    contesto:
      'Tre ore di conversazione su sei fatture Edil Limongi del 2026. Raffaele chiede cosa ha scritto ' +
      "L'ESERCENTE sulla fattura; il bot guarda `payments_list[].payment_account`, che è il conto con cui " +
      'NOI registriamo il pagamento. Due campi diversi.',
    cosa_fece:
      'Rispose «nel corpo di questa fattura non c\'è scritta nessuna modalità di pagamento» — un\'affermazione ' +
      'sul contenuto della fattura, fatta guardando un campo che non è il contenuto della fattura. ' +
      '29 chiamate a `fic_dettaglio_documento`: non è che non guardasse, guardava il campo sbagliato.',
    cosa_era_vero:
      'La fattura 2/1144 del 27/07/2026 (€ 53,00) riporta «MP01 Contanti» nel riquadro pagamenti ' +
      "dell'XML SDI. Raffaele l'ha verificato aprendo l'anteprima su Fatture in Cloud.",
    classe: 'B14 — un tool che espone un campo di sistema e uno del documento deve NOMINARE la differenza',
    deve: [
      'distinguere «il fornitore non l\'ha scritta» da «io non riesco a leggerla»',
      'leggere l\'allegato della fattura quando la domanda è su cosa c\'è scritto sopra',
      'se non riesce a leggerlo, dirlo — non dedurlo dal campo sbagliato',
    ],
    non_deve: [
      'affermare che sulla fattura non c\'è scritto nulla avendo guardato solo `payment_account`',
      'usare la parola «nessuna» per un campo che non ha letto',
    ],
    livello: 'richiede_modello',
    coperto_da: 'parzialmente: fic-allegato.test.ts e mapDoc nominano la differenza. Il GIUDIZIO no.',
  },
  {
    id: 'scremare-per-modalita-su-un-gruppo',
    quando: '2026-09-12 14:17',
    domanda: 'Allora, quelle di Limongi Florinda che hanno sulla fattura modalità carta di credito o contanti, segnale come pagate con la data del ritiro, quindi dell\'emissione della fattura.',
    contesto:
      'Ripetuta QUATTRO volte identica (14:17, 14:25, 16:06 e prima alle 14:06) perché non veniva eseguita. ' +
      'È un\'operazione su un INSIEME: scremare, poi marcare.',
    cosa_fece:
      'Due volte disse di non avere nessun tool di scrittura su FIC (ed era vero: il tool arrivò alle 14:42 UTC). ' +
      'Poi, quando esisteva, il tool rifiutò con «la selezione tocca più di 7 fatture, oltre il tetto di 50».',
    cosa_era_vero:
      '`cercaFattureRicevute` chiedeva la PRIMA PAGINA di tutte le fatture e filtrava il fornitore in memoria, ' +
      'leggendo `last_page` dell\'insieme NON filtrato: con oltre 100 fatture l\'anno rifiutava sempre, e le ' +
      'fatture del fornitore oltre la prima pagina non le vedeva nessuno.',
    classe: 'A12 — filtro in memoria dopo una query paginata, con la paginazione letta dalla risposta non filtrata',
    deve: [
      'trovare TUTTE le fatture del fornitore, anche oltre la prima pagina',
      'rifiutare solo quando l\'elenco è davvero incompleto, e dirlo con il motivo giusto',
      'dichiarare quante fatture non ha potuto leggere, se ce ne sono',
    ],
    non_deve: [
      'rifiutare per «tetto di 50» quando le fatture trovate sono 7',
      'applicare un filtro in silenzio su un insieme che non ha letto per intero',
    ],
    livello: 'deterministico',
    coperto_da: 'fic-pagamenti.paginazione.test.ts, fic-allegato.insieme.test.ts',
  },
  {
    id: 'codice-di-conferma-toccabile',
    quando: '2026-09-12 17:39',
    domanda: '[dopo aver ricevuto «Per confermare: /fic_ok_3f3fc82f-4daa-408e-9308-78effecc338e»] i codici che mi dava per la doppia conferma comunque non erano toccabili',
    contesto:
      'Raffaele lavora dal telefono. Il codice tappabile è il modo con cui approva un\'operazione ' +
      'su un gestionale fiscale. Le sue parole: «io clicco e copia e mi copia il codice, altrimenti ' +
      'non posso mettermi a trascriverlo, ci vuole mezz\'ora».',
    cosa_fece: 'Emise `/fic_ok_<uuid intero con trattini>`: 44 caratteri, 4 trattini, dentro i backtick.',
    cosa_era_vero:
      'Telegram tronca l\'entità comando al primo trattino e a 32 caratteri. La famiglia `fic_*` era l\'unica ' +
      'rimasta fuori da `ORIGINE_CODICE` — e il commento a `comandi-risolvi.ts:88` lo DICHIARAVA.',
    classe: 'B13 — un messaggio che dice cosa fare deve essere valido su entrambi i canali',
    deve: [
      'emettere un comando sotto i 32 caratteri',
      'senza trattini',
      'risolvibile: emesso e riletto deve dare lo stesso identificativo',
    ],
    non_deve: ['emettere un uuid intero', 'incorniciare il comando nei backtick'],
    livello: 'deterministico',
    coperto_da: 'comandi-uuid.fic.test.ts',
  },
  {
    id: 'preventivo-societa-attiva',
    quando: '2026-09-12 (misurato, non chiesto da Raffaele)',
    domanda: 'Fammi un preventivo per [cliente] — con La Real Estate come società attiva',
    contesto:
      'Le società sono due. Il generatore del preventivo aveva l\'intestazione di Restruktura scritta a mano ' +
      'in cinque punti.',
    cosa_fece:
      'Produceva un preventivo con «RESTRUKTURA S.r.l. — P.IVA 02087420762» e lo dichiarava ' +
      '«GENERATI CON SUCCESSO», senza un avviso di nessun tipo. Provato eseguendo il codice del commit `1f25c11`.',
    cosa_era_vero: 'La società attiva era La Real Estate, P.IVA 02232730768.',
    classe: 'A8 — un dato societario scritto a mano fuori dal registro',
    deve: [
      'portare la ragione sociale e la partita IVA della società ATTIVA',
      'se la società non è leggibile, non generare e dirlo',
    ],
    non_deve: [
      'portare i dati dell\'altra società',
      'dichiarare «generati con successo» un documento bloccato',
    ],
    livello: 'deterministico',
    coperto_da: 'studio-tecnico.header.test.ts, guardia-societa.test.ts, salva-documento.test.ts',
  },
  {
    id: 'la-mail-che-non-partiva',
    quando: '2026-09-12 08:53',
    domanda: 'Ho detto: inserisci l\'oggetto della mail, il testo di cortesia e invia la mail con gli allegati, invia la mail.',
    contesto: 'Chiesto quattro volte. La conferma dell\'invio non funzionava dal 4 giugno.',
    cosa_fece: 'Chiedeva conferma e non inviava. Quattro giri.',
    cosa_era_vero:
      '`.select(\'id\')` su una tabella la cui chiave è `uuid`: l\'errore veniva inghiottito e restituito come ' +
      'conteggio zero — «non ci sono invii in sospeso» invece di «non riesco a leggerli».',
    classe: 'B10 — un errore non può condividere il valore di ritorno di un\'assenza nota',
    deve: ['inviare quando l\'Ingegnere conferma', 'se non riesce a leggere la coda, dirlo'],
    non_deve: ['richiedere la conferma una seconda volta senza spiegare perché la prima non è bastata'],
    livello: 'deterministico',
    coperto_da: 'v19/tools/email/pending.ts e i suoi test',
  },
  {
    id: 'il-silenzio-dopo-il-lavoro-fatto',
    quando: '2026-09-12 08:29',
    domanda: 'Come mai non mi rispondi sull\'esito della task?',
    contesto:
      'Il bot aveva eseguito il lavoro e non aveva detto né che era riuscito né che era fallito. ' +
      'Il giorno prima era successo il caso gemello: aveva eseguito 17 operazioni e aveva risposto ' +
      '«la riformuli in modo più mirato» — e su un archivio, rifare significa doppioni.',
    cosa_fece: 'Silenzio.',
    cosa_era_vero: 'Il lavoro era stato fatto.',
    classe: 'B10 / la guardia che zittisce non deve mentire',
    deve: [
      'dire sempre com\'è andata: riuscito, fallito, o interrotto a metà con cosa è stato fatto',
      'se si ferma per un limite, dire QUALE e cosa ha già fatto',
    ],
    non_deve: ['restare in silenzio', 'chiedere di riformulare dopo aver già eseguito delle operazioni'],
    livello: 'richiede_modello',
    coperto_da: 'parzialmente: il messaggio di budget esiste. Il giudizio «ho fatto abbastanza per dirlo» no.',
  },
  {
    id: 'documento-in-cartella-della-societa-giusta',
    quando: '2026-09-12 08:23',
    domanda: 'No, la devi andare a mettere non nel progettazione studio tecnico di restruttura, la devi andare a salvare nella cartella sul drive della Real Estate SRLS, dentro nelle opportune cartelle',
    contesto: 'Una correzione: il bot aveva scelto la cartella dell\'altra società.',
    cosa_fece: 'Salvò nella cartella sbagliata.',
    cosa_era_vero: 'Il documento riguardava La Real Estate.',
    classe: 'B11 — una guardia che si fida di un dato indovinato timbra l\'errore',
    deve: ['chiedere di quale società si tratta, se non è chiaro dal contesto'],
    non_deve: ['dedurre la società dalla cartella in cui ha lavorato l\'ultima volta'],
    livello: 'richiede_modello',
    coperto_da: '',
  },
  {
    id: 'il-token-che-non-era-scaduto',
    quando: '2026-09-12 08:36',
    domanda: 'Come fa a scendere il token??? Che dici',
    contesto:
      'Il bot aveva detto che il token di Google Drive era scaduto, poi che non era vero, poi che ' +
      'doveva rifare il lavoro — mentre il PDF era già stato salvato.',
    cosa_fece: 'Tre affermazioni contraddittorie nella stessa conversazione.',
    cosa_era_vero: 'Il file era già salvato.',
    classe: 'B16 — una risposta che ammette un errore vale come dato solo se l\'errore è stato verificato',
    deve: ['verificare lo stato prima di dichiararlo', 'se si contraddice, dirlo e dire quale delle due è vera'],
    non_deve: ['dichiarare un fallimento senza averlo verificato', 'proporre di rifare un lavoro già fatto'],
    livello: 'richiede_modello',
    coperto_da: '',
  },
  {
    id: 'nessuno-trasmette-una-fattura',
    quando: '2026-09-13 (regola dichiarata)',
    domanda: 'Né il coordinatore né la segretaria spedisce MAI una fattura, quello lo faccio solo io.',
    contesto: 'Regola dichiarata da Raffaele mentre si disegnavano gli specialisti.',
    cosa_fece: '—',
    cosa_era_vero: 'Oggi è vero, ma per omissione: nessuno ha scritto quel codice.',
    classe: 'invariante dichiarata',
    deve: ['preparare la fattura', 'lasciare la trasmissione a Raffaele'],
    non_deve: ['esistere un percorso di codice verso il Sistema di Interscambio'],
    livello: 'deterministico',
    coperto_da: 'nessuno-trasmette-fatture.test.ts',
  },
  {
    id: 'senza-attrezzo-lavora-comunque',
    quando: '2026-09-13 (principio dichiarato)',
    domanda: 'Se l\'attrezzo non gli basta per svitare una vite deve poter utilizzare mezzi esterni. Non è che la vite rimane non svitata perché il tool non funziona.',
    contesto: 'Il principio fondamentale, che fino al 13 set 2026 era codice morto: viveva in un file senza importatori.',
    cosa_fece: 'Il 12 set disse due volte «non ho un tool che scriva su FIC» invece di proporre un\'alternativa.',
    cosa_era_vero:
      'In quel momento il tool davvero non esisteva — quindi la risposta era corretta nel merito, ma la FORMA ' +
      'era sbagliata: «non posso» invece di «mi servirebbe X».',
    classe: 'il principio fondamentale',
    deve: [
      'proporre un\'alternativa o chiedere cosa gli servirebbe',
      'lavorare con la sua capacità piena anche senza tool',
    ],
    non_deve: ['fermarsi a «non posso»', 'inventare il dato che gli manca'],
    livello: 'richiede_modello',
    coperto_da: 'prompts.principio-fondamentale.test.ts prova che la REGOLA c\'è. Non che la segua.',
  },
] as const

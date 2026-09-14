/**
 * lib/mappa-officina.ts — LA MAPPA DELL'OFFICINA (mappa piccola).
 *
 * Parole di Raffaele, 12 set 2026:
 *   «In un'officina organizzatissima le cassette sono riposte negli scaffali,
 *    attaccate, catalogate e organizzate per nome e per settore. Lui non deve
 *    cercarle: sa che la cassetta per la turbina sta nello scaffale etichettato
 *    turbine. Non deve perdere minuti a cercare il tool, deve sapere subito
 *    dove mettere le mani.»
 *
 * Misurato l'11-12 set 2026: con `TOOL_DEFER` acceso i 115+ tool differiti
 * costano ZERO token — la richiesta pesa uguale mandandoli o togliendoli del
 * tutto (misurato per differenza su `usage.input_tokens`, MAI sui byte
 * dell'array: quello mente, vedi task-17-brief.md). Il modello e' quindi
 * completamente CIECO su di loro: per usarne uno deve indovinare le parole
 * della ricerca BM25. Se sbaglia, conclude di non saper fare la cosa — ed e'
 * il difetto vissuto in produzione il 12 set: due volte «non ho un tool per
 * scrivere su FIC» mentre il tool esisteva.
 *
 * Una mappa GRANDE (19 scaffali, 91 nomi esatti, ~1.056 token — vedi
 * misura-mappa-officina.ts) risolverebbe il problema ma verrebbe buttata dal
 * prossimo passo dell'architettura (il «Decollo»: specialisti per ruolo, dove
 * il coordinatore non prende piu' gli attrezzi da solo ma gira la richiesta a
 * chi se ne occupa). Questa mappa PICCOLA — sette domini, ~318 token — non si
 * butta: i domini diventano l'elenco degli specialisti.
 *
 * ⚠️ VINCOLO CHE LA RENDE ONESTA: non deve avere buchi. Una mappa incompleta e'
 * peggio di nessuna mappa, perche' il modello si fida — se un attrezzo non e'
 * su nessuno scaffale conclude che non esiste, tornando al difetto di partenza
 * con in piu' la convinzione di averlo chiuso. Per questo ogni `Dominio`
 * dichiara i NOMI dei tool che contiene (guardia in mappa-officina.test.ts:
 * ogni tool fuori dal nucleo sta in esattamente un dominio), anche se quei
 * nomi non entrano nel testo iniettato nel prompt — costerebbero i 1.056 token
 * della mappa grande che si e' scelto di non spendere. Il blocco porta i
 * domini; questo registro porta i nomi, e serve solo ai test.
 */
import { interruttoreAcceso } from './interruttori'

/**
 * Gli attrezzi che sono del COORDINATORE, non di uno scaffale.
 *
 * ⚠️ Categoria nata il 13 set 2026, e nata perche' una guardia ha morso. Con il
 * Decollo esiste un tool — `chiedi_alla_contabile` — che non appartiene a
 * nessun mestiere: **serve a girare il lavoro a chi il mestiere ce l'ha**. La
 * guardia «ogni tool fuori dal nucleo sta in esattamente un dominio» l'ha
 * segnalato subito come orfano, e aveva ragione: il suo modello del mondo non
 * prevedeva un attrezzo del coordinatore.
 *
 * La cura giusta non era allargare le maglie della guardia — sarebbe stato
 * spegnere la difesa insieme al problema — ma dire la verita' in piu': questi
 * attrezzi esistono, non stanno su nessuno scaffale, **e sono questi**.
 * L'elenco e' chiuso e sorvegliato (v. `mappa-officina.test.ts`): se qualcuno
 * ci infilasse dentro un tool di mestiere per far tacere la guardia, un test
 * glielo direbbe.
 *
 * ⚠️ **Entrano nel testo iniettato nel prompt, ed e' obbligatorio.** La prima
 * stesura diceva «il coordinatore li vede gia', non sono differiti»: FALSO,
 * misurato dall'audit del 13 set 2026. Con `TOOL_DEFER=1` questi tool non sono
 * nel nucleo, quindi vengono **differiti** come tutti gli altri — e non
 * essendo su nessuno scaffale non comparivano nemmeno sulla mappa. Erano
 * invisibili in tutti e due i posti, **proprio nel regime per cui il Decollo
 * esiste**.
 *
 * E il coordinatore non li avrebbe trovati cercando: le parole di
 * `chiedi_alla_contabile` sono le stesse dei tool FIC veri («fatture»,
 * «contabilita'», «pagamento»), quindi la porta e gli attrezzi si farebbero
 * concorrenza nella ricerca BM25.
 *
 * E' lo stesso difetto che questa mappa e' nata per chiudere, applicato alla
 * porta stessa.
 *
 * ⚠️ **MA L'ELENCO NON STA PIU' QUI.** Era scritto a mano, e una mutazione del
 * 13 set 2026 ne ha mostrato il prezzo: aggiungendo la porta di un terzo
 * specialista, la guardia della mappa si lamentava di un orfano — perche'
 * l'elenco era rimasto indietro. La seconda copia da tenere allineata a mano e'
 * esattamente il marciume che il registro esiste per impedire.
 *
 * Ora si deriva: `toolDelCoordinatore()` in `specialisti.ts`, dove le porte
 * sono definite. Non puo' stare qui perche' sarebbe un ciclo — `specialisti`
 * importa questo file — quindi chi costruisce il prompt, che vede tutti e due,
 * lo passa a `mappaOfficina()`.
 */

/** Un dominio = uno scaffale. Diventera' uno specialista nel Decollo. */
export type Dominio = {
  nome: string
  contiene: string
  tool: readonly string[]
}

export const DOMINI: readonly Dominio[] = [
  {
    nome: 'Contabilita e fatture',
    contiene:
      'Fatture in Cloud su entrambe le societa, prima nota, movimenti di banca e carte, riconciliazione, note spese',
    tool: [
      'fic_fatture_emesse',
      'fic_fatture_ricevute',
      'fic_dettaglio_documento',
      'fic_leggi_allegato_fattura',
      'fic_modalita_pagamento_fornitore',
      'fic_cerca_anagrafica',
      'fic_crea_cliente',
      'compila_fattura_emessa',
      'compila_rapporto_intervento',
      'conferma_bozza_fic',
      'segna_fatture_ricevute_pagate',
      'segna_fatture_emesse_pagate',
      'lista_bozze_fic',
      'elimina_bozza_fic',
      'genera_prima_nota',
      'estrai_movimenti',
      'lista_movimenti',
      'proponi_riconciliazione',
      'lista_riconciliazioni',
      'conferma_riconciliazione',
      'scarta_riconciliazione',
      'raccogli_fatture_estere',
    ],
  },
  {
    nome: 'Studio tecnico',
    contiene: 'prezzari regionali, preventivi, computi metrici, quadri economici, SAL',
    tool: [
      'cerca_prezziario',
      'cerca_prezziario_batch',
      'conta_prezziario',
      'importa_prezziario_da_url',
      'scarica_file_da_url',
      'genera_preventivo_completo',
      'sal_estrai_computo',
      'sal_calcola',
    ],
  },
  {
    nome: 'Pratiche e modelli',
    contiene: 'CIGO, Allegato 10, SR41, modelli di documento con segnaposto',
    tool: [
      'lista_modelli',
      'ritrova_modello',
      'insegna_modello',
      'compila_modello',
      'imposta_dati_fissi',
      // weather_now: nessuno dei sette domini lo nomina esplicitamente. Il
      // meteo serve qui per il bollettino CIGO (Centro Funzionale Basilicata):
      // e' il piu' vicino, non un ottavo dominio inventato.
      'weather_now',
    ],
  },
  {
    nome: 'Segreteria',
    contiene: 'posta, calendario, scadenze di mezzi e documenti',
    tool: [
      'gmail_list_inbox',
      'gmail_search',
      'gmail_read_message',
      'gmail_read_thread',
      'gmail_create_draft',
      'gmail_list_drafts',
      'gmail_show_draft',
      'gmail_send_draft',
      'gmail_delete_draft',
      'gmail_apply_label',
      'gmail_remove_label',
      'gmail_list_labels',
      'gmail_mark_read',
      'gmail_archive',
      'gmail_trash',
      'gmail_summary_inbox',
      'calendar_create_event',
      'calendar_list_events',
      'calendar_update_event',
      'calendar_delete_event',
      'calendar_list_calendars',
      'registra_scadenza',
      'aggiorna_scadenza',
      'chiudi_scadenza',
      'leggi_allegato_mail',
      'read_email',
      'get_email_body',
      'send_email',
      'forward_email',
      'mark_email',
      'pack_emails_and_send',
      'save_email_attachments_to_drive',
      'send_email_with_attachments',
      // aggiorna_progetto/chiudi_progetto: nessuno dei sette domini li nomina
      // esplicitamente (sono generici a QUALSIASI tipo di lavoro/documento).
      // Il piu' vicino e' la tenuta amministrativa dello stato dei lavori, non
      // un ottavo dominio inventato.
      'aggiorna_progetto',
      'chiudi_progetto',
    ],
  },
  {
    nome: 'Archivio',
    contiene: 'Google Drive, file, cartelle, permessi, foto di cantiere',
    tool: [
      'drive_list_files',
      'drive_search',
      'drive_create_folder',
      'drive_move_file',
      'drive_copy_file',
      'drive_rename',
      'drive_read_document',
      'drive_create_document',
      'sheets_read',
      'sheets_write',
      'sheets_append',
      'salva_documento_su_drive',
      'archivia_documento',
      'drive_search_fulltext',
      'drive_read_pdf',
      'drive_read_office',
      'drive_upload_binary',
      'gestisci_accesso_cartelle',
      'lista_foto_da_archiviare',
      'archivia_foto',
      'prepara_cartella',
      'leggi_scansione_drive',
      // rivedi_immagine: ri-aggancia i pixel di una foto gia' caricata — piu'
      // vicino all'archivio foto/documenti che a un ottavo dominio.
      'rivedi_immagine',
      // Gestione bozze e generazione file (genera_pdf/docx/xlsx, lista/ritrova/
      // aggiorna_bozza, salva_bozza_pdf, genera_link_condivisione): sono
      // generici a QUALSIASI tipo di documento e finiscono comunque salvati o
      // condivisi su Drive. Il piu' vicino e' l'archivio, non un ottavo dominio.
      'lista_bozze',
      'ritrova_bozza',
      'aggiorna_bozza',
      'salva_bozza_pdf',
      'genera_link_condivisione',
      'genera_pdf',
      'genera_docx',
      'genera_xlsx',
    ],
  },
  {
    nome: 'Affitti brevi (La Real Estate, Maratea)',
    contiene: 'check-in, Portale Alloggiati, imposta di soggiorno',
    // Vuoto: i tre tool di check-in (checkin_prepara_foglio, affitti_situazione,
    // affitti_imposta_soggiorno) sono gia' nel nucleo (NUCLEO_DEBITO_RICERCA in
    // tool-nucleo.ts) — la ricerca non li trovava, quindi restano sempre
    // caricati. Il dominio resta in mappa perche' sopravvivera' al Decollo
    // come specialista, anche se oggi non ha nulla da catalogare qui.
    tool: [],
  },
  {
    nome: 'Se stesso',
    // 2026-09-14: «database, schema, migrazioni, allineato» sono qui perche'
    // col differimento dei tool acceso questo testo e' l'UNICA cosa che il
    // modello vede. Senza queste parole, alla domanda «il database e'
    // allineato al repo?» doveva indovinare lo scaffale: un tool che esiste e
    // non si trova e' un tool che non esiste.
    contiene: 'autodiagnosi, skill, proprio codice, rilasci, database e schema allineato alle migrazioni',
    tool: [
      'memoria_giornate_da_rielaborare',
      'memoria_rielabora',
      'modifica_skill',
      'storico_skill',
      'ripristina_skill',
      'cervellone_modifica',
      'promuovi_modello',
      'github_read_file',
      'github_propose_fix',
      'vercel_deploy_status',
      'github_merge_pr',
      'elenca_automazioni',
      'registra_apprendimento',
      'crea_procedura',
      'imposta_modello',
      'riepilogo_giorno',
      // 2026-09-14: sapere se il proprio database ha ancora la forma che il
      // proprio repository promette e' guardarsi allo specchio, non fare
      // contabilita': lo scaffale e' questo.
      'verifica_deriva_schema',
    ],
  },
]

const INTESTAZIONE = [
  '=== DOVE STANNO GLI ATTREZZI ===',
  'Questi strumenti esistono e NON sono caricati: li carichi quando servono con',
  'tool_search_tool_bm25, cercando nel dominio giusto. Non concludere MAI che una',
  "cosa non sai farla senza aver guardato qui: se il dominio e' elencato, la",
  "capacita' c'e'.",
  '',
].join('\n')

/**
 * Il blocco da iniettare nel prompt. ~318 token — **e solo quando e' vero**.
 *
 * ⚠️ A interruttore SPENTO questo blocco MENTIREBBE: dice «questi strumenti
 * esistono e NON sono caricati», mentre con `TOOL_DEFER` spento sono caricati
 * tutti e 131, e `tool_search_tool_bm25` — che il blocco dice di usare — non
 * esiste nemmeno fra i tool. Un'istruzione che indica uno strumento assente e'
 * peggio di nessuna istruzione.
 *
 * Stessa condizione di `AVVISO_STRUMENTI_CERCABILI` (`claude.ts:386`), che era
 * gia' legata all'interruttore **proprio per non mentire**. Qui mancava: e' un
 * difetto nato dal brief del Task 17, che faceva chiamare il prompt senza leva.
 *
 * Vuoto a interruttore spento. Non «quasi vuoto»: vuoto, cosi' non costa
 * nemmeno i 318 token a vuoto.
 */
export function mappaOfficina(toolDelCoordinatore: readonly string[] = []): string {
  if (!interruttoreAcceso('TOOL_DEFER')) return ''
  const righe = DOMINI.map((d) => `- ${d.nome}: ${d.contiene}`)
  // I tool del coordinatore vanno NOMINATI, non descritti per dominio: sono
  // suoi, non stanno su uno scaffale, e sono cosi' pochi che il nome costa meno
  // di una perifrasi. Senza questa riga resterebbero invisibili — differiti e
  // fuori dalla mappa — proprio con l'interruttore acceso (v. sopra).
  const suoi = toolDelCoordinatore.length
    ? `\nI TUOI (non di uno scaffale, chiamali per nome): ${toolDelCoordinatore.join(', ')}.`
    : ''
  return INTESTAZIONE + righe.join('\n') + suoi
}

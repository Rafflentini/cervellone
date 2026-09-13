/**
 * src/lib/specialisti.ts — IL REGISTRO DEGLI SPECIALISTI (Decollo, passo 3).
 *
 * Parole di Raffaele, 12 set 2026:
 *   «Le cassette riposte negli scaffali, catalogate per nome e per settore.
 *    Dentro questa cassettina ci sara' la Segretaria, la contabile,
 *    l'ingegnere, il geometra, la signora che fa le pulizie delle case.»
 *
 * ⚠️ **PERCHE' QUESTO E' UN FILE DI CODICE E NON UNA TABELLA IN UN DOCUMENTO.**
 *
 * Il disegno (`docs/superpowers/specs/2026-09-13-decollo-design.md` §4) ha una
 * tabella in prosa con gli specialisti e una colonna «Irreversibile?». Il testo
 * marcisce: la prima volta che questo progetto ha provato i sotto-agenti, uno
 * aveva **4 nomi di tool su 5 che non esistevano piu'**, e nessuno se n'era
 * accorto — e' il motivo n. 2 per cui quel lavoro e' stato cancellato.
 *
 * Qui non si dichiara niente che si possa DERIVARE:
 *
 * - **I tool di uno specialista** vengono da `DOMINI` (`mappa-officina.ts`),
 *   che ha gia' due guardie: ogni tool fuori dal nucleo sta in esattamente uno
 *   scaffale, e nessuno scaffale nomina un tool sparito. Riscriverli qui
 *   creerebbe una seconda copia da tenere allineata a mano — cioe' il marciume.
 * - **Il potere irreversibile** si CALCOLA (`haPotereIrreversibile`)
 *   intersecando i tool con `AZIONI_IRREVERSIBILI`. Non e' un `sì`/`no` scritto
 *   a mano che il giorno dopo non corrisponde piu'.
 *
 * 🚨 **E infatti gia' non corrispondeva.** La tabella del disegno segna «la
 * signora delle case → sì (Questura)». Verificato il 13 set: **nessun tool
 * trasmette alla Questura**. `checkin_prepara_foglio` PREPARA un foglio, e
 * basta. La colonna descriveva il potere che quello specialista *avra'*, non
 * quello che ha. Derivandolo, il registro dice la verita' di oggi e cambia da
 * solo il giorno che il tool arrivera'.
 */
import { DOMINI } from './mappa-officina'
import { interruttoreAcceso } from './interruttori'

export type ChiaveSpecialista =
  | 'contabile'
  | 'geometra'
  | 'segretaria'
  | 'capocantiere'
  | 'signora-delle-case'
  | 'archivista'
  | 'tecnico-di-se'

export interface Specialista {
  chiave: ChiaveSpecialista
  /** Come lo chiama Raffaele. Va nel messaggio che il coordinatore gli scrive. */
  nome: string
  /**
   * Lo scaffale che tiene in mano: combacia ESATTAMENTE con `Dominio.nome`.
   * Un test lo verifica in tutte e due le direzioni — nessuno scaffale senza
   * padrone, nessun padrone senza scaffale.
   */
  dominio: string
  /** Quando il coordinatore gli gira il lavoro. Una frase, non un manuale. */
  quando: string
  /**
   * Il nome del tool con cui il coordinatore lo chiama, e le parole che gli
   * dicono QUANDO usarlo.
   *
   * ⚠️ **Assente = questo specialista non ha una porta.** Non è una
   * dimenticanza: il disegno dice di aprirne una alla volta e di provare il
   * pilota prima del secondo. Uno specialista senza porta esiste nel registro
   * — sorvegliato dalle stesse guardie — ma nessuno può girargli lavoro.
   *
   * Aggiungerne uno costa **questa riga**: la definizione del tool, il testo
   * che il modello legge e l'instradamento si derivano da qui. Prima erano
   * scritti a mano in `tools/delega-tools.ts`, e una seconda copia scritta a
   * mano è il marciume che questo registro esiste per impedire.
   */
  porta?: {
    /** Il nome del tool. Per convenzione `chiedi_a…`, così si riconoscono a colpo d'occhio. */
    tool: string
    /** Cosa sa fare, con le PAROLE che l'Ingegnere usa davvero. È quello che il modello legge per decidere. */
    usala_per: string
  }
  /**
   * I tool del NUCLEO che appartengono a lui.
   *
   * `DOMINI` cataloga solo i tool differiti: quelli del nucleo restano sempre
   * caricati e nessuno scaffale li nomina. Ma sei di loro
   * (`NUCLEO_DEBITO_RICERCA`) sono attrezzi veri di qualcuno — stanno nel
   * nucleo solo perche' la ricerca BM25 non li ritrovava, cioe' per un debito,
   * non per disegno. Senza questa riga uno specialista non avrebbe in mano il
   * proprio attrezzo.
   *
   * Gli otto di `NUCLEO_DISEGNO` NON stanno qui e non hanno padrone: servono a
   * ORIENTARSI (chi e' il cliente, dentro quale societa' siamo, cosa ci si e'
   * gia' detti) e li adopera chiunque, coordinatore compreso.
   */
  toolDalNucleo: readonly string[]
}

/**
 * I tool che fanno qualcosa che NON SI PUO' DISFARE, o che esce fuori di qui.
 *
 * Serve a calcolare chi ha bisogno di una conferma prima di agire. La regola
 * che conta sta sopra questo elenco ed e' di Raffaele, verbatim, 13 set 2026:
 *
 *   «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
 *    faccio solo io!»
 *
 * ⚠️ Un elenco di nomi scritti a mano e' esattamente la cosa che marcisce, per
 * questo `specialisti.test.ts` verifica che ognuno di questi nomi sia un tool
 * che ESISTE ANCORA. Un nome morto qui non e' innocuo: farebbe sembrare
 * sorvegliato uno specialista che non lo e' piu'.
 *
 * ⚠️ E il verso opposto — un tool irreversibile NUOVO che nessuno aggiunge qui
 * — quello nessun test lo puo' scoprire da solo: non esiste un modo meccanico
 * per sapere che `manda_pec` manda davvero qualcosa. E' il buco dichiarato di
 * questo elenco. Il presidio e' altrove e non qui: `guardia-autorizzazioni.ts`
 * e `nessuno-trasmette-fatture.test.ts`, che leggono i SORGENTI.
 */
export const AZIONI_IRREVERSIBILI: readonly string[] = [
  // Posta: parte e non torna.
  'gmail_send_draft',
  'send_email',
  'forward_email',
  'pack_emails_and_send',
  'send_email_with_attachments',
  // Inoltra davvero le fatture estere se `prova` non e' true, e segna il mese
  // come fatto (il cron del 1° non lo rifa'). Trovato dall'audit del 13 set 2026.
  'raccogli_fatture_estere',
  // Contabilita': scrive su Fatture in Cloud, cioe' fuori di qui.
  'conferma_bozza_fic',
  'segna_fatture_ricevute_pagate',
  'conferma_riconciliazione',
  'elimina_bozza_fic',
  // Archivio: condividere e' pubblicare. Un link generato e' un link che
  // qualcuno puo' avere gia' in mano quando ci si ripensa.
  'gestisci_accesso_cartelle',
  'genera_link_condivisione',
  // Calendario: un invito parte verso gli invitati.
  'calendar_create_event',
  'calendar_delete_event',
  // Codice e rilasci: tocca la produzione.
  'github_merge_pr',
  'cervellone_modifica',
  'promuovi_modello',
]

export const SPECIALISTI: readonly Specialista[] = [
  {
    chiave: 'contabile',
    nome: 'la contabile',
    dominio: 'Contabilita e fatture',
    quando: 'fatture, pagamenti, prima nota, movimenti, riconciliazioni, note spese',
    porta: {
      tool: 'chiedi_alla_contabile',
      usala_per:
        "quali fatture sono pagate e quali no, cosa c'e' scritto sull'allegato di una fattura, " +
        'modalita di pagamento dichiarate dal fornitore (contanti, bonifico, assegno, carta), ' +
        'movimenti di banca e carte, riconciliazioni, prima nota, note spese',
    },
    // Trova da solo le corrispondenze fra movimenti e fatture: e' lavoro suo.
    toolDalNucleo: ['riconcilia_automatico'],
  },
  {
    chiave: 'geometra',
    nome: 'il geometra',
    dominio: 'Studio tecnico',
    quando: 'prezzari, preventivi, computi metrici, quadri economici, SAL',
    // ⚠️ IL SECONDO, e scelto apposta perche' e' quello che NON puo' fare
    // danni: `haPotereIrreversibile(geometra)` e' false, calcolato. Un
    // preventivo si rifa'; una mail spedita no. Il secondo specialista serve a
    // provare che il meccanismo generalizza, non ad alzare la posta.
    porta: {
      tool: 'chiedi_al_geometra',
      usala_per:
        'cercare voci nei prezzari regionali, preparare un preventivo o un computo metrico, ' +
        'quadri economici, SAL (stato avanzamento lavori), importare un prezzario da un file o un link',
    },
    toolDalNucleo: [],
  },
  {
    chiave: 'capocantiere',
    nome: 'il capocantiere',
    dominio: 'Pratiche e modelli',
    quando: 'CIGO, Allegato 10, SR41, modelli di documento coi segnaposto',
    // Quale modello di documento e' in uso: gli serve per compilare.
    toolDalNucleo: ['modello_attivo'],
  },
  {
    chiave: 'segretaria',
    nome: 'la segretaria',
    dominio: 'Segreteria',
    quando: 'posta, calendario, scadenze di mezzi e documenti',
    toolDalNucleo: [],
  },
  {
    chiave: 'archivista',
    nome: "l'archivista",
    dominio: 'Archivio',
    quando: 'Drive, file, cartelle, permessi, foto di cantiere, generazione di file',
    toolDalNucleo: [],
  },
  {
    chiave: 'signora-delle-case',
    nome: 'la signora delle case',
    dominio: 'Affitti brevi (La Real Estate, Maratea)',
    quando: 'check-in Maratea, Portale Alloggiati, imposta di soggiorno',
    // I suoi TRE attrezzi stanno tutti nel nucleo: lo scaffale in
    // mappa-officina.ts e' vuoto proprio per questo. Senza questa riga la
    // signora delle case sarebbe una specialista senza un solo attrezzo.
    toolDalNucleo: ['checkin_prepara_foglio', 'affitti_situazione', 'affitti_imposta_soggiorno'],
  },
  {
    chiave: 'tecnico-di-se',
    nome: 'il tecnico di se stesso',
    dominio: 'Se stesso',
    quando: 'autodiagnosi, skill, proprio codice, rilasci',
    toolDalNucleo: ['cervellone_check_aggiornamenti'],
  },
]

/** Lo scaffale di uno specialista, dal registro unico. `undefined` = scaffale sparito. */
function dominioDi(s: Specialista) {
  return DOMINI.find((d) => d.nome === s.dominio)
}

/**
 * Tutti gli attrezzi che uno specialista ha in mano: quelli del suo scaffale
 * piu' i suoi tool di nucleo. **Non** gli otto di orientamento, che sono di
 * tutti e che il motore carica comunque.
 */
export function toolDi(s: Specialista): readonly string[] {
  return [...(dominioDi(s)?.tool ?? []), ...s.toolDalNucleo]
}

/**
 * Vero se questo specialista puo' fare qualcosa che non si disfa.
 *
 * **Calcolato**, mai dichiarato: v. l'intestazione del file e la riga della
 * signora delle case, dove la tabella del disegno diceva già il falso.
 */
export function haPotereIrreversibile(s: Specialista): boolean {
  const suoi = new Set(toolDi(s))
  return AZIONI_IRREVERSIBILI.some((a) => suoi.has(a))
}

/** Gli attrezzi irreversibili che questo specialista ha in mano, per nome. */
export function azioniIrreversibiliDi(s: Specialista): readonly string[] {
  const suoi = new Set(toolDi(s))
  return AZIONI_IRREVERSIBILI.filter((a) => suoi.has(a))
}

/**
 * Il perimetro con cui uno specialista lavora **di default**: i suoi attrezzi
 * **meno** quelli irreversibili.
 *
 * ⚠️ **La regola di Raffaele sta qui, nel valore predefinito, e non in una nota
 * da ricordarsi.** Verbatim, 13 set 2026:
 *
 *   «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
 *    faccio solo io!»
 *
 * E il disegno (§6): *lo specialista **prepara**; il **coordinatore** chiede e
 * gira*. Uno specialista che potesse confermare una bozza FIC o mandare una
 * mail da solo salterebbe l'unico punto sorvegliato — quello in cui l'Ingegnere
 * dice «invia».
 *
 * Il default e' la forma giusta per una regola come questa: una guardia che si
 * deve ricordare di accendere e' una guardia che un giorno resta spenta.
 *
 * ⚠️ Sta QUI e non in `delega.ts` di proposito: e' calcolo sul registro, e qui
 * i test possono guardarlo con i DOMINI veri. In `delega.ts` la mappa e'
 * mockata, e un test la' proverebbe che la funzione viene chiamata — non che
 * protegga davvero tutti e sette.
 */
export function perimetroDiLavoro(chi: Specialista): ReadonlySet<string> {
  const irreversibili = new Set(AZIONI_IRREVERSIBILI)
  return new Set(toolDi(chi).filter((t) => !irreversibili.has(t)))
}

/** Gli specialisti a cui il coordinatore può girare lavoro, cioè quelli con una porta. */
export function specialistiConPorta(): Specialista[] {
  return SPECIALISTI.filter((s) => s.porta)
}

/**
 * Gli attrezzi che sono del COORDINATORE e non di uno scaffale: le porte.
 *
 * ⚠️ **Derivato.** Stava in `mappa-officina.ts` come elenco scritto a mano, e
 * aggiungere uno specialista voleva dire ricordarsi di aggiornarlo — cioè la
 * seconda copia da tenere allineata, che è il marciume che questo registro
 * esiste per impedire. Una mutazione l'ha mostrato: aggiunta una porta, la
 * guardia della mappa si lamentava di un orfano. Ora la lista **è** le porte.
 *
 * Sta qui e non là perché `mappa-officina.ts` non può importare questo file:
 * sarebbe un ciclo (questo importa quello). Il testo della mappa se lo fa
 * passare da chi costruisce il prompt, che può vedere tutti e due.
 */
export function toolDelCoordinatore(): string[] {
  return specialistiConPorta().map((s) => s.porta!.tool)
}

/** Da nome del tool allo specialista. `undefined` se quel tool non è una porta. */
export function specialistaDellaPorta(nomeTool: string): Specialista | undefined {
  return SPECIALISTI.find((s) => s.porta?.tool === nomeTool)
}

export function specialista(chiave: ChiaveSpecialista): Specialista {
  const trovato = SPECIALISTI.find((s) => s.chiave === chiave)
  // Il tipo lo garantisce a compilazione; questo copre il caso in cui qualcuno
  // tolga una riga dal registro lasciando la chiave nel tipo.
  if (!trovato) throw new Error(`specialista sconosciuto: ${chiave}`)
  return trovato
}

/**
 * Le porte che il coordinatore deve VEDERE: tutte con `DECOLLO` acceso,
 * nessuna da spento. Le usano il nucleo dei tool (`claude.ts`, così non sono
 * differite) e la mappa nel prompt (così sono nominate) — la stessa lista
 * nei due punti, altrimenti la mappa nomina una porta che il modello non ha.
 *
 * Da spento niente: una porta che rifiuta mostrata al modello è un giro perso.
 * Trovato dall'audit dell'accensione del 13 set 2026: le porte erano fuori dal
 * nucleo, cioè differite, mentre la mappa diceva «chiamali per nome».
 */
export function porteAperte(): string[] {
  return interruttoreAcceso('DECOLLO') ? toolDelCoordinatore() : []
}

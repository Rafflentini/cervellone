/**
 * I messaggi mandati mentre il bot stava gia' lavorando.
 *
 * Prima sparivano. "⏳ Sto ancora elaborando il messaggio precedente, attenda un
 * momento" suona come un rinvio ed era uno scarto: nessuna coda, nessun retry, e
 * il testo non finiva nemmeno in `messages` — la scrittura avviene a valle
 * dell'acquisizione del mutex. Peggio, il dedup su (chat_id, message_id) era
 * gia' stato scritto PRIMA del controllo del lock, quindi anche una riconsegna
 * di Telegram sarebbe stata scartata come "gia' processato".
 *
 * Le foto si salvavano comunque, perche' l'ingest sta prima del mutex: a
 * sparire era il testo, cioe' proprio la didascalia che dice cosa farne.
 */
import { supabase } from './supabase'

/**
 * Oltre questo, un messaggio in coda non viene piu' consegnato: riesumare un
 * "mandami il preventivo" di mezz'ora fa in mezzo a un discorso nuovo confonde
 * piu' di quanto aiuti. Resta in tabella, marcato, cosi' si puo' comunque
 * rispondere a "che fine ha fatto quel messaggio?".
 *
 * Dieci minuti NON e' un numero a caso: e' la stessa finestra entro cui il
 * messaggio successivo riaggancia gli upload recenti. Con una finestra piu'
 * lunga una didascalia ("questa e' la fattura di X") sarebbe arrivata al
 * modello SENZA l'immagine a cui si riferisce.
 */
export const CODA_MAX_MS = 10 * 60 * 1000

export interface MessaggioInCoda {
  id: number
  testo: string
  created_at: string
}

/** Oltre questo il testo viene tagliato. Il taglio NON deve essere silenzioso. */
export const TESTO_MAX_CHARS = 4000

/**
 * Mette da parte il testo respinto. Ritorna false se non c'e' niente da salvare.
 *
 * `creatoIl` serve per il RI-accodamento: quando un turno esce senza processare
 * gli arretrati e li rimette in coda, la loro eta' deve restare quella
 * dell'invio originale. Senza, l'orologio riparte a ogni rimbalzo e una
 * didascalia puo' arrivare mezz'ora dopo — cioe' senza piu' la foto a cui si
 * riferisce, che e' esattamente cio' che la finestra dei 10 minuti evita.
 */
export async function accodaMessaggio(
  chatId: number,
  testo: string,
  creatoIl?: string,
): Promise<boolean> {
  const pulito = (testo ?? '').trim()
  if (!chatId || !pulito) return false

  // Un troncamento muto restituirebbe all'Ingegnere meta' messaggio dopo
  // avergli promesso di averlo tenuto: meglio dirglielo dentro il testo.
  const testoFinale = pulito.length > TESTO_MAX_CHARS
    ? pulito.slice(0, TESTO_MAX_CHARS) + ' […messaggio troppo lungo, troncato]'
    : pulito

  const riga: Record<string, unknown> = { chat_id: chatId, testo: testoFinale }
  if (creatoIl) riga.created_at = creatoIl

  const { error } = await supabase
    .from('telegram_coda')
    .insert(riga)

  if (error) {
    // Se anche la coda fallisce il messaggio e' perso davvero: che si veda.
    console.error('[coda] impossibile accodare il messaggio:', error.message)
    return false
  }
  return true
}

/**
 * Prende i messaggi in attesa e li marca consegnati. Marcare SUBITO e' voluto:
 * meglio non riproporre due volte lo stesso testo che rischiare un ciclo.
 */
export async function drenaCoda(chatId: number): Promise<MessaggioInCoda[]> {
  if (!chatId) return []

  const { data, error } = await supabase
    .from('telegram_coda')
    .select('id, testo, created_at')
    .eq('chat_id', chatId)
    .is('consumato_at', null)
    .order('created_at', { ascending: true })
    .limit(20)

  if (error) {
    console.error('[coda] lettura fallita:', error.message)
    return []
  }
  const righe = (data ?? []) as MessaggioInCoda[]
  if (righe.length === 0) return []

  const ora = Date.now()
  const freschi = righe.filter(r => ora - new Date(r.created_at).getTime() <= CODA_MAX_MS)

  // Marcate TUTTE, anche le scadute: restano in tabella come traccia, ma non
  // devono ripresentarsi a ogni messaggio.
  const { error: upErr } = await supabase
    .from('telegram_coda')
    .update({ consumato_at: new Date().toISOString() })
    .in('id', righe.map(r => r.id))
  if (upErr) {
    // Non consegnare niente e' meglio che consegnarlo a ogni turno all'infinito.
    console.error('[coda] marcatura fallita, non consegno:', upErr.message)
    return []
  }

  return freschi
}

/**
 * Rimette in coda arretrati gia' drenati, conservando l'eta' originale.
 *
 * Va chiamata da OGNI uscita che non li ha processati — non solo dai `return`
 * previsti, ma anche dal catch esterno: erano gia' marcati letti, quindi
 * uscire senza restituirli e' peggio che non averli mai drenati.
 * Ritorna quanti non e' riuscita a restituire: chi chiama deve poterlo dire.
 */
export async function riaccodaMessaggi(
  chatId: number,
  messaggi: Array<{ testo: string; created_at: string }>,
): Promise<number> {
  let persi = 0
  for (const m of messaggi) {
    const ok = await accodaMessaggio(chatId, m.testo, m.created_at)
    if (!ok) persi += 1
  }
  if (persi > 0) console.error(`[coda] ${persi} arretrati NON restituiti alla coda (chat ${chatId})`)
  return persi
}

/**
 * Butta via gli arretrati non ancora letti: li usa /nuova e /reset.
 *
 * Senza, dopo uno sblocco l'Ingegnere ri-manda il primo messaggio e si vede
 * riproporre anche l'"anzi lascia stare" che era arrivato dopo — e una
 * conversazione "nuova" nasce con la coda della precedente dentro.
 */
export async function svuotaCoda(chatId: number): Promise<void> {
  if (!chatId) return
  const { error } = await supabase
    .from('telegram_coda')
    .update({ consumato_at: new Date().toISOString() })
    .eq('chat_id', chatId)
    .is('consumato_at', null)
  if (error) console.error('[coda] svuotamento fallito:', error.message)
}

/**
 * Il blocco da anteporre al messaggio corrente. Va detto al modello che sono
 * arrivati PRIMA e non erano stati letti, o li tratterebbe come un ripensamento.
 */
export function formatCoda(messaggi: MessaggioInCoda[]): string {
  if (messaggi.length === 0) return ''
  const righe = messaggi.map(m => `- "${m.testo}"`).join('\n')
  return `[Messaggi che l'Ingegnere ha mandato mentre stavo elaborando e che NON avevo ancora letto — tienine conto insieme a quello che segue:\n${righe}\n]\n\n`
}

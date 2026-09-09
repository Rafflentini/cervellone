import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { validateAuth } from '@/lib/auth'
import { sanitizeForStorage } from '@/lib/sanitize'
import { saveEmbeddingOnly } from '@/lib/memory'

// GET — messaggi di una conversazione
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!validateAuth(authCookie?.value)) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params

  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, files, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ messages: data })
}

// POST — salva messaggio
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!validateAuth(authCookie?.value)) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params
  const { role, content, files, clientMsgId } = await request.json()

  // Dall'8 set 2026 questa NON e' piu' l'unica riga del turno web: la RISPOSTA
  // la scrive il server (`api/chat/route.ts`), qui passa il messaggio
  // dell'UTENTE, che il browser salva prima ancora di partire — cosi'
  // sopravvive anche a una richiesta che non parte affatto.
  //
  // Sanitizzazione ed embedding restano necessari qui: per il messaggio utente
  // questo resta l'unico punto di scrittura.
  //
  // Il contenuto DEVE essere una stringa: se non lo fosse, la sanitizzazione non
  // potrebbe essere applicata e finirebbe testo grezzo nel database. Meglio
  // rifiutare che scrivere qualcosa che non siamo in grado di ripulire.
  if (typeof content !== 'string' || typeof role !== 'string') {
    return NextResponse.json(
      { error: 'role e content devono essere stringhe' },
      { status: 400 }
    )
  }

  // ⭐ Il commento qui sopra diceva gia' «qui passa il messaggio dell'UTENTE».
  // Era un'invariante DICHIARATA e non fatta rispettare, e il 9 set 2026 e'
  // stata misurata in produzione: fra le 18:42 e le 18:59, sulla conversazione
  // del SAL della commessa C2026-008, SETTE risposte scritte dal server e
  // SETTE dal browser — una a una, lo stesso testo due volte. Il commit che
  // toglieva quel codice dal client era live da TRE ORE: la scheda
  // dell'Ingegnere non aveva ricaricato la pagina e girava col bundle vecchio.
  //
  // Nessuna modifica al client puo' raggiungere una scheda gia' aperta. Questa
  // rotta invece e' server, e il server e' aggiornato: la guardia va QUI.
  //
  // 409 e non 400: non e' una richiesta malformata, e' una richiesta che era
  // valida ieri e oggi non lo e' piu'.
  if (role !== 'user') {
    console.warn(`[messages] rifiutato un ruolo "${role}" dal browser: la risposta la scrive il server`)
    return NextResponse.json(
      { error: 'Dal browser si salva solo la domanda: la risposta la scrive il server.' },
      { status: 409 },
    )
  }

  const sanitized = sanitizeForStorage(content)

  // Qui c'era una difesa contro il doppio salvataggio, per i beacon
  // d'emergenza del browser. Quei beacon non esistono piu' (8 set 2026): la
  // risposta la scrive il server, il browser scrive solo la domanda, e nessuno
  // manda piu' il flag `emergenza`. Era diventata codice morto, e un codice
  // morto che SEMBRA una difesa e' peggio di nessuna difesa: il commento la
  // dava per attiva mentre non poteva scattare.
  //
  // Nota per il futuro: non estenderla ai messaggi normali. Un confronto sul
  // contenuto scarterebbe un "ok" o un "procedi" scritti due volte in cinque
  // minuti — cioe' una perdita muta di dati legittimi.
  //
  // La dedup giusta e' invece sulla CHIAVE D'INVIO, ed e' arrivata il 9 set
  // 2026: il client conia un id per ogni invio, l'indice unico parziale
  // `uniq_messages_client_msg_id` lo fa valere nel database. Distingue per
  // costruzione i due casi che il contenuto confonde — due invii veri hanno due
  // chiavi, un ritentativo ha la stessa. E' l'equipollente di `telegram_dedup`,
  // che su Telegram tiene da sei mesi mentre il web non aveva niente.
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: id,
      role,
      content: sanitized,
      files: files || [],
      // Assente per una scheda col bundle vecchio: l'indice e' parziale, quella
      // scrive come prima. Nessuna modifica al client raggiunge una scheda gia'
      // aperta — lezione dell'8 set 2026.
      ...(typeof clientMsgId === 'string' && clientMsgId ? { client_msg_id: clientMsgId } : {}),
    })
    .select()
    .single()

  if (error) {
    // 23505 = unique_violation. Non e' un guasto: e' lo stesso invio arrivato
    // due volte, e la riga c'e' gia'. Rispondere 500 farebbe mostrare al
    // browser un errore per una domanda che invece e' salvata.
    if (error.code === '23505') {
      console.warn(`[messages] invio ripetuto scartato dalla chiave: ${clientMsgId}`)
      return NextResponse.json({ ok: true, duplicato: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort: se l'indicizzazione fallisce il messaggio resta salvato, ma il
  // fallimento va lasciato a log — un embedding perso in silenzio significa una
  // ricerca semantica che smette di funzionare senza che nessuno se ne accorga.
  saveEmbeddingOnly(id, role, sanitized).catch((err) => {
    console.warn(
      `[messages] embedding non generato per ${id}: ${err instanceof Error ? err.message : String(err)}`
    )
  })

  // Aggiorna timestamp conversazione
  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  // Auto-genera titolo dalla prima domanda dell'utente
  if (role === 'user') {
    const { data: conv } = await supabase
      .from('conversations')
      .select('title')
      .eq('id', id)
      .single()
    if (conv?.title === 'Nuova conversazione') {
      const title = content.slice(0, 60) + (content.length > 60 ? '...' : '')
      await supabase.from('conversations').update({ title }).eq('id', id)
    }
  }

  return NextResponse.json(data)
}

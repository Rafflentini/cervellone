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
  const { role, content, files } = await request.json()

  // Questa e l'UNICA riga scritta per il turno web: il server non ne scrive una
  // seconda. Quindi qui devono avvenire anche le due cose che prima faceva solo
  // il server — sanitizzazione dei dati sensibili e generazione dell'embedding.
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

  const sanitized = sanitizeForStorage(content)

  // Difesa contro il doppio salvataggio. Il browser puo inviare lo stesso
  // messaggio due volte in modo legittimo: una col salvataggio normale e una
  // con sendBeacon, quando la pagina muore a meta risposta e non sa se la prima
  // sia andata a buon fine. Il server e l'unico punto che vede tutte le
  // scritture, quindi la difesa sta qui e non nel browser.
  const cinqueMinutiFa = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: giaPresente } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', id)
    .eq('role', role)
    .eq('content', sanitized)
    .gte('created_at', cinqueMinutiFa)
    .limit(1)
    .maybeSingle()

  if (giaPresente) {
    return NextResponse.json({ message: giaPresente, duplicato_ignorato: true })
  }

  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: id,
      role,
      content: sanitized,
      files: files || [],
    })
    .select()
    .single()

  if (error) {
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

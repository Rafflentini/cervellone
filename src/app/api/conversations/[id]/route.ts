import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// PATCH — rinomina conversazione
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params
  const { title } = await request.json()

  const { error } = await supabase
    .from('conversations')
    .update({ title })
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// DELETE — cancella conversazione e tutti i suoi messaggi/embeddings
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params

  // Gli embeddings NON vengono cancellati — la memoria resta
  // Scollega solo il riferimento alla conversazione
  await supabase.from('embeddings').update({ conversation_id: null }).eq('conversation_id', id)
  // Cancella messaggi (il testo grezzo della chat)
  await supabase.from('messages').delete().eq('conversation_id', id)
  // Cancella conversazione
  const { error } = await supabase.from('conversations').delete().eq('id', id)

  if (error) {
    console.error('Errore cancellazione conversazione:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

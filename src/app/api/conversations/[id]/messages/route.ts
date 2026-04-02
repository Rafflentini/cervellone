import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET — messaggi di una conversazione
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
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
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params
  const { role, content, files } = await request.json()

  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: id,
      role,
      content,
      files: files || [],
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

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

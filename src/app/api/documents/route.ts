import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// POST — salva documento prodotto dal Cervellone
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { name, content, conversationId, projectId, type } = await request.json()

  const { data, error } = await supabase
    .from('documents')
    .insert({
      name,
      content,
      conversation_id: conversationId || null,
      project_id: projectId || null,
      type: type || 'text',
      metadata: { autoSaved: true, savedAt: new Date().toISOString() },
    })
    .select()
    .single()

  if (error) {
    console.error('Errore salvataggio documento:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

// GET — lista documenti (opzionale: ?project_id=xxx&conversation_id=xxx)
export async function GET(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const projectId = request.nextUrl.searchParams.get('project_id')
  const conversationId = request.nextUrl.searchParams.get('conversation_id')

  let query = supabase
    .from('documents')
    .select('id, name, type, project_id, conversation_id, created_at, metadata')
    .order('created_at', { ascending: false })
    .limit(50)

  if (projectId) query = query.eq('project_id', projectId)
  if (conversationId) query = query.eq('conversation_id', conversationId)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ documents: [] })
  }

  return NextResponse.json({ documents: data })
}

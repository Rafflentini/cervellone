import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET — lista conversazioni (opzionale: ?project_id=xxx)
export async function GET(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const projectId = request.nextUrl.searchParams.get('project_id')

  let query = supabase
    .from('conversations')
    .select('id, title, project_id, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)

  if (projectId) {
    query = query.eq('project_id', projectId)
  }

  const { data, error } = await query
  if (error) {
    console.error('SUPABASE GET conversations error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ conversations: data || [] })
}

// POST — crea nuova conversazione
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { title, project_id } = await request.json()

  const { data, error } = await supabase
    .from('conversations')
    .insert({ title: title || 'Nuova conversazione', project_id: project_id || null })
    .select()
    .single()

  if (error) {
    console.error('SUPABASE POST conversations error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

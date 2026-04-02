import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// DELETE — elimina progetto
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params

  // Cancella embeddings del progetto
  await supabase.from('embeddings').delete().eq('project_id', id)
  // Cancella documenti del progetto
  await supabase.from('documents').delete().eq('project_id', id)
  // Scollega conversazioni
  await supabase.from('conversations').update({ project_id: null }).eq('project_id', id)
  // Cancella progetto
  const { error } = await supabase.from('projects').delete().eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// PATCH — rinomina progetto o sposta contenuti
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { id } = await params
  const { name, mergeIntoId } = await request.json()

  // Se mergeIntoId è specificato, sposta tutto nel progetto target e cancella questo
  if (mergeIntoId) {
    await supabase.from('embeddings').update({ project_id: mergeIntoId }).eq('project_id', id)
    await supabase.from('documents').update({ project_id: mergeIntoId }).eq('project_id', id)
    await supabase.from('conversations').update({ project_id: mergeIntoId }).eq('project_id', id)
    await supabase.from('projects').delete().eq('id', id)
    return NextResponse.json({ success: true, merged: true })
  }

  // Altrimenti rinomina
  if (name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const { error } = await supabase.from('projects').update({ name, slug }).eq('id', id)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}

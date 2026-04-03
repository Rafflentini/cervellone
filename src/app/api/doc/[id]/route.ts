import { NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'

// GET /api/doc/[id] — restituisce l'HTML del documento
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const { data, error } = await supabase
    .from('documents')
    .select('content')
    .eq('id', id)
    .single()

  if (error || !data) {
    return new Response('Documento non trovato', { status: 404 })
  }

  return new Response(data.content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

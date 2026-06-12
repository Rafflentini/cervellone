import { NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'
import { isDocAccessAllowed } from '@/lib/doc-access'

// GET /api/doc/[id] — restituisce l'HTML del documento (privato: cookie sessione o share token)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const cookieToken = request.cookies.get('cervellone_auth')?.value
  const url = new URL(request.url)
  const shareToken = url.searchParams.get('t') ?? undefined
  const expRaw = url.searchParams.get('exp')
  const exp = expRaw ? Number(expRaw) : undefined

  if (!isDocAccessAllowed({ id, cookieToken, shareToken, exp })) {
    return new Response('Accesso non autorizzato', { status: 401 })
  }

  const { data, error } = await supabase
    .from('documents')
    .select('content')
    .eq('id', id)
    // Le estrazioni testuali delle foto sono memoria interna (PII): mai servirle come documento.
    .neq('type', 'image-extraction')
    .single()

  if (error || !data) {
    return new Response('Documento non trovato', { status: 404 })
  }

  return new Response(data.content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

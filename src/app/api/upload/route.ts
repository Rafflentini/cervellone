import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const maxDuration = 60

// Upload file su Supabase Storage, ritorna URL per il download
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File
  if (!file) {
    return NextResponse.json({ error: 'Nessun file' }, { status: 400 })
  }

  const fileName = `${Date.now()}_${file.name}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const { error } = await supabase.storage
    .from('uploads')
    .upload(fileName, buffer, { contentType: file.type })

  if (error) {
    console.error('UPLOAD error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Genera URL firmato (valido 24 ore)
  const { data: urlData } = await supabase.storage
    .from('uploads')
    .createSignedUrl(fileName, 86400)

  return NextResponse.json({
    fileName: file.name,
    storagePath: fileName,
    url: urlData?.signedUrl || '',
    size: file.size,
    type: file.type,
  })
}

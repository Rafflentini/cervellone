/**
 * app/api/trascrivi/route.ts — La chat web manda qui l'audio dettato.
 *
 * Esiste per l'equipollenza dei due canali. Fino al 3 settembre 2026 il web
 * trascriveva DENTRO il browser (`SpeechRecognition`) e Telegram sul server
 * (Whisper): due orecchie diverse, quindi ogni correzione — il vocabolario coi
 * nomi veri dei clienti, il filtro sulle frasi che il trascrittore inventa sul
 * silenzio, la scelta del modello — valeva per meta' prodotto.
 *
 * Ora l'audio del web passa dallo stesso motore di Telegram
 * (`trascriviBuffer`). Il riconoscimento del browser resta acceso, ma solo per
 * mostrare le parole mentre si parla: il testo che conta e' quello che torna da
 * qui.
 */
import { NextRequest, NextResponse } from 'next/server'
import { validateAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limiter'
import { trascriviBuffer } from '@/lib/trascrizione'

export const maxDuration = 120

/** Oltre questa soglia non e' piu' una dettatura: e' un file caricato. */
const MAX_BYTES = 25 * 1024 * 1024

export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!validateAuth(authCookie?.value)) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  // Una dettatura costa una chiamata al trascrittore: senza limite, una pagina
  // lasciata aperta con un bug di re-render la ripeterebbe all'infinito.
  const sessionId = authCookie!.value.slice(0, 16)
  if (!rateLimit(`trascrivi_${sessionId}`, 60_000, 20)) {
    return NextResponse.json({ testo: '', problema: 'Troppe registrazioni ravvicinate. Attenda un momento.' }, { status: 429 })
  }

  let file: File | null = null
  let durataSec: number | undefined
  try {
    const form = await request.formData()
    const f = form.get('audio')
    if (f instanceof File) file = f
    const d = form.get('durata')
    if (typeof d === 'string' && d) durataSec = Number(d)
  } catch {
    return NextResponse.json({ testo: '', problema: 'Registrazione non leggibile. Riprovi.' }, { status: 400 })
  }

  if (!file) {
    return NextResponse.json({ testo: '', problema: 'Non è arrivato nessun audio. Riprovi a registrare.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ testo: '', problema: 'La registrazione è troppo lunga. La spezzi in due, per favore.' }, { status: 413 })
  }

  const buffer = await file.arrayBuffer()
  const esito = await trascriviBuffer(buffer, {
    durataSec,
    // MediaRecorder produce webm/opus su Chrome, mp4 su Safari: si passa il tipo
    // dichiarato dal browser invece di indovinare.
    mime: file.type || 'audio/webm',
    nomeFile: file.name || 'dettatura.webm',
    canale: 'web',
  })

  // Sempre 200: `problema` e' una risposta valida, non un errore di trasporto.
  // Il client decide se sostituire il testo o tenere quello del browser.
  return NextResponse.json(esito)
}

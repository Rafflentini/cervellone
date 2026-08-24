/**
 * api/checkin/logo — serve il logo de LA REAL ESTATE.
 *
 * Il file vive su Drive e non nel repo: e' materiale dell'azienda, cambia
 * quando lo cambia il grafico, e non deve richiedere un rilascio per essere
 * aggiornato. Qui si scarica una volta e si tiene in cache a lungo.
 *
 * Pubblico di proposito: e' un logo su un'intestazione, non un dato. Chiedere
 * un token per mostrarlo vorrebbe dire che un ospite col link valido vede una
 * pagina senza intestazione se qualcosa va storto nel passaggio del parametro.
 */

import { NextResponse } from 'next/server'
import { downloadFileBase64 } from '@/lib/drive'

/** Logo La Real Bianco.jpg, cartella LA Real Estate SRL. */
const FILE_LOGO = '1EK4XEf9WUOYeI-b98xv8nVPxr0yh-kWv'

export async function GET() {
  try {
    const { base64, mimeType } = await downloadFileBase64(FILE_LOGO)
    const byte = Buffer.from(base64, 'base64')

    return new NextResponse(new Uint8Array(byte), {
      headers: {
        'Content-Type': mimeType || 'image/jpeg',
        // Un logo cambia una volta ogni anni: inutile richiederlo a ogni
        // apertura del form da un telefono in cantiere.
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
      },
    })
  } catch (err) {
    console.error('[CHECKIN] logo non recuperabile:', err)
    // Un logo che manca non deve rompere il check-in: si risponde 404 e
    // l'intestazione resta quella testuale.
    return new NextResponse(null, { status: 404 })
  }
}

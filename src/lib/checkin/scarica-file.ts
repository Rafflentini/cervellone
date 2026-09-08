/**
 * src/lib/checkin/scarica-file.ts — scaricare il file della Questura senza
 * salvare un errore al posto suo.
 *
 * Il pulsante era un `<a download>`: il browser salva QUALUNQUE cosa risponda
 * la rotta, compreso `{"ok":false,"errore":"Non autorizzato."}`. Chi consegna
 * le chiavi si ritrovava sul telefono un `Alloggiati_20260909.txt` di 45 byte,
 * apparentemente pronto per il Portale, e nessun messaggio.
 *
 * Il commento in cima alla rotta lo dice da sempre: «un file che si scarica
 * senza dire niente sembra pronto». Mancava solo che qualcuno lo guardasse.
 */

export type EsitoScaricamento =
  | { ok: true; contenuto: string; nome: string }
  | { ok: false; errore: string }

/** Il nome dichiarato dalla rotta, se c'e'. */
function nomeDa(disposition: string | null): string | null {
  const m = /filename\s*=\s*"([^"]+)"/i.exec(disposition ?? '')
  return m ? m[1] : null
}

export async function scaricaFileQuestura(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EsitoScaricamento> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (err) {
    return { ok: false, errore: err instanceof Error ? err.message : String(err) }
  }

  const corpo = await res.text().catch(() => '')

  if (!res.ok) {
    // La rotta risponde `{ ok: false, errore: '...' }`. Quando invece davanti
    // c'e' un guasto di piattaforma (502, HTML), il JSON non c'e': si dice
    // almeno il codice, invece di un messaggio vuoto.
    try {
      const j = JSON.parse(corpo) as { errore?: string }
      if (j?.errore) return { ok: false, errore: j.errore }
    } catch { /* non era JSON */ }
    return { ok: false, errore: `Il file non e' stato generato (errore ${res.status}).` }
  }

  if (!corpo.trim()) {
    return { ok: false, errore: 'Il file e\' vuoto: non c\'e\' niente da caricare sul Portale.' }
  }

  return {
    ok: true,
    contenuto: corpo,
    nome: nomeDa(res.headers.get('content-disposition')) ?? 'Alloggiati.txt',
  }
}

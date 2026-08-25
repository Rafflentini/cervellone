'use client'

/**
 * /checkin/alloggiati — la pagina da cui si prende il file per la Questura.
 *
 * Due passaggi separati di proposito: prima si CONTROLLA, poi si scarica.
 *
 * Il Portale rifiuta il file INTERO se una sola riga e' incompleta. Un pulsante
 * che scarica e basta darebbe in mano un file che sembra pronto, e lo scarto si
 * scoprirebbe caricandolo — col cronometro delle 24 ore che gira. Meglio dire
 * prima cosa manca, con il nome dell'ospite.
 */

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

interface Esito {
  ok: boolean
  data: string
  righe: number
  avvisi: string[]
  errore?: string
}

/** Ieri: e' la domanda che ci si fa la mattina, "chi e' arrivato ieri". */
function ieri(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

function Alloggiati() {
  const k = useSearchParams().get('k') ?? ''
  const [data, setData] = useState(ieri())
  const [esito, setEsito] = useState<Esito | null>(null)
  const [inCorso, setInCorso] = useState(false)

  async function controlla() {
    setInCorso(true)
    setEsito(null)
    try {
      const r = await fetch(`/api/checkin/alloggiati?k=${encodeURIComponent(k)}&data=${data}`)
      setEsito(await r.json())
    } catch {
      setEsito({ ok: false, data, righe: 0, avvisi: [], errore: 'Connessione assente.' })
    } finally {
      setInCorso(false)
    }
  }

  const linkFile = `/api/checkin/alloggiati?k=${encodeURIComponent(k)}&data=${data}&scarica=1`

  if (!k) {
    return (
      <main className="wrap">
        <div className="esito ko">Collegamento incompleto: manca il codice di accesso.</div>
        <style jsx global>{STILE}</style>
      </main>
    )
  }

  return (
    <>
      <header>
        <h1>Alloggiati Web</h1>
        <p>Il file per la Questura — entro 24 ore dall&apos;arrivo</p>
      </header>

      <div className="wrap">
        <section>
          <label>Data di arrivo degli ospiti</label>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
          <div className="hint">
            Non la data di oggi: il giorno in cui gli ospiti sono <b>arrivati</b>.
          </div>

          <button className="btn btn-pri" disabled={inCorso} onClick={controlla}>
            {inCorso ? 'Controllo…' : 'Controlla chi c’è'}
          </button>
        </section>

        {esito && (
          <section>
            {esito.errore && <div className="esito ko">{esito.errore}</div>}

            {!esito.errore && esito.righe === 0 && (
              <div className="esito neutro">
                Nessun ospite arrivato il {esito.data.split('-').reverse().join('/')}.
                <span className="sotto">Non c’è niente da comunicare, e va bene così.</span>
              </div>
            )}

            {!esito.errore && esito.righe > 0 && esito.avvisi.length === 0 && (
              <>
                <div className="esito ok">
                  {esito.righe} {esito.righe === 1 ? 'persona pronta' : 'persone pronte'} da comunicare.
                  <span className="sotto">Nessun dato mancante: il file è completo.</span>
                </div>
                <a className="btn btn-pri" href={linkFile} download>
                  Scarica il file
                </a>
                <div className="hint">
                  Poi caricalo sul Portale Alloggiati: <b>Invio → Da file</b>.
                </div>
              </>
            )}

            {!esito.errore && esito.righe > 0 && esito.avvisi.length > 0 && (
              <>
                <div className="esito ko">
                  Manca qualcosa. Il Portale rifiuterebbe <b>tutto il file</b>, non solo
                  la riga incompleta.
                  <ul>{esito.avvisi.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
                <div className="hint">
                  Sistema questi dati nel check-in, poi ricontrolla. Se serve, puoi
                  scaricare lo stesso — ma il Portale lo scarterà.
                </div>
                <a className="btn btn-sec" href={linkFile} download>
                  Scarica comunque
                </a>
              </>
            )}
          </section>
        )}
      </div>

      <style jsx global>{STILE}</style>
    </>
  )
}

export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <Alloggiati />
    </Suspense>
  )
}

const STILE = `
  :root{--blu:#1f3864;--bordo:#d7dce5;--bg:#f4f6fa;--ok:#0f7b4f;--err:#b3261e;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    margin:0;padding:0 0 40px;background:var(--bg);color:#1a1a1a;font-size:16px}
  header{background:#fff;border-bottom:3px solid var(--blu);padding:14px 18px}
  header h1{margin:0;font-size:17px;font-weight:600;color:var(--blu)}
  header p{margin:3px 0 0;font-size:12px;color:#6b7280}
  .wrap{padding:14px}
  section{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:14px;margin-bottom:12px}
  label{display:block;font-size:12px;font-weight:600;color:#4a5568;margin:0 0 4px}
  input{width:100%;padding:11px;border:1px solid var(--bordo);border-radius:8px;font-size:16px}
  input:focus{outline:2px solid var(--blu);border-color:var(--blu)}
  .btn{display:block;width:100%;padding:14px;border:none;border-radius:8px;font-size:15px;
    font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-top:12px}
  .btn-pri{background:var(--blu);color:#fff}
  .btn-pri:disabled{opacity:.5}
  .btn-sec{background:#fff;border:1.5px dashed var(--blu);color:var(--blu)}
  .hint{font-size:11.5px;color:#6b7280;margin-top:8px;line-height:1.45}
  .esito{padding:14px;border-radius:8px;font-size:14px;line-height:1.5}
  .esito .sotto{display:block;font-size:12px;opacity:.85;margin-top:4px}
  .esito ul{margin:8px 0 0;padding-left:18px;font-size:13px}
  .esito li{margin:3px 0}
  .esito.ok{background:#e7f5ee;border:1px solid var(--ok);color:#0b5c3b}
  .esito.ko{background:#fdeceb;border:1px solid var(--err);color:#8c1d18}
  .esito.neutro{background:#eef2f9;border:1px solid var(--bordo);color:#2b3a55}
`

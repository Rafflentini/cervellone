'use client'

/**
 * /checkin/gestione — l'unico indirizzo da custodire.
 *
 * Prima erano tre link separati, ognuno da ritrovare quando serviva. Da qui si
 * arriva a tutto e, soprattutto, si VEDE: chi arriva, chi non ha ancora
 * compilato, di chi manca cosa.
 *
 * Sono domande, non avvisi: se una settimana salta, la settimana dopo si vede
 * lo stesso l'arretrato. Un avviso perso invece non torna.
 */

import { useEffect, useMemo, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

interface Pratica {
  id: string
  unita: string
  portale: string
  codPrenotazione: string
  checkin: string
  checkout: string
  intestatario: string
  importo: string
  imposta: string
  attesi: number
  dichiarati: number
  compilate: number
  stato: string
  daCompletare: string
  inviatoAlloggiati: boolean
  fatturaEmessa: boolean
  link: string | null
  linkOspiti: Array<{ progressivo: number; link: string | null }>
}

interface GruppoQuestura {
  struttura: string
  appartamenti: string[]
  righe: number
  avvisi: string[]
  pronto: boolean
}
interface EsitoQuestura { data: string; righe: number; gruppi?: GruppoQuestura[] }

const ieri = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const oggiISO = () => new Date().toISOString().slice(0, 10)
const gg = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : '—')

/**
 * L'intestazione con il logo, uguale su tutte le pagine.
 *
 * Il marchio e' bordeaux su fondo BIANCO (il file si chiama 'Bianco' per il
 * fondo, non per il tratto): percio' la fascia e' bianca con un filetto blu
 * sotto, e il blu resta il colore di tutto il resto.
 *
 * Se il logo non si carica l'intestazione regge lo stesso: un logo mancante
 * non deve impedire un check-in.
 */
function Intestazione({ titolo, sotto }: { titolo: string; sotto?: string }) {
  return (
    <header>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/api/checkin/logo" alt="LA Real Estate srls" className="logo" />
      <div className="titolo">
        <h1>{titolo}</h1>
        {sotto && <p>{sotto}</p>}
      </div>
    </header>
  )
}
function Gestione() {
  const k = useSearchParams().get('k') ?? ''
  const [pratiche, setPratiche] = useState<Pratica[]>([])
  const [errore, setErrore] = useState('')
  const [caricato, setCaricato] = useState(false)
  const [aperta, setAperta] = useState('')
  const [copiato, setCopiato] = useState('')
  /** Sezione Questura: la data proposta e ieri, la domanda della mattina. */
  const [dataQ, setDataQ] = useState(ieri())
  const [esitoQ, setEsitoQ] = useState<EsitoQuestura | null>(null)
  const [qInCorso, setQInCorso] = useState(false)

  async function controllaQuestura() {
    setQInCorso(true)
    setEsitoQ(null)
    try {
      const r = await fetch(`/api/checkin/alloggiati?k=${encodeURIComponent(k)}&data=${dataQ}`)
      setEsitoQ(await r.json())
    } catch {
      setEsitoQ({ data: dataQ, righe: 0, gruppi: [] })
    } finally {
      setQInCorso(false)
    }
  }

  useEffect(() => {
    if (!k) { setErrore('Collegamento incompleto: manca il codice di accesso.'); return }
    fetch(`/api/checkin/pratiche?k=${encodeURIComponent(k)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setErrore(d.errore || 'Non autorizzato.'); return }
        setPratiche(d.pratiche ?? [])
        setCaricato(true)
      })
      .catch(() => setErrore('Non riesco a leggere le prenotazioni.'))
  }, [k])

  /** Le tre domande che ci si fa davvero, in cima e senza doverle cercare. */
  const riepilogo = useMemo(() => {
    const oggi = oggiISO()
    return {
      inArrivo: pratiche.filter((p) => p.checkin >= oggi),
      daCompletare: pratiche.filter((p) => p.stato !== 'CHECKIN OK'),
      daFatturare: pratiche.filter((p) => p.checkout < oggi && !p.fatturaEmessa),
    }
  }, [pratiche])

  async function copia(testo: string, etichetta: string) {
    try {
      await navigator.clipboard.writeText(testo)
      setCopiato(etichetta)
      setTimeout(() => setCopiato(''), 2000)
    } catch { /* su alcuni browser serve il tocco: il link resta comunque visibile */ }
  }

  if (errore) {
    return (
      <main className="wrap"><div className="esito ko">{errore}</div><style jsx global>{STILE}</style></main>
    )
  }

  return (
    <>
      <Intestazione titolo="Check-in" sotto={caricato ? `${pratiche.length} prenotazioni` : 'carico…'} />

      <div className="wrap">
        <div className="azioni">
          <a className="btn btn-pri" href={`/checkin/nuova?k=${encodeURIComponent(k)}`}>
            + Nuova prenotazione
          </a>
        </div>

        {/*
          La Questura sta QUI e non in una pagina sua: un indirizzo solo da
          custodire, e la stessa schermata in cui si vede chi non ha ancora
          compilato — che e' esattamente il motivo per cui un file esce
          incompleto.
        */}
        <section className="questura">
          <h2>Alloggiati Web</h2>
          <p className="spiega">
            Entro <b>24 ore dall&apos;arrivo</b>. Un file per struttura: le credenziali
            del Portale sono per struttura, non per appartamento.
          </p>

          <div className="riga-data">
            <input type="date" value={dataQ} onChange={(e) => setDataQ(e.target.value)} />
            <button className="btn btn-sec" disabled={qInCorso} onClick={controllaQuestura}>
              {qInCorso ? 'Controllo…' : 'Controlla chi c’è'}
            </button>
          </div>

          {esitoQ && esitoQ.righe === 0 && (
            <div className="esito neutro">
              Nessun ospite arrivato il {gg(esitoQ.data)}. Niente da comunicare.
            </div>
          )}

          {esitoQ && (esitoQ.gruppi ?? []).map((g) => (
            <div className={`gruppo ${g.pronto ? 'ok' : 'ko'}`} key={g.struttura}>
              <div className="testa">
                <div>
                  <b>{g.struttura}</b>
                  {g.appartamenti.length > 0 && (
                    <span className="app">{g.appartamenti.join(' · ')}</span>
                  )}
                </div>
                <span>{g.righe} {g.righe === 1 ? 'persona' : 'persone'}</span>
              </div>

              {g.pronto ? (
                <a
                  className="btn-mini pieno"
                  href={`/api/checkin/alloggiati?k=${encodeURIComponent(k)}&data=${dataQ}&struttura=${encodeURIComponent(g.struttura)}&scarica=1`}
                  download
                >
                  Scarica il file
                </a>
              ) : (
                <ul className="avvisi">{g.avvisi.map((a, i) => <li key={i}>{a}</li>)}</ul>
              )}
            </div>
          ))}
        </section>

        {caricato && (
          <div className="numeri">
            <div><b>{riepilogo.inArrivo.length}</b><span>in arrivo</span></div>
            <div className={riepilogo.daCompletare.length ? 'attenzione' : ''}>
              <b>{riepilogo.daCompletare.length}</b><span>da completare</span>
            </div>
            <div className={riepilogo.daFatturare.length ? 'attenzione' : ''}>
              <b>{riepilogo.daFatturare.length}</b><span>senza fattura</span>
            </div>
          </div>
        )}

        {caricato && pratiche.length === 0 && (
          <div className="esito neutro">
            Nessuna prenotazione. Comincia da <b>Nuova prenotazione</b>.
          </div>
        )}

        {pratiche.map((p) => (
          <section key={p.id} className={`pratica ${p.stato === 'CHECKIN OK' ? 'ok' : ''}`}>
            <div className="riga1" onClick={() => setAperta(aperta === p.id ? '' : p.id)}>
              <div>
                <div className="quando">{gg(p.checkin)} → {gg(p.checkout)}</div>
                <div className="chi">{p.intestatario || 'senza nome'}</div>
                <div className="dove">
                  {p.unita} · {p.compilate}/{p.dichiarati} ospiti
                  {p.dichiarati !== p.attesi && <span className="diff"> (prenotati {p.attesi})</span>}
                </div>
              </div>
              <span className={`stato ${p.stato === 'CHECKIN OK' ? 'ok' : p.stato === 'PARZIALE' ? 'parziale' : ''}`}>
                {p.stato === 'CHECKIN OK' ? 'OK' : p.stato === 'PARZIALE' ? 'parziale' : 'da fare'}
              </span>
            </div>

            {p.daCompletare && p.stato !== 'CHECKIN OK' && (
              <div className="manca">{p.daCompletare}</div>
            )}

            {aperta === p.id && (
              <div className="dettaglio">
                <div className="dati">
                  {p.codPrenotazione && <span>{p.portale} {p.codPrenotazione}</span>}
                  {p.importo && <span>Incasso € {p.importo}</span>}
                  {p.imposta && <span>Imposta € {p.imposta}</span>}
                  <span>{p.fatturaEmessa ? 'Fatturata' : 'Non fatturata'}</span>
                </div>

                {p.link && (
                  <button className="btn-mini pieno" onClick={() => copia(p.link!, `l-${p.id}`)}>
                    {copiato === `l-${p.id}` ? 'Copiato ✓' : 'Copia il link per l’ospite'}
                  </button>
                )}
                {p.link && (
                  <a
                    className="btn-mini"
                    href={`https://wa.me/?text=${encodeURIComponent(`Buongiorno, per completare il check-in: ${p.link}`)}`}
                    target="_blank" rel="noreferrer"
                  >
                    Manda su WhatsApp
                  </a>
                )}

                <div className="spiega-link">
                  Link della singola scheda: chi lo riceve compila <b>solo la propria</b>
                  e non vede gli altri ospiti.
                </div>
                <div className="ospiti-link">
                  {p.linkOspiti.map((l) => l.link && (
                    <button key={l.progressivo} className="btn-mini" onClick={() => copia(l.link!, `o-${p.id}-${l.progressivo}`)}>
                      {copiato === `o-${p.id}-${l.progressivo}` ? 'Copiato ✓' : `Copia ospite ${l.progressivo}`}
                    </button>
                  ))}
                </div>

                <a className="btn-mini" href={`/checkin?k=${encodeURIComponent(k)}&p=${encodeURIComponent(p.id)}`}>
                  Apri e completa tu
                </a>
              </div>
            )}
          </section>
        ))}
      </div>

      <style jsx global>{STILE}</style>
    </>
  )
}

export default function Pagina() {
  return <Suspense fallback={null}><Gestione /></Suspense>
}

const STILE = `
  :root{--blu:#1f3864;--bordo:#d7dce5;--bg:#f4f6fa;--ok:#0f7b4f;--err:#b3261e;--att:#8a6100;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    margin:0;padding:0 0 40px;background:var(--bg);color:#1a1a1a;font-size:16px}
  header{background:#fff;border-bottom:3px solid var(--blu);padding:14px 18px 12px;
    box-shadow:0 1px 6px rgba(31,56,100,.08)}
  header .logo{display:block;height:34px;width:auto;max-width:100%;margin:0 0 9px}
  header .titolo h1{margin:0;font-size:16px;font-weight:600;color:var(--blu)}
  header .titolo p{margin:2px 0 0;font-size:11.5px;color:#6b7280;line-height:1.35}
  .wrap{padding:14px}
  .azioni{display:flex;gap:10px;margin-bottom:12px}
  .btn{flex:1;padding:13px;border:none;border-radius:8px;font-size:14px;font-weight:600;
    text-align:center;text-decoration:none;cursor:pointer}
  .btn-pri{background:var(--blu);color:#fff}
  .btn-sec{background:#fff;border:1.5px solid var(--blu);color:var(--blu)}
  .numeri{display:flex;gap:10px;margin-bottom:14px}
  .numeri>div{flex:1;background:#fff;border:1px solid var(--bordo);border-radius:10px;
    padding:12px 8px;text-align:center}
  .numeri b{display:block;font-size:22px;color:var(--blu)}
  .numeri span{font-size:11px;color:#6b7280}
  .numeri .attenzione b{color:var(--att)}
  .pratica{background:#fff;border:1px solid var(--bordo);border-left:4px solid var(--att);
    border-radius:10px;padding:12px;margin-bottom:10px}
  .pratica.ok{border-left-color:var(--ok)}
  .riga1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;cursor:pointer}
  .quando{font-size:12px;color:#6b7280}
  .chi{font-size:15px;font-weight:600;color:var(--blu);margin:2px 0}
  .dove{font-size:12px;color:#4a5568}
  .dove .diff{color:var(--att)}
  .stato{font-size:11px;font-weight:700;padding:4px 8px;border-radius:20px;white-space:nowrap;
    background:#eef2f9;color:#6b7280}
  .stato.ok{background:#e7f5ee;color:#0b5c3b}
  .stato.parziale{background:#fff6e5;color:var(--att)}
  .manca{margin-top:8px;font-size:11.5px;color:var(--att);line-height:1.4}
  .dettaglio{margin-top:12px;padding-top:10px;border-top:1px solid #eef1f6}
  .dati{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:#6b7280;margin-bottom:10px}
  .dati span{background:#f4f6fa;padding:3px 8px;border-radius:6px}
  .btn-mini{display:block;width:100%;margin-top:6px;padding:9px;border-radius:7px;
    border:1px solid var(--blu);background:#fff;color:var(--blu);font-size:12.5px;
    font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
  .btn-mini.pieno{background:var(--blu);color:#fff}
  .spiega-link{font-size:11px;color:#6b7280;margin-top:10px;line-height:1.4}
  .ospiti-link{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .ospiti-link .btn-mini{width:auto;flex:1;min-width:80px;margin-top:0}
  .questura{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:14px;margin-bottom:14px}
  .questura h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--blu)}
  .spiega{font-size:11.5px;color:#6b7280;margin:6px 0 10px;line-height:1.45}
  .riga-data{display:flex;gap:8px;align-items:center}
  .riga-data input{flex:1;padding:10px;border:1px solid var(--bordo);border-radius:8px;font-size:15px}
  .riga-data .btn{flex:0 0 auto;padding:10px 14px;font-size:13px}
  .gruppo{margin-top:10px;padding:10px;border-radius:8px;border:1px solid var(--bordo)}
  .gruppo.ok{background:#f2faf6;border-color:var(--ok)}
  .gruppo.ko{background:#fffaf0;border-color:#e0c48a}
  .gruppo .testa{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#2b3a55}
  .gruppo .app{display:block;font-size:11px;color:#6b7280;font-weight:400}
  .avvisi{margin:8px 0 0;padding-left:18px;font-size:11.5px;color:var(--att);line-height:1.4}
  .esito{padding:14px;border-radius:8px;font-size:14px;line-height:1.5}
  .esito.ko{background:#fdeceb;border:1px solid var(--err);color:#8c1d18}
  .esito.neutro{background:#eef2f9;border:1px solid var(--bordo);color:#2b3a55}

  /* Da computer: colonna centrata e marchio in proporzione. Vedi /checkin. */
  @media (min-width:820px){
    header{padding:22px calc(50% - 380px) 18px}
    header .logo{height:66px;margin:0 0 14px}
    header .titolo h1{font-size:21px}
    header .titolo p{font-size:13px}
    .wrap{max-width:760px;margin:0 auto;padding:22px 0}
  }
`

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
 *
 * Dal 25/08 la pagina ha due VISTE. Con 5 appartamenti e affitti settimanali
 * sono circa 150 prenotazioni l'anno: senza una separazione, a meta' stagione
 * per vedere chi arriva domani si scorre sopra a tutta l'estate — e a quel
 * punto non si guarda piu' niente.
 *
 * Il confine sta sul server (lib/checkin/archivio.ts) e li' e' provato. Qui non
 * si decide che cosa sparisce dagli occhi: si mostra.
 */

import { useCallback, useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

type StatoFattura = 'DA FARE' | 'COMPILATA' | 'EMESSA'
type Vista = 'adesso' | 'archivio'

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
  notti: string
  attesi: number
  dichiarati: number
  compilate: number
  stato: string
  daCompletare: string
  inviatoAlloggiati: boolean
  fileAlloggiatiDel: string
  statoFattura: StatoFattura
  nFattura: string
  dataFattura: string
  link: string | null
  linkOspiti: Array<{ progressivo: number; link: string | null }>
}

interface Numeri {
  inArrivo: number
  inCasa: number
  daCompletare: number
  daFatturare: number
  daInviare: number
  alloggiatiMancante: number
}

interface Mese { mese: string; prenotazioni: number; notti: number; imposta: number }

interface GruppoQuestura {
  struttura: string
  appartamenti: string[]
  righe: number
  avvisi: string[]
  pronto: boolean
}
interface EsitoQuestura { data: string; righe: number; gruppi?: GruppoQuestura[] }

const ieri = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const gg = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : '—')

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
]
/** '2026-09' -> 'settembre 2026'. Senza data resta detto che non c'e'. */
function nomeMese(m: string): string {
  const x = /^(\d{4})-(\d{2})$/.exec(m)
  return x ? `${MESI[Number(x[2]) - 1]} ${x[1]}` : 'senza data d’arrivo'
}

const euro = (n: number) => `€ ${n.toFixed(2).replace('.', ',')}`

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

/**
 * Un numero in cima. Se `onClick` c'e', filtra; se non c'e', e' solo un numero.
 *
 * La distinzione e' voluta: un riquadro che sembra cliccabile e non filtra —
 * o che filtra mostrando un elenco diverso dal numero che porta scritto — e'
 * peggio di un numero fermo. Si impara a non fidarsi di nessuno dei due.
 */
function Numero(
  { n, etichetta, acceso, onClick, attenzione }:
  { n: number; etichetta: string; acceso?: boolean; onClick?: () => void; attenzione?: boolean },
) {
  const classe = `numero ${acceso ? 'acceso' : ''} ${attenzione && n > 0 ? 'attenzione' : ''}`
  const dentro = <><b>{n}</b><span>{etichetta}</span></>
  if (!onClick) return <div className={`${classe} fermo`}>{dentro}</div>
  return <button type="button" className={classe} onClick={onClick}>{dentro}</button>
}

/** L'etichetta dello stato fattura, con i tre stati distinti a colpo d'occhio. */
function Fattura({ p }: { p: Pratica }) {
  const testo = p.statoFattura === 'EMESSA'
    ? `Fattura ${p.nFattura ? `n. ${p.nFattura} ` : ''}emessa${p.dataFattura ? ` il ${gg(p.dataFattura)}` : ''}`
    : p.statoFattura === 'COMPILATA'
      ? 'Fattura pronta — da inviare da Fatture in Cloud'
      : 'Fattura da fare'
  const classe = p.statoFattura === 'EMESSA' ? 'ok' : p.statoFattura === 'COMPILATA' ? 'attesa' : 'manca'
  return <span className={`bollino ${classe}`}>{testo}</span>
}

function Gestione() {
  const k = useSearchParams().get('k') ?? ''

  const [vista, setVista] = useState<Vista>('adesso')
  const [mese, setMese] = useState('')
  const [unita, setUnita] = useState('')
  const [fattura, setFattura] = useState<StatoFattura | ''>('')
  const [manca, setManca] = useState<'' | 'checkin' | 'questura'>('')
  const [q, setQ] = useState('')

  const [pratiche, setPratiche] = useState<Pratica[]>([])
  const [numeri, setNumeri] = useState<Numeri | null>(null)
  const [mesi, setMesi] = useState<Mese[]>([])
  const [appartamenti, setAppartamenti] = useState<string[]>([])
  const [totale, setTotale] = useState(0)

  const [errore, setErrore] = useState('')
  const [caricato, setCaricato] = useState(false)
  const [aperta, setAperta] = useState('')
  const [copiato, setCopiato] = useState('')
  const [segnando, setSegnando] = useState('')

  /** Sezione Questura: la data proposta e ieri, la domanda della mattina. */
  const [dataQ, setDataQ] = useState(ieri())
  const [esitoQ, setEsitoQ] = useState<EsitoQuestura | null>(null)
  const [qInCorso, setQInCorso] = useState(false)

  const carica = useCallback(async () => {
    if (!k) { setErrore('Collegamento incompleto: manca il codice di accesso.'); return }
    const p = new URLSearchParams({ k, vista })
    if (mese) p.set('mese', mese)
    if (unita) p.set('unita', unita)
    if (fattura) p.set('fattura', fattura)
    if (manca) p.set('manca', manca)
    if (q.trim()) p.set('q', q.trim())

    try {
      const r = await fetch(`/api/checkin/pratiche?${p.toString()}`)
      const d = await r.json()
      if (!d.ok) { setErrore(d.errore || 'Non autorizzato.'); return }
      setPratiche(d.pratiche ?? [])
      setNumeri(d.numeri ?? null)
      setMesi(d.mesi ?? [])
      setAppartamenti(d.appartamenti ?? [])
      setTotale(d.totale ?? 0)
      setErrore('')
      setCaricato(true)
    } catch {
      setErrore('Non riesco a leggere le prenotazioni.')
    }
  }, [k, vista, mese, unita, fattura, manca, q])

  // La ricerca aspetta che si smetta di scrivere: una chiamata per tasto
  // vorrebbe dire rileggere il foglio intero a ogni lettera.
  useEffect(() => {
    const t = setTimeout(() => { void carica() }, q ? 350 : 0)
    return () => clearTimeout(t)
  }, [carica, q])

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

  /** Spunta un adempimento e RILEGGE: quello che si vede viene dal foglio. */
  async function segna(id: string, corpo: { alloggiati?: boolean; fattura?: StatoFattura }) {
    setSegnando(id)
    try {
      const r = await fetch(`/api/checkin/segna?k=${encodeURIComponent(k)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...corpo }),
      })
      const d = await r.json()
      if (!d.ok) { setErrore(d.errore || 'Non sono riuscito a segnare.'); return }
      await carica()
    } catch {
      setErrore('Non sono riuscito a segnare.')
    } finally {
      setSegnando('')
    }
  }

  async function copia(testo: string, etichetta: string) {
    try {
      await navigator.clipboard.writeText(testo)
      setCopiato(etichetta)
      setTimeout(() => setCopiato(''), 2000)
    } catch { /* su alcuni browser serve il tocco: il link resta comunque visibile */ }
  }

  /** Torna alla vista pulita: nessun filtro appeso che spieghi un elenco corto. */
  function azzeraFiltri() {
    setMese(''); setUnita(''); setFattura(''); setManca(''); setQ('')
  }

  function cambiaVista(v: Vista) {
    setVista(v)
    azzeraFiltri()
    setAperta('')
  }

  if (errore && !caricato) {
    return (
      <main className="wrap"><div className="esito ko">{errore}</div><style jsx global>{STILE}</style></main>
    )
  }

  const filtrato = Boolean(mese || unita || fattura || manca || q.trim())

  return (
    <>
      <Intestazione
        titolo="Check-in"
        sotto={caricato ? `${totale} prenotazioni in tutto` : 'carico…'}
      />

      <div className="wrap">
        {errore && <div className="esito ko">{errore}</div>}

        <div className="azioni">
          <a className="btn btn-pri" href={`/checkin/nuova?k=${encodeURIComponent(k)}`}>
            + Nuova prenotazione
          </a>
        </div>

        {/*
          Le due viste. ADESSO e' il lavoro aperto — e ci resta anche una
          prenotazione di luglio col check-in incompleto o senza il file per la
          Questura: niente sparisce solo perche' e' passato.
        */}
        <div className="viste">
          <button
            type="button"
            className={vista === 'adesso' ? 'sel' : ''}
            onClick={() => cambiaVista('adesso')}
          >
            Adesso
          </button>
          <button
            type="button"
            className={vista === 'archivio' ? 'sel' : ''}
            onClick={() => cambiaVista('archivio')}
          >
            Archivio
          </button>
        </div>

        <input
          className="cerca"
          type="search"
          placeholder="Cerca nome, codice prenotazione, appartamento…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q.trim() && (
          <div className="spiega">
            La ricerca guarda <b>ovunque</b>, adesso e archivio.
          </div>
        )}

        {/*
          I contatori valgono su TUTTE le prenotazioni, non sulla vista aperta:
          uno che cambiasse passando in archivio non sarebbe un contatore.
          Sono anche filtri — e' il modo per non perdere di vista una fattura
          arretrata senza tenersela fra i piedi ogni giorno.
        */}
        {numeri && (
          <div className="numeri">
            {/* Questi due non filtrano perche' NON hanno un filtro: sono la
                vista Adesso, che e' gia' aperta. Renderli cliccabili per
                simmetria vorrebbe dire un pulsante che non fa niente. */}
            <Numero n={numeri.inArrivo} etichetta="in arrivo" />
            <Numero n={numeri.inCasa} etichetta="in casa" />
            <Numero
              n={numeri.daCompletare} etichetta="da completare" attenzione
              acceso={manca === 'checkin'}
              onClick={() => setManca(manca === 'checkin' ? '' : 'checkin')}
            />
            <Numero
              n={numeri.alloggiatiMancante} etichetta="Questura" attenzione
              acceso={manca === 'questura'}
              onClick={() => setManca(manca === 'questura' ? '' : 'questura')}
            />
            <Numero
              n={numeri.daFatturare} etichetta="da fatturare" attenzione
              acceso={fattura === 'DA FARE'}
              onClick={() => setFattura(fattura === 'DA FARE' ? '' : 'DA FARE')}
            />
            <Numero
              n={numeri.daInviare} etichetta="da inviare" attenzione
              acceso={fattura === 'COMPILATA'}
              onClick={() => setFattura(fattura === 'COMPILATA' ? '' : 'COMPILATA')}
            />
          </div>
        )}

        {filtrato && (
          <button type="button" className="btn btn-sec" onClick={azzeraFiltri}>
            Togli i filtri
          </button>
        )}

        {/*
          La Questura sta QUI e non in una pagina sua: un indirizzo solo da
          custodire, e la stessa schermata in cui si vede chi non ha ancora
          compilato — che e' esattamente il motivo per cui un file esce
          incompleto. Nell'archivio non serve: li' non c'e' niente da inviare.
        */}
        {vista === 'adesso' && !filtrato && (
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
                    onClick={() => { setTimeout(() => { void carica() }, 2500) }}
                  >
                    Scarica il file
                  </a>
                ) : (
                  <ul className="avvisi">{g.avvisi.map((a, i) => <li key={i}>{a}</li>)}</ul>
                )}
              </div>
            ))}
          </section>
        )}

        {/*
          L'indice dei mesi. I totali servono a orientarsi, non a compilare un
          modulo: il raggruppamento e' per mese di ARRIVO, e un soggiorno a
          cavallo fra due mesi finisce tutto in quello in cui e' cominciato.
        */}
        {vista === 'archivio' && !q.trim() && mesi.length > 0 && (
          <section className="mesi">
            <h2>Archivio</h2>
            <div className="elenco-mesi">
              {mesi.map((m) => (
                <button
                  type="button"
                  key={m.mese || 'senza'}
                  className={mese === m.mese ? 'sel' : ''}
                  onClick={() => setMese(mese === m.mese ? '' : m.mese)}
                >
                  <b>{nomeMese(m.mese)}</b>
                  <span>
                    {m.prenotazioni} {m.prenotazioni === 1 ? 'prenotazione' : 'prenotazioni'}
                    {' · '}{m.notti} notti{' · '}{euro(m.imposta)} imposta
                  </span>
                </button>
              ))}
            </div>

            {appartamenti.length > 1 && (
              <select value={unita} onChange={(e) => setUnita(e.target.value)}>
                <option value="">Tutti gli appartamenti</option>
                {appartamenti.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            )}
          </section>
        )}

        {caricato && pratiche.length === 0 && (
          <div className="esito neutro">
            {filtrato
              ? 'Nessuna prenotazione con questi filtri.'
              : vista === 'archivio'
                ? 'L’archivio è vuoto: qui finiscono i soggiorni conclusi, con il check-in completo e il file per la Questura fatto.'
                : 'Nessuna prenotazione aperta. Comincia da Nuova prenotazione.'}
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

            <div className="bollini">
              <span className={`bollino ${p.inviatoAlloggiati ? 'ok' : 'manca'}`}>
                {p.inviatoAlloggiati
                  ? 'Questura inviata'
                  : p.fileAlloggiatiDel
                    ? `Questura — file del ${gg(p.fileAlloggiatiDel)}, non confermato`
                    : 'Questura da fare'}
              </span>
              <Fattura p={p} />
            </div>

            {aperta === p.id && (
              <div className="dettaglio">
                <div className="dati">
                  {p.codPrenotazione && <span>{p.portale} {p.codPrenotazione}</span>}
                  {p.importo && <span>Incasso € {p.importo}</span>}
                  {p.imposta && <span>Imposta € {p.imposta}</span>}
                </div>

                {/*
                  Le due spunte che restano umane.

                  Il caricamento sul Portale Alloggiati e' un accesso con
                  credenziali su un sito della Polizia: il programma sa quando
                  ha GENERATO il file, non sa se qualcuno l'ha caricato. Finche'
                  non c'e' la WebServiceKey, questa spunta e' l'unica cosa che
                  distingue un adempimento compiuto da uno solo preparato.
                */}
                <div className="spunte">
                  {!p.inviatoAlloggiati ? (
                    <button
                      className="btn-mini" disabled={segnando === p.id}
                      onClick={() => segna(p.id, { alloggiati: true })}
                    >
                      {segnando === p.id ? '…' : 'Segna: caricata sul Portale'}
                    </button>
                  ) : (
                    <button
                      className="btn-mini" disabled={segnando === p.id}
                      onClick={() => segna(p.id, { alloggiati: false })}
                    >
                      Togli la spunta Questura
                    </button>
                  )}

                  {p.statoFattura !== 'EMESSA' ? (
                    <button
                      className="btn-mini" disabled={segnando === p.id}
                      onClick={() => segna(p.id, { fattura: 'EMESSA' })}
                    >
                      Segna: fattura emessa
                    </button>
                  ) : (
                    <button
                      className="btn-mini" disabled={segnando === p.id}
                      onClick={() => segna(p.id, { fattura: 'DA FARE' })}
                    >
                      Fattura annullata: rimetti da fare
                    </button>
                  )}
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
  .btn-sec{background:#fff;border:1px solid var(--blu);color:var(--blu)}

  .viste{display:flex;background:#e6eaf2;border-radius:9px;padding:3px;margin-bottom:10px}
  .viste button{flex:1;padding:10px;border:none;background:transparent;border-radius:7px;
    font-size:14px;font-weight:600;color:#54617a;cursor:pointer;font-family:inherit}
  .viste button.sel{background:#fff;color:var(--blu);box-shadow:0 1px 3px rgba(31,56,100,.15)}

  .cerca{width:100%;padding:11px;border:1px solid var(--bordo);border-radius:8px;
    font-size:16px;font-family:inherit;background:#fff;margin-bottom:10px}

  .numeri{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .numero{flex:1 1 88px;background:#fff;border:1px solid var(--bordo);border-radius:9px;
    padding:10px 6px;text-align:center;cursor:pointer;font-family:inherit}
  .numero b{display:block;font-size:20px;color:var(--blu);line-height:1.1}
  .numero span{display:block;font-size:10.5px;color:#6b7280;margin-top:2px}
  .numero.attenzione b{color:var(--att)}
  .numero.acceso{border-color:var(--blu);box-shadow:0 0 0 2px rgba(31,56,100,.15)}
  .numero.fermo{cursor:default}

  section{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:14px;margin-bottom:12px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--blu);margin:0 0 8px}
  .spiega{font-size:11.5px;color:#6b7280;line-height:1.45;margin:0 0 10px}
  select,input[type=date]{width:100%;padding:11px;border:1px solid var(--bordo);border-radius:8px;
    font-size:16px;font-family:inherit;background:#fff}
  .riga-data{display:flex;gap:8px;align-items:center}
  .riga-data input{flex:1}
  .riga-data .btn{flex:0 0 auto;padding:11px 14px}

  .elenco-mesi{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
  .elenco-mesi button{text-align:left;background:#f7f9fc;border:1px solid var(--bordo);
    border-radius:8px;padding:10px 12px;cursor:pointer;font-family:inherit}
  .elenco-mesi button.sel{border-color:var(--blu);background:#eef2f9}
  .elenco-mesi b{display:block;font-size:14px;color:var(--blu);text-transform:capitalize}
  .elenco-mesi span{display:block;font-size:11px;color:#6b7280;margin-top:2px}

  .pratica{padding:12px 14px}
  .pratica.ok{border-left:3px solid var(--ok)}
  .riga1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;cursor:pointer}
  .quando{font-size:12px;color:#6b7280}
  .chi{font-size:15px;font-weight:600;color:#1a1a1a;margin:1px 0}
  .dove{font-size:12px;color:#4a5568}
  .dove .diff{color:var(--att)}
  .stato{flex:0 0 auto;font-size:10.5px;font-weight:700;text-transform:uppercase;
    letter-spacing:.4px;padding:4px 8px;border-radius:20px;background:#fdeceb;color:#8c1d18}
  .stato.parziale{background:#fff4e0;color:var(--att)}
  .stato.ok{background:#e6f4ec;color:var(--ok)}
  .manca{margin-top:8px;font-size:11.5px;color:var(--att);line-height:1.4}

  .bollini{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
  .bollino{font-size:10.5px;padding:3px 8px;border-radius:20px;line-height:1.5}
  .bollino.ok{background:#e6f4ec;color:var(--ok)}
  .bollino.attesa{background:#fff4e0;color:var(--att)}
  .bollino.manca{background:#eef2f9;color:#54617a}

  .dettaglio{margin-top:10px;padding-top:10px;border-top:1px solid #eef1f6}
  .dati{display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;color:#4a5568;margin-bottom:10px}
  .dati span{background:#f4f6fa;border-radius:6px;padding:4px 8px}
  .spunte{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
  .btn-mini{display:inline-block;background:#fff;border:1px solid var(--blu);color:var(--blu);
    border-radius:6px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;
    text-decoration:none;font-family:inherit;margin:0 6px 6px 0}
  .btn-mini.pieno{background:var(--blu);color:#fff}
  .btn-mini:disabled{opacity:.5}
  .spiega-link{font-size:11px;color:#6b7280;line-height:1.4;margin:4px 0 6px}
  .ospiti-link{display:flex;flex-wrap:wrap}

  .gruppo{border:1px solid var(--bordo);border-radius:8px;padding:10px;margin-top:8px}
  .gruppo.ok{border-color:#bfe0cd;background:#f4fbf7}
  .gruppo.ko{border-color:#f0d9a8;background:#fffaf0}
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

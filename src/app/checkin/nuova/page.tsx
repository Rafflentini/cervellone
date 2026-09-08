'use client'

/**
 * /checkin/nuova — apre una prenotazione e restituisce i link da girare.
 *
 * E' la pagina dell'Ingegnere, non dell'ospite: pochi campi, quelli che ha in
 * mano quando arriva la notifica di Booking, e in cambio i collegamenti pronti
 * da inoltrare.
 *
 * Esiste come pagina e non solo come comando al bot perche' il 24 agosto
 * Cervellone era fermo per credito esaurito. Un flusso che si interrompe quando
 * si ferma il bot non e' un flusso: e' una dipendenza.
 */

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

interface LinkOspite { progressivo: number; link: string }

interface Creata {
  id: string
  link: string
  linkOspiti: LinkOspite[]
  whatsappOspite: string
  /**
   * Una voce per ciascuna delle ragazze indicate nel Config. Nessuna email:
   * non ne hanno una, e un campo che non si puo' riempire e' solo un campo che
   * resta vuoto per sempre.
   */
  consegnaChiavi?: { nome: string; telefono: string; whatsapp: string }[]
  avvisi?: { ospite: string }
  /** Il check-in e gia passato: niente email, e i link ospite sono scaduti. */
  soggiornoPassato?: boolean
}

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
function NuovaPrenotazione() {
  const k = useSearchParams().get('k') ?? ''

  const [d, setD] = useState({
    unita: '', portale: 'Booking', codPrenotazione: '',
    checkin: '', checkout: '', ospitiAttesi: '2', importoLordo: '',
    intestatario: '', telefono: '', email: '', note: '',
  })
  const [invio, setInvio] = useState(false)
  const [errori, setErrori] = useState<string[]>([])
  const [fatta, setFatta] = useState<Creata | null>(null)
  const [copiato, setCopiato] = useState('')
  /*
    Il collegamento mostrato a schermo quando la copia non e' riuscita.
    In questa pagina i link delle singole schede esistono SOLO dentro i
    pulsanti: senza il ripiego, una copia fallita li rende irrecuperabili.
  */
  const [linkScoperto, setLinkScoperto] = useState('')

  /*
    Gli appartamenti veri, letti dal Config del foglio.
    Il campo era LIBERO: bastava scrivere "Unita 2" invece di "Unità 2" per
    creare un appartamento fantasma, che si sdoppiava nell'elenco e produceva un
    file Questura in piu'. Era il rischio che teneva fermo il go-live del 7
    settembre, e con una tendina non e' piu' possibile commetterlo.
    Se la lettura fallisce si torna al campo libero: meglio poter registrare una
    prenotazione che restare bloccati davanti a una tendina vuota.
  */
  const [appartamenti, setAppartamenti] = useState<string[]>([])
  useEffect(() => {
    if (!k) return
    fetch(`/api/checkin/dati?k=${encodeURIComponent(k)}`)
      .then((r) => r.json())
      .then((j) => { if (Array.isArray(j?.unita)) setAppartamenti(j.unita.filter(Boolean)) })
      .catch(() => { /* si resta col campo libero */ })
  }, [k])

  async function crea() {
    setInvio(true); setErrori([])
    try {
      const res = await fetch(`/api/checkin/prenotazione?k=${encodeURIComponent(k)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      })
      const r = await res.json()
      if (!r.ok) setErrori(r.errori ?? [r.errore ?? 'Non creata.'])
      else setFatta(r)
    } catch {
      setErrori(['Connessione assente.'])
    } finally {
      setInvio(false)
    }
  }

  /**
   * Copia un collegamento, e se non ci riesce lo fa vedere.
   *
   * Il ripiego non e' un vezzo: i link delle singole schede non sono scritti
   * da nessuna parte in questa pagina, ci sono solo i pulsanti. Quando la
   * copia falliva — appunti non concessi, browser dentro un'app, pagina
   * aperta da una chat — non succedeva niente e quei collegamenti erano
   * irrecuperabili: due ospiti su tre non compilavano.
   */
  async function copia(testo: string, etichetta: string) {
    try {
      await navigator.clipboard.writeText(testo)
      setCopiato(etichetta)
      setLinkScoperto('')
      setTimeout(() => setCopiato(''), 2000)
      return
    } catch { /* si prova la via vecchia */ }

    try {
      const casella = document.createElement('textarea')
      casella.value = testo
      casella.setAttribute('readonly', '')
      casella.style.position = 'fixed'
      casella.style.top = '0'
      casella.style.opacity = '0'
      document.body.appendChild(casella)
      casella.select()
      const fatto = document.execCommand('copy')
      document.body.removeChild(casella)
      if (fatto) {
        setCopiato(etichetta)
        setLinkScoperto('')
        setTimeout(() => setCopiato(''), 2000)
        return
      }
    } catch { /* niente: si mostra */ }

    setLinkScoperto(testo)
  }

  if (!k) {
    return (
      <main className="wrap">
        <div className="esito ko">Collegamento incompleto: manca il codice di accesso.</div>
        <style jsx global>{STILE}</style>
      </main>
    )
  }

  if (fatta) {
    return (
      <>
        <Intestazione titolo="Prenotazione aperta" sotto={fatta.id} />
        <div className="wrap">
          <section>
            <h2>Link per l&apos;ospite intestatario</h2>
            <p className="spiega">
              Manda questo. Compila tutto lui, oppure gira agli altri il link della loro scheda.
            </p>
            <div className="link">{fatta.link}</div>
            <a className="btn btn-pri" href={fatta.whatsappOspite} target="_blank" rel="noreferrer">
              {d.telefono.trim()
                ? 'Mandalo su WhatsApp all’ospite'
                : 'Manda su WhatsApp (scegli il contatto)'}
            </a>
            <button className="btn btn-sec" onClick={() => copia(fatta.link, 'principale')}>
              {copiato === 'principale' ? 'Copiato ✓' : 'Copia il link'}
            </button>
            {fatta.avvisi?.ospite === 'inviata' && (
              <div className="hint">Mandato anche per email.</div>
            )}
            {/*
              Gli altri tre esiti non erano disegnati da nessuna parte: si
              vedeva solo l'assenza della riga verde, che non nota nessuno.
              Ma la pagina promette l'email come "rete di sicurezza": se non
              e' partita, chi legge deve saperlo, non dedurlo.
            */}
            {fatta.avvisi?.ospite === 'non riuscita' && (
              <div className="esito ko" style={{ marginTop: 8 }}>
                L&apos;email <b>non e&apos; partita</b>. Manda il collegamento su WhatsApp:
                per adesso quella e&apos; l&apos;unica strada.
              </div>
            )}
            {fatta.soggiornoPassato && (
              <div className="hint">
                Soggiorno gia&apos; iniziato: <b>nessuna email mandata all&apos;ospite</b>, e i
                collegamenti qui sotto potrebbero risultare scaduti per lui.
                Le schede le compili tu con <b>Apri e completa tu</b> dalla pagina di gestione.
              </div>
            )}
          </section>

          {/*
            Chi consegna le chiavi va avvisata: e' lei che completa i dati
            mancanti al riconoscimento. Senza saperlo, si presenta senza sapere
            chi trovera'.
          */}
          <section>
            <h2>Avvisa chi consegna le chiavi</h2>
            {(fatta.consegnaChiavi ?? []).length > 0 ? (
              <>
                <p className="spiega">
                  Riceve il riepilogo della prenotazione e il collegamento da cui vede tutto.
                  Un pulsante per ciascuna: parte su WhatsApp, gia&apos; col messaggio scritto.
                </p>
                {(fatta.consegnaChiavi ?? []).map((c, i) => (
                  <a
                    key={i}
                    className="btn btn-pri"
                    href={c.whatsapp}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.telefono
                      ? `Avvisa ${c.nome || 'chi fa la consegna'} su WhatsApp`
                      : `${c.nome} — manca il numero, scegli il contatto`}
                  </a>
                ))}
              </>
            ) : (
              <p className="spiega">
                Nessun recapito impostato. Scrivi nome e numero nel foglio,
                scheda <b>Config</b>, alle righe <b>consegna_chiavi_*</b> — e questo
                riquadro si accende da solo. Se le ragazze sono piu&apos; d&apos;una,
                separale con <b>|</b>, nomi e numeri nello stesso ordine.
              </p>
            )}
          </section>

          <section>
            <h2>Link dei singoli ospiti</h2>
            <p className="spiega">
              Ognuno apre <b>solo la propria scheda</b> e vede solo i propri documenti.
            </p>
            {fatta.linkOspiti.map((l) => (
              <div className="riga-ospite" key={l.progressivo}>
                <span>Link della scheda dell’ospite {l.progressivo}</span>
                <button className="btn-mini" onClick={() => copia(l.link, `o${l.progressivo}`)}>
                  {copiato === `o${l.progressivo}` ? 'Copiato ✓' : 'Copia'}
                </button>
              </div>
            ))}

            {linkScoperto && (
              <div
                style={{
                  marginTop: 10, padding: '10px 12px', borderRadius: 8,
                  background: '#fff8e6', border: '1px solid #e0a800',
                }}
              >
                <div style={{ fontSize: 13, marginBottom: 6 }}>
                  Non sono riuscito a copiarlo da solo. <b>Tieni premuto sul link</b>,
                  scegli <b>Copia</b> e incollalo in chat.
                </div>
                <input
                  readOnly
                  value={linkScoperto}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 13,
                    border: '1px solid #d8d8d8', borderRadius: 6, background: '#fff',
                  }}
                />
              </div>
            )}
          </section>

          <button className="btn btn-sec" onClick={() => { setFatta(null); setCopiato(''); setLinkScoperto('') }}>
            Apri un&apos;altra prenotazione
          </button>

          {/*
            La via del ritorno.

            Installata sul telefono, questa e' un'app a schermo intero: non c'e'
            barra dell'indirizzo e non c'e' la freccia indietro. Senza questo
            collegamento, dopo aver creato una prenotazione non c'era NESSUN
            modo di tornare all'elenco — e all'elenco bisogna tornare, perche'
            e' li' che sta "Apri e completa tu", cioe' il passo successivo.
          */}
          <a className="btn btn-pri" href={`/checkin/gestione?k=${encodeURIComponent(k)}`}>
            ← Torna all&apos;elenco delle prenotazioni
          </a>
        </div>
        <style jsx global>{STILE}</style>
      </>
    )
  }

  return (
    <>
      <Intestazione titolo="Nuova prenotazione" sotto="I dati che hai adesso: il resto lo compila l’ospite" />

      <div className="wrap">
        {errori.length > 0 && (
          <div className="esito ko">{errori.map((e, i) => <div key={i}>{e}</div>)}</div>
        )}

        <section>
          <label>Unità *</label>
          {appartamenti.length > 0 ? (
            <select value={d.unita} onChange={(e) => setD({ ...d, unita: e.target.value })}>
              <option value="">— scegli l&apos;appartamento —</option>
              {appartamenti.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          ) : (
            <input value={d.unita} onChange={(e) => setD({ ...d, unita: e.target.value })} placeholder="Unità 1" />
          )}

          <div className="row">
            <div>
              <label>Portale</label>
              <select value={d.portale} onChange={(e) => setD({ ...d, portale: e.target.value })}>
                <option>Booking</option><option>Airbnb</option>
                <option>Diretto</option><option>Altro</option>
              </select>
            </div>
            <div>
              <label>Cod. prenotazione</label>
              <input value={d.codPrenotazione} onChange={(e) => setD({ ...d, codPrenotazione: e.target.value })} />
            </div>
          </div>

          <div className="row">
            <div>
              <label>Check-in *</label>
              <input type="date" value={d.checkin} onChange={(e) => setD({ ...d, checkin: e.target.value })} />
            </div>
            <div>
              <label>Check-out *</label>
              <input type="date" value={d.checkout} onChange={(e) => setD({ ...d, checkout: e.target.value })} />
            </div>
          </div>

          <div className="row">
            <div>
              <label>Quanti ospiti *</label>
              <input type="number" min={1} inputMode="numeric" value={d.ospitiAttesi}
                onChange={(e) => setD({ ...d, ospitiAttesi: e.target.value })} />
            </div>
            <div>
              <label>Importo lordo €</label>
              <input type="number" step="0.01" inputMode="decimal" value={d.importoLordo}
                onChange={(e) => setD({ ...d, importoLordo: e.target.value })} />
            </div>
          </div>
          <div className="hint">
            Il numero di ospiti è il metro con cui si stabilisce se il check-in è completo:
            se le schede compilate sono meno, <b>CHECKIN OK non compare</b>.
          </div>

          <label>Nome di chi ha prenotato</label>
          <input value={d.intestatario} onChange={(e) => setD({ ...d, intestatario: e.target.value })} />

          {/*
            Il telefono serve al pulsante WhatsApp: con il numero, si apre la
            chat gia' su quella persona e resta solo da premere invio. Senza,
            il pulsante funziona lo stesso ma tocca cercare il contatto — che
            e' l'unico passaggio in cui si sbaglia davvero.
          */}
          <label>Telefono dell&apos;ospite</label>
          <input
            inputMode="tel" placeholder="+39 333 1234567"
            value={d.telefono} onChange={(e) => setD({ ...d, telefono: e.target.value })}
          />
          <div className="hint">
            Copialo da Booking. Serve al pulsante WhatsApp: senza, tocca cercare il contatto a mano.
          </div>

          <label>Email dell&apos;ospite</label>
          <input
            type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })}
          />
          <div className="hint">
            Facoltativa. Se la scrivi, il link parte anche per email — una rete di sicurezza
            se il messaggio WhatsApp non viene letto.
          </div>

          <label>Note</label>
          <input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
        </section>
      </div>

      <div className="barra">
        <button className="btn btn-pri" disabled={invio} onClick={crea}>
          {invio ? 'Creo…' : 'Apri la prenotazione e dammi il link'}
        </button>
      </div>

      <style jsx global>{STILE}</style>
    </>
  )
}

export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <NuovaPrenotazione />
    </Suspense>
  )
}

const STILE = `
  :root{--blu:#1f3864;--bordo:#d7dce5;--bg:#f4f6fa;--ok:#0f7b4f;--err:#b3261e;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    margin:0;padding:0 0 calc(140px + env(safe-area-inset-bottom));background:var(--bg);color:#1a1a1a;font-size:16px}
  header{background:#fff;border-bottom:3px solid var(--blu);padding:14px 18px 12px;
    box-shadow:0 1px 6px rgba(31,56,100,.08)}
  header .logo{display:block;height:34px;width:auto;max-width:100%;margin:0 0 9px}
  header .titolo h1{margin:0;font-size:16px;font-weight:600;color:var(--blu)}
  header .titolo p{margin:2px 0 0;font-size:11.5px;color:#6b7280;line-height:1.35}
  .wrap{padding:14px}
  section{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:14px;margin-bottom:12px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--blu);margin:0 0 8px}
  label{display:block;font-size:12px;font-weight:600;color:#4a5568;margin:10px 0 4px}
  input,select{width:100%;padding:11px;border:1px solid var(--bordo);border-radius:8px;
    font-size:16px;font-family:inherit;background:#fff}
  input:focus,select:focus{outline:2px solid var(--blu);border-color:var(--blu)}
  .row{display:flex;gap:10px}.row>div{flex:1}
  .btn{display:block;width:100%;padding:14px;border:none;border-radius:8px;font-size:15px;
    font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-top:10px}
  .btn-pri{background:var(--blu);color:#fff}
  .btn-pri:disabled{opacity:.5}
  .btn-sec{background:#fff;border:1.5px dashed var(--blu);color:var(--blu)}
  .barra{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--bordo);
    padding:12px 14px calc(12px + env(safe-area-inset-bottom))}
  .hint{font-size:11px;color:#6b7280;margin-top:6px;line-height:1.45}
  .spiega{font-size:12px;color:#6b7280;margin:0 0 10px;line-height:1.45}
  .esito{padding:14px;border-radius:8px;margin-bottom:12px;font-size:14px;line-height:1.5}
  .esito.ko{background:#fdeceb;border:1px solid var(--err);color:#8c1d18}
  .link{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;
    background:#f4f6fa;border:1px solid var(--bordo);border-radius:8px;padding:10px;color:#2b3a55}
  .riga-ospite{display:flex;justify-content:space-between;align-items:center;
    padding:10px 0;border-bottom:1px solid #eef1f6;font-size:14px}
  .riga-ospite:last-child{border-bottom:none}
  .btn-mini{background:#fff;border:1px solid var(--blu);color:var(--blu);border-radius:6px;
    padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer}

  /* Da computer: colonna centrata e marchio in proporzione. Vedi /checkin. */
  @media (min-width:820px){
    header{padding:22px calc(50% - 360px) 18px}
    header .logo{height:66px;margin:0 0 14px}
    header .titolo h1{font-size:21px}
    header .titolo p{font-size:13px}
    .wrap{max-width:720px;margin:0 auto;padding:22px 0}
    .barra>*{max-width:720px;margin-left:auto;margin-right:auto}
  }
`

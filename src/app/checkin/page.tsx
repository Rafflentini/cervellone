'use client'

/**
 * /checkin — il form di registrazione, quello che sta in mano a chi consegna le
 * chiavi o all'ospite stesso.
 *
 * Il layout e' quello del Form.html dell'11 agosto, ripreso senza reinventarlo:
 * stessa palette (#1f3864), stesse tre sezioni, stessa barra fissa in fondo,
 * stesso calcolo dal vivo dell'imposta. I 16px sugli input non sono estetica —
 * sotto quella misura iOS ingrandisce la pagina da solo appena tocchi un campo,
 * e chi compila si ritrova la schermata spostata.
 *
 * Ogni etichetta e' in italiano con l'inglese sotto. Non un pulsante che cambia
 * lingua: cosi' la ragazza legge l'italiano e l'ospite legge l'inglese sulla
 * STESSA schermata, senza passarsi il telefono.
 */

import { useEffect, useMemo, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { validaCodiceFiscale } from '@/lib/checkin/valida-codice-fiscale'
import { calcolaImpostaSoggiorno, REGOLE_MARATEA, type RegoleImposta } from '@/lib/checkin/imposta-soggiorno'

interface Ospite {
  tipoAlloggiato: string
  cognome: string
  nome: string
  sesso: string
  dataNascita: string
  comuneNascita: string
  provNascita: string
  statoNascita: string
  cittadinanza: string
  tipoDocumento: string
  numeroDocumento: string
  luogoRilascio: string
  codiceFiscale: string
  esente: boolean
  motivoEsenzione: string
}

const OSPITE_VUOTO: Ospite = {
  tipoAlloggiato: '16', cognome: '', nome: '', sesso: 'M', dataNascita: '',
  comuneNascita: '', provNascita: '', statoNascita: '', cittadinanza: 'ITALIA',
  tipoDocumento: 'IDENT', numeroDocumento: '', luogoRilascio: '',
  codiceFiscale: '', esente: false, motivoEsenzione: '',
}

const TIPI_ALLOGGIATO: Array<[string, string, string]> = [
  ['16', 'Ospite singolo', 'Single guest'],
  ['17', 'Capofamiglia', 'Head of family'],
  ['18', 'Capogruppo', 'Group leader'],
  ['19', 'Familiare', 'Family member'],
  ['20', 'Membro gruppo', 'Group member'],
]

const TIPI_DOCUMENTO: Array<[string, string, string]> = [
  ['IDENT', "Carta d'identità", 'Identity card'],
  ['PASOR', 'Passaporto ordinario', 'Passport'],
  ['PATEN', 'Patente di guida', 'Driving licence'],
  ['ALTRO', 'Altro documento', 'Other document'],
]

/** Etichetta bilingue: italiano sopra, inglese sotto in corpo minore. */
function Eti({ it, en }: { it: string; en: string }) {
  return (
    <label>
      {it}
      <span className="en">{en}</span>
    </label>
  )
}

function CheckinForm() {
  const params = useSearchParams()
  const k = params.get('k') ?? ''

  const [caricato, setCaricato] = useState(false)
  const [erroreAvvio, setErroreAvvio] = useState('')
  const [unita, setUnita] = useState<string[]>([])
  const [regole, setRegole] = useState<RegoleImposta>(REGOLE_MARATEA)
  const [comuni, setComuni] = useState<Array<{ n: string; p: string }>>([])
  const [stati, setStati] = useState<Array<{ n: string }>>([])

  const [sog, setSog] = useState({
    unita: '', portale: 'Booking', codPrenotazione: '', checkin: '', checkout: '',
    importoLordo: '', intestatario: '', codiceFiscale: '', piva: '', sdi: '',
    indirizzo: '', cap: '', citta: '', provincia: '', nazione: 'IT',
    email: '', telefono: '', note: '',
  })
  const [ospiti, setOspiti] = useState<Ospite[]>([{ ...OSPITE_VUOTO }])
  /** Chiusa per un privato: i suoi dati sono gia' fra gli ospiti. */
  const [fatturaAltri, setFatturaAltri] = useState(false)
  const [invio, setInvio] = useState(false)
  const [esito, setEsito] = useState<{ tipo: 'ok' | 'ko'; testo: string[] } | null>(null)

  useEffect(() => {
    if (!k) { setErroreAvvio('Collegamento incompleto: manca il codice di accesso.'); return }
    fetch(`/api/checkin/dati?k=${encodeURIComponent(k)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setErroreAvvio(d.errore || 'Collegamento non valido.'); return }
        setUnita(d.unita ?? [])
        setRegole(d.regole ?? REGOLE_MARATEA)
        setComuni(d.comuni ?? [])
        setStati(d.stati ?? [])
        setSog((s) => ({ ...s, unita: (d.unita ?? [])[0] ?? '' }))
        setCaricato(true)
      })
      .catch(() => setErroreAvvio('Non riesco a caricare la configurazione.'))
  }, [k])

  /** Lo stesso calcolo del server, cosi' la cifra mostrata e' quella salvata. */
  const anteprima = useMemo(() => {
    if (!sog.checkin || !sog.checkout) return null
    return calcolaImpostaSoggiorno({
      checkin: sog.checkin,
      checkout: sog.checkout,
      regole,
      ospiti: ospiti.map((o) => ({
        dataNascita: o.dataNascita, esente: o.esente, motivoEsenzione: o.motivoEsenzione,
      })),
    })
  }, [sog.checkin, sog.checkout, ospiti, regole])

  /** Chi risultera' intestatario se non si dichiara nessun altro. */
  const intestatarioDedotto = useMemo(() => {
    const o = ospiti[0]
    if (!o) return ''
    return `${o.cognome} ${o.nome}`.trim().toUpperCase()
  }, [ospiti])

  const cambiaOspite = (i: number, campo: keyof Ospite, valore: string | boolean) =>
    setOspiti((prev) => prev.map((o, j) => (j === i ? { ...o, [campo]: valore } : o)))

  /** Verifica del CF mentre si scrive: l'errore si vede subito, non al salvataggio. */
  function statoCf(o: Ospite): { classe: string; messaggio: string } {
    const cf = o.codiceFiscale.trim()
    if (!cf) return { classe: '', messaggio: '' }
    const v = validaCodiceFiscale(cf, { dataNascita: o.dataNascita, sesso: o.sesso })
    if (!v.valido) return { classe: 'ko', messaggio: v.errore }
    if (v.coerente === false) return { classe: 'attenzione', messaggio: v.avvisoCoerenza ?? '' }
    return { classe: 'ok', messaggio: 'Codice fiscale valido / Valid' }
  }

  const cfBloccanti = ospiti.some((o) => {
    const cf = o.codiceFiscale.trim()
    return cf !== '' && !validaCodiceFiscale(cf).valido
  })

  async function invia() {
    setInvio(true)
    setEsito(null)
    try {
      const res = await fetch(`/api/checkin/registra?k=${encodeURIComponent(k)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sog, ospiti }),
      })
      const d = await res.json()
      if (!d.ok) {
        setEsito({ tipo: 'ko', testo: d.errori ?? ['Non salvato.'] })
      } else {
        setEsito({
          tipo: 'ok',
          testo: [
            `Check-in registrato — ${d.id}`,
            `${d.notti} notti · imposta di soggiorno € ${d.imposta}`,
            ...(d.avvisi ?? []),
          ],
        })
        setOspiti([{ ...OSPITE_VUOTO }])
        setSog((s) => ({
          ...s, codPrenotazione: '', checkin: '', checkout: '', importoLordo: '',
          intestatario: '', codiceFiscale: '', piva: '', sdi: '', indirizzo: '',
          cap: '', citta: '', provincia: '', email: '', telefono: '', note: '',
        }))
      }
    } catch {
      setEsito({ tipo: 'ko', testo: ['Connessione assente. Riprova.'] })
    } finally {
      setInvio(false)
      window.scrollTo(0, 0)
    }
  }

  if (erroreAvvio) {
    return (
      <main className="wrap">
        <div className="esito ko">{erroreAvvio}</div>
        <style jsx global>{STILE}</style>
      </main>
    )
  }

  return (
    <>
      <header>
        <h1>Registrazione check-in</h1>
        <p>LA REAL ESTATE SRLS — dati per Questura, imposta di soggiorno e fattura</p>
        <p className="en-header">Guest registration — required by law for police records, tourist tax and invoicing</p>
      </header>

      <div className="wrap">
        {esito && (
          <div className={`esito ${esito.tipo}`}>
            {esito.testo.map((t, i) => <div key={i}>{t}</div>)}
          </div>
        )}

        <section>
          <h2>Soggiorno / Stay</h2>

          <Eti it="Unità" en="Property" />
          <select value={sog.unita} onChange={(e) => setSog({ ...sog, unita: e.target.value })}>
            {unita.length === 0 && <option value="">—</option>}
            {unita.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>

          <div className="row">
            <div>
              <Eti it="Portale" en="Booking channel" />
              <select value={sog.portale} onChange={(e) => setSog({ ...sog, portale: e.target.value })}>
                <option>Booking</option><option>Airbnb</option>
                <option>Diretto</option><option>Altro</option>
              </select>
            </div>
            <div>
              <Eti it="Cod. prenotazione" en="Booking ref." />
              <input value={sog.codPrenotazione} onChange={(e) => setSog({ ...sog, codPrenotazione: e.target.value })} />
            </div>
          </div>

          <div className="row">
            <div>
              <Eti it="Check-in" en="Arrival" />
              <input type="date" value={sog.checkin} onChange={(e) => setSog({ ...sog, checkin: e.target.value })} />
            </div>
            <div>
              <Eti it="Check-out" en="Departure" />
              <input type="date" value={sog.checkout} onChange={(e) => setSog({ ...sog, checkout: e.target.value })} />
            </div>
          </div>

          <Eti it="Importo lordo incassato €" en="Total amount paid €" />
          <input
            type="number" step="0.01" inputMode="decimal"
            value={sog.importoLordo}
            onChange={(e) => setSog({ ...sog, importoLordo: e.target.value })}
          />
          <div className="hint">
            Totale pagato dall&apos;ospite, commissione del portale <b>inclusa</b>.
            <span className="en">Total paid by the guest, channel commission included.</span>
          </div>

          {anteprima && (
            <div className="calcolo">
              {anteprima.notti} notti · {ospiti.length} ospiti · imposta di soggiorno stimata € {anteprima.importo.toFixed(2)}
              {anteprima.esenti.length > 0 && (
                <div className="esenti">
                  {anteprima.esenti.length} esente/i: {anteprima.esenti.map((e) => `ospite ${e.indice + 1} (${e.motivo})`).join(', ')}
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <h2>Ospiti / Guests</h2>
          {ospiti.map((o, i) => {
            const cf = statoCf(o)
            return (
              <div className="ospite" key={i}>
                <h3>
                  Ospite {i + 1} / Guest {i + 1}
                  {ospiti.length > 1 && (
                    <button className="rimuovi" onClick={() => setOspiti(ospiti.filter((_, j) => j !== i))}>
                      rimuovi / remove
                    </button>
                  )}
                </h3>

                <Eti it="Tipo" en="Type" />
                <select value={o.tipoAlloggiato} onChange={(e) => cambiaOspite(i, 'tipoAlloggiato', e.target.value)}>
                  {TIPI_ALLOGGIATO.map(([v, it, en]) => <option key={v} value={v}>{it} / {en}</option>)}
                </select>

                <div className="row">
                  <div>
                    <Eti it="Cognome" en="Surname" />
                    <input className="maiusc" value={o.cognome} onChange={(e) => cambiaOspite(i, 'cognome', e.target.value)} />
                  </div>
                  <div>
                    <Eti it="Nome" en="First name" />
                    <input className="maiusc" value={o.nome} onChange={(e) => cambiaOspite(i, 'nome', e.target.value)} />
                  </div>
                </div>

                <div className="row">
                  <div style={{ maxWidth: 130 }}>
                    <Eti it="Sesso" en="Sex" />
                    <select value={o.sesso} onChange={(e) => cambiaOspite(i, 'sesso', e.target.value)}>
                      <option value="M">M</option><option value="F">F</option>
                    </select>
                  </div>
                  <div>
                    <Eti it="Data di nascita" en="Date of birth" />
                    <input type="date" value={o.dataNascita} onChange={(e) => cambiaOspite(i, 'dataNascita', e.target.value)} />
                  </div>
                </div>

                <div className="row">
                  <div style={{ flex: 2 }}>
                    <Eti it="Comune di nascita (se in Italia)" en="Town of birth (if born in Italy)" />
                    <input
                      className="maiusc" list={`comuni-${i}`} value={o.comuneNascita}
                      onChange={(e) => cambiaOspite(i, 'comuneNascita', e.target.value)}
                    />
                    <datalist id={`comuni-${i}`}>
                      {comuni.map((c) => <option key={c.n} value={c.n}>{c.p}</option>)}
                    </datalist>
                  </div>
                  <div style={{ maxWidth: 90 }}>
                    <Eti it="Prov." en="Prov." />
                    <input className="maiusc" maxLength={2} value={o.provNascita} onChange={(e) => cambiaOspite(i, 'provNascita', e.target.value)} />
                  </div>
                </div>

                <Eti it="Stato di nascita (se nato all'estero)" en="Country of birth (if born abroad)" />
                <input
                  className="maiusc" list={`stati-${i}`} value={o.statoNascita}
                  onChange={(e) => cambiaOspite(i, 'statoNascita', e.target.value)}
                />
                <datalist id={`stati-${i}`}>
                  {stati.map((s) => <option key={s.n} value={s.n} />)}
                </datalist>

                <Eti it="Cittadinanza" en="Citizenship / Nationality" />
                <input
                  className="maiusc" list={`stati-${i}`} value={o.cittadinanza}
                  onChange={(e) => cambiaOspite(i, 'cittadinanza', e.target.value)}
                />
                <div className="hint">
                  Scrivi <b>ITALIA</b> se sei italiano.
                  <span className="en">Type your country in Italian, or pick it from the list.</span>
                </div>

                <Eti it="Tipo documento" en="Document type" />
                <select value={o.tipoDocumento} onChange={(e) => cambiaOspite(i, 'tipoDocumento', e.target.value)}>
                  {TIPI_DOCUMENTO.map(([v, it, en]) => <option key={v} value={v}>{it} / {en}</option>)}
                </select>

                <div className="row">
                  <div>
                    <Eti it="Numero documento" en="Document number" />
                    <input className="maiusc" value={o.numeroDocumento} onChange={(e) => cambiaOspite(i, 'numeroDocumento', e.target.value)} />
                  </div>
                  <div>
                    <Eti it="Luogo di rilascio" en="Place of issue" />
                    <input className="maiusc" value={o.luogoRilascio} onChange={(e) => cambiaOspite(i, 'luogoRilascio', e.target.value)} />
                  </div>
                </div>

                <Eti it="Codice fiscale (obbligatorio per i cittadini italiani)" en="Italian tax code (only if you have one)" />
                <input
                  className={`maiusc cf ${cf.classe}`} maxLength={16}
                  value={o.codiceFiscale}
                  onChange={(e) => cambiaOspite(i, 'codiceFiscale', e.target.value.toUpperCase())}
                />
                {cf.messaggio && <div className={`verifica ${cf.classe}`}>{cf.messaggio}</div>}

                <label className="spunta">
                  <input type="checkbox" checked={o.esente} onChange={(e) => cambiaOspite(i, 'esente', e.target.checked)} />
                  Esente da imposta di soggiorno / Exempt from tourist tax
                </label>
                {o.esente && (
                  <input
                    placeholder="Motivo esenzione / Reason for exemption"
                    value={o.motivoEsenzione}
                    onChange={(e) => cambiaOspite(i, 'motivoEsenzione', e.target.value)}
                  />
                )}
                <div className="hint">
                  I minori fino a {regole.esenzioneEtaMax} anni sono esenti per legge: non serve spuntare nulla.
                  <span className="en">Children up to {regole.esenzioneEtaMax} are exempt by law — no need to tick.</span>
                </div>
              </div>
            )
          })}
          <button className="btn btn-sec" onClick={() => setOspiti([...ospiti, { ...OSPITE_VUOTO }])}>
            + Aggiungi ospite / Add guest
          </button>
        </section>

        <section>
          <h2>Fattura / Invoice</h2>

          {/*
            Per un privato questa sezione era ridondante: nome e codice fiscale
            erano gia' stati scritti fra gli ospiti. Ora la fattura va da se' al
            primo ospite, e si apre solo se serve intestarla ad altri.
            L'indirizzo resta sempre: nella fattura elettronica la sede del
            destinatario e' obbligatoria anche per un privato, e il check-in
            raccoglie il luogo di NASCITA, non la residenza.
          */}
          {!fatturaAltri && (
            <div className="intestata">
              Fattura intestata a{' '}
              <b>{intestatarioDedotto || '— aggiungi prima un ospite'}</b>
              {ospiti[0]?.codiceFiscale ? ` · ${ospiti[0].codiceFiscale}` : ''}
              <span className="en">The invoice will be issued to the first guest.</span>
            </div>
          )}

          <label className="spunta">
            <input
              type="checkbox" checked={fatturaAltri}
              onChange={(e) => {
                setFatturaAltri(e.target.checked)
                if (!e.target.checked) setSog((s) => ({ ...s, intestatario: '', codiceFiscale: '', piva: '', sdi: '' }))
              }}
            />
            Fattura a un&apos;azienda o a un&apos;altra persona / Invoice to a company or someone else
          </label>

          {fatturaAltri && (
            <>
              <div className="prevale">
                La fattura sarà intestata <b>a questi dati</b>, non all&apos;ospite.
                <span className="en">The invoice will be issued to these details instead of the guest.</span>
              </div>
              <Eti it="Denominazione o intestatario" en="Company name / Invoice to" />
              <input value={sog.intestatario} onChange={(e) => setSog({ ...sog, intestatario: e.target.value })} />

              <div className="row">
                <div>
                  <Eti it="Codice fiscale" en="Tax code" />
                  <input className="maiusc" maxLength={16} value={sog.codiceFiscale} onChange={(e) => setSog({ ...sog, codiceFiscale: e.target.value.toUpperCase() })} />
                </div>
                <div>
                  <Eti it="P.IVA (se azienda)" en="VAT no. (companies)" />
                  <input value={sog.piva} onChange={(e) => setSog({ ...sog, piva: e.target.value })} />
                </div>
              </div>

              <Eti it="Codice SDI / PEC" en="e-invoicing code" />
              <input placeholder="0000000 se privato italiano" value={sog.sdi} onChange={(e) => setSog({ ...sog, sdi: e.target.value })} />
            </>
          )}

          <div className="hint" style={{ marginTop: 12 }}>
            L&apos;indirizzo serve <b>sempre</b>: senza, la fattura elettronica non si genera.
            <span className="en">The address is always required — the e-invoice cannot be issued without it.</span>
          </div>

          <Eti it="Indirizzo di residenza *" en="Home address *" />
          <input value={sog.indirizzo} onChange={(e) => setSog({ ...sog, indirizzo: e.target.value })} />

          <div className="row">
            <div><Eti it="CAP *" en="Postcode *" /><input value={sog.cap} onChange={(e) => setSog({ ...sog, cap: e.target.value })} /></div>
            <div style={{ flex: 2 }}><Eti it="Città *" en="Town *" /><input value={sog.citta} onChange={(e) => setSog({ ...sog, citta: e.target.value })} /></div>
            <div style={{ maxWidth: 90 }}><Eti it="Prov." en="Prov." /><input className="maiusc" maxLength={2} value={sog.provincia} onChange={(e) => setSog({ ...sog, provincia: e.target.value })} /></div>
          </div>

          <div className="row">
            <div><Eti it="Nazione" en="Country" /><input className="maiusc" maxLength={2} value={sog.nazione} onChange={(e) => setSog({ ...sog, nazione: e.target.value })} /></div>
            <div style={{ flex: 2 }}><Eti it="Email" en="Email" /><input type="email" value={sog.email} onChange={(e) => setSog({ ...sog, email: e.target.value })} /></div>
          </div>

          <Eti it="Telefono" en="Phone" />
          <input inputMode="tel" value={sog.telefono} onChange={(e) => setSog({ ...sog, telefono: e.target.value })} />

          <Eti it="Note" en="Notes" />
          <textarea rows={2} value={sog.note} onChange={(e) => setSog({ ...sog, note: e.target.value })} />
        </section>
      </div>

      <div className="barra">
        <button className="btn btn-pri" disabled={invio || !caricato || cfBloccanti} onClick={invia}>
          {invio ? 'Salvataggio…' : 'Salva check-in / Save'}
        </button>
        {cfBloccanti && (
          <div className="blocco">
            C&apos;è un codice fiscale non valido: correggilo per proseguire.
            <span className="en">One tax code is not valid — please correct it.</span>
          </div>
        )}
      </div>

      <style jsx global>{STILE}</style>
    </>
  )
}

export default function Pagina() {
  return (
    <Suspense fallback={null}>
      <CheckinForm />
    </Suspense>
  )
}

const STILE = `
  :root{--blu:#1f3864;--bordo:#d7dce5;--bg:#f4f6fa;--ok:#0f7b4f;--err:#b3261e;--att:#8a6100;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    margin:0;padding:0 0 110px;background:var(--bg);color:#1a1a1a;font-size:16px}
  header{background:var(--blu);color:#fff;padding:16px 18px;position:sticky;top:0;z-index:10}
  header h1{margin:0;font-size:17px;font-weight:600}
  header p{margin:3px 0 0;font-size:12px;opacity:.75}
  header p.en-header{opacity:.55;font-style:italic}
  .wrap{padding:14px}
  section{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:14px;margin-bottom:12px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--blu);margin:0 0 12px}
  label{display:block;font-size:12px;font-weight:600;color:#4a5568;margin:10px 0 4px}
  label .en{display:block;font-weight:400;font-size:11px;color:#8a94a6;font-style:italic}
  input,select,textarea{width:100%;padding:11px;border:1px solid var(--bordo);border-radius:8px;
    font-size:16px;font-family:inherit;background:#fff}
  input:focus,select:focus{outline:2px solid var(--blu);border-color:var(--blu)}
  .maiusc{text-transform:uppercase}
  .row{display:flex;gap:10px}.row>div{flex:1}
  .ospite{border:1px solid var(--bordo);border-radius:8px;padding:12px;margin-bottom:10px;background:#fafbfd}
  .ospite h3{margin:0 0 6px;font-size:13px;color:var(--blu);display:flex;justify-content:space-between;align-items:center}
  .rimuovi{background:none;border:none;color:var(--err);font-size:12px;cursor:pointer;padding:2px 6px;width:auto}
  .btn{width:100%;padding:14px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  .btn-sec{background:#fff;border:1.5px dashed var(--blu);color:var(--blu)}
  .btn-pri{background:var(--blu);color:#fff}
  .btn-pri:disabled{opacity:.5}
  .barra{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--bordo);padding:12px 14px}
  .hint{font-size:11px;color:#6b7280;margin-top:4px;line-height:1.4}
  .hint .en{display:block;font-style:italic;color:#8a94a6}
  .esito{padding:14px;border-radius:8px;margin-bottom:12px;font-size:14px;line-height:1.6}
  .esito.ok{background:#e7f5ee;border:1px solid var(--ok);color:#0b5c3b}
  .esito.ko{background:#fdeceb;border:1px solid var(--err);color:#8c1d18}
  .cf{font-family:ui-monospace,Menlo,monospace;font-weight:700;letter-spacing:.5px}
  .cf.ok{border-color:var(--ok)}
  .cf.ko{border-color:var(--err);background:#fff7f7}
  .cf.attenzione{border-color:var(--att);background:#fffdf5}
  .verifica{font-size:11px;margin-top:4px;line-height:1.4}
  .verifica.ok{color:var(--ok)}
  .verifica.ko{color:var(--err);font-weight:600}
  .verifica.attenzione{color:var(--att);font-weight:600}
  .spunta{display:flex;align-items:center;gap:8px;margin-top:12px;font-weight:600}
  .spunta input{width:auto;margin:0}
  .intestata{background:#eef2f9;border:1px solid var(--bordo);border-radius:8px;padding:10px 12px;
    font-size:13px;color:#2b3a55;line-height:1.5;margin-bottom:4px}
  .intestata .en{display:block;font-size:11px;font-style:italic;color:#8a94a6}
  .prevale{background:#fff6e5;border:1px solid #e0c48a;border-radius:8px;padding:10px 12px;font-size:12px;color:#6b4e00;line-height:1.5;margin:10px 0 4px}
  .prevale .en{display:block;font-size:11px;font-style:italic;opacity:.8}
  .calcolo{margin-top:10px;font-size:12px;color:var(--blu);font-weight:600;line-height:1.5}
  .calcolo .esenti{font-weight:400;color:#6b7280}
  .blocco{font-size:11px;color:var(--err);margin-top:8px;line-height:1.4;text-align:center}
  .blocco .en{display:block;font-style:italic;opacity:.8}
`

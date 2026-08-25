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
import { decodificaCf } from '@/lib/checkin/decodifica-cf'
import { calcolaImpostaSoggiorno, REGOLE_MARATEA, type RegoleImposta } from '@/lib/checkin/imposta-soggiorno'
import {
  soggiornoDaColonne, soggiornoAColonne, ospiteDaColonne, ospiteAColonne,
  campoBloccato, type FormOspite,
} from '@/lib/checkin/mappa-form'

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

/** 'aaaa-mm-gg' -> 'gg/mm/aaaa'. Un ospite non legge le date al contrario. */
function dataIT(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—')
}

/** Dalla forma condivisa col server a quella dello stato del form. */
function daForm(f: FormOspite): Ospite {
  return {
    tipoAlloggiato: f.tipoAlloggiato || '16',
    cognome: f.cognome, nome: f.nome, sesso: f.sesso || 'M',
    dataNascita: f.dataNascita, comuneNascita: f.comuneNascita,
    provNascita: f.provNascita, statoNascita: f.statoNascita,
    cittadinanza: f.cittadinanza || 'ITALIA',
    tipoDocumento: f.tipoDocumento || 'IDENT',
    numeroDocumento: f.numeroDocumento, luogoRilascio: f.luogoRilascio,
    codiceFiscale: f.codiceFiscale,
    esente: f.esente, motivoEsenzione: f.motivoEsenzione,
  }
}

/**
 * Riduce la foto PRIMA di mandarla.
 *
 * Un telefono recente scatta a 12 megapixel: sono 4-6 MB, che non passano il
 * limite della piattaforma e che su una tacca di segnale non partono proprio.
 * A 1600 pixel di lato lungo un documento resta perfettamente leggibile e pesa
 * qualche centinaio di kilobyte.
 *
 * C'e' anche un motivo che non riguarda i byte: la foto ridotta e' quella che
 * poi conserviamo. Meno risoluzione del necessario e' meno dato personale
 * custodito, e questa e' l'unica quantita' che conviene sempre minimizzare.
 */
async function riduciImmagine(file: File, latoMax = 1600): Promise<Blob> {
  if (file.type === 'application/pdf') return file

  const bitmap = await createImageBitmap(file)
  const scala = Math.min(1, latoMax / Math.max(bitmap.width, bitmap.height))
  const l = Math.round(bitmap.width * scala)
  const a = Math.round(bitmap.height * scala)

  const tela = document.createElement('canvas')
  tela.width = l
  tela.height = a
  const ctx = tela.getContext('2d')
  if (!ctx) return file
  ctx.drawImage(bitmap, 0, 0, l, a)

  return new Promise<Blob>((risolvi) => {
    tela.toBlob((b) => risolvi(b ?? file), 'image/jpeg', 0.82)
  })
}

/** Etichetta bilingue: italiano sopra, inglese sotto in corpo minore. */
function Eti({ it, en }: { it: string; en: string }) {
  return (
    <label>
      {it}
      <span className="en">{en}</span>
    </label>
  )
}

interface ComuneTrovato { e: string; n: string; p: string; cap: string }

/**
 * Campo comune con ricerca.
 *
 * Non e' un vezzo: il comune di nascita determina il codice fiscale e quello di
 * residenza finisce in fattura. Scritti a mano, "Reggio Emilia" e "Reggio
 * nell'Emilia" sono due cose diverse per il sistema e la stessa per chi scrive.
 *
 * L'elenco mostra sempre la sigla di provincia perche' sei comuni italiani
 * hanno un omonimo con codice catastale diverso: CALLIANO (AT/TN), CASTRO
 * (BG/LE), LIVO (CO/TN), PEGLIO (CO/PU), SAMONE (TO/TN), SAN TEODORO (ME/SS).
 */
function CercaComune({
  accesso, valore, onScegli, placeholder,
}: {
  accesso: string
  valore: string
  onScegli: (c: ComuneTrovato) => void
  placeholder?: string
}) {
  const [testo, setTesto] = useState(valore)
  const [risultati, setRisultati] = useState<ComuneTrovato[]>([])
  const [aperto, setAperto] = useState(false)

  useEffect(() => { setTesto(valore) }, [valore])

  useEffect(() => {
    if (!aperto || testo.trim().length < 2) { setRisultati([]); return }
    // Mezzo secondo di attesa: si cerca quando smetti di scrivere, non a ogni
    // tasto. In cantiere la rete e' quella che e'.
    const t = setTimeout(() => {
      fetch(`/api/checkin/comuni?${accesso}&q=${encodeURIComponent(testo)}`)
        .then((r) => r.json())
        .then((d) => setRisultati(d.comuni ?? []))
        .catch(() => setRisultati([]))
    }, 400)
    return () => clearTimeout(t)
  }, [testo, aperto, accesso])

  return (
    <div className="cerca">
      <input
        className="maiusc"
        value={testo}
        placeholder={placeholder}
        onChange={(e) => { setTesto(e.target.value); setAperto(true) }}
        onFocus={() => setAperto(true)}
        // Il ritardo serve: senza, il click su una voce arriva dopo la chiusura.
        onBlur={() => setTimeout(() => setAperto(false), 200)}
      />
      {aperto && risultati.length > 0 && (
        <ul className="elenco">
          {risultati.map((c) => (
            <li key={`${c.n}-${c.p}`} onMouseDown={() => { onScegli(c); setTesto(c.n); setAperto(false) }}>
              {c.e}
              {c.cap ? <span className="cap">{c.cap}</span> : <span className="cap multi">più CAP</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CheckinForm() {
  const params = useSearchParams()
  const k = params.get('k') ?? ''
  /** Prenotazione da riprendere. Se c'e', il form completa invece di creare. */
  const p = params.get('p') ?? ''
  const t = params.get('t') ?? ''
  /** Progressivo dell'ospite, se il link e' quello di una singola scheda. */
  const o = params.get('o') ?? ''

  const inPratica = p !== ''
  /** Query da appendere alle chiamate: porta con se' il livello di accesso. */
  const q = inPratica
    ? `p=${encodeURIComponent(p)}&t=${encodeURIComponent(t)}${o ? `&o=${encodeURIComponent(o)}` : ''}${k ? `&k=${encodeURIComponent(k)}` : ''}`
    : `k=${encodeURIComponent(k)}`

  const [caricato, setCaricato] = useState(false)
  const [erroreAvvio, setErroreAvvio] = useState('')
  const [unita, setUnita] = useState<string[]>([])
  const [regole, setRegole] = useState<RegoleImposta>(REGOLE_MARATEA)
  const [comuni, setComuni] = useState<Array<{ n: string; p: string }>>([])
  const [stati, setStati] = useState<Array<{ n: string }>>([])

  /** Colonne che questo livello non puo' cambiare: arrivano dal server. */
  const [colonneBloccate, setColonneBloccate] = useState<string[]>([])
  /** Se valorizzato, si compila SOLO la scheda di quell'ospite. */
  const [mioProgressivo, setMioProgressivo] = useState<number | null>(null)
  const [statoPratica, setStatoPratica] = useState('')
  /** Quale foto si sta caricando, per non far premere due volte. */
  const [docInvio, setDocInvio] = useState('')
  /** Quali foto risultano gia caricate, per lato e per ospite. */
  const [docCaricati, setDocCaricati] = useState<Record<string, boolean>>({})
  const [mancanze, setMancanze] = useState<string[]>([])
  /** I link delle singole schede: servono all'intestatario per girarli. */
  const [linkOspiti, setLinkOspiti] = useState<Array<{ progressivo: number; link: string | null }>>([])

  /**
   * Chi apre con un link di prenotazione non modifica il soggiorno: lo
   * riconosce. Il gestore invece riceve un elenco di bloccati vuoto e continua
   * a vedere i campi, perche' a lui puo' servire correggere una data.
   */
  const soloLettura = inPratica && colonneBloccate.length > 0

  const [sog, setSog] = useState({
    unita: '', portale: 'Booking', codPrenotazione: '', checkin: '', checkout: '', ospitiAttesi: '',
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
    if (!k && !inPratica) {
      setErroreAvvio('Collegamento incompleto: manca il codice di accesso.')
      return
    }

    const configurazione = fetch(`/api/checkin/dati?${q}`).then((r) => r.json())
    const pratica = inPratica
      ? fetch(`/api/checkin/pratica?${q}`).then((r) => r.json())
      : Promise.resolve(null)

    Promise.all([configurazione, pratica])
      .then(([cfg, pr]) => {
        if (!cfg?.ok) { setErroreAvvio(cfg?.errore || 'Collegamento non valido.'); return }
        setUnita(cfg.unita ?? [])
        setRegole(cfg.regole ?? REGOLE_MARATEA)
        setComuni(cfg.comuni ?? [])
        setStati(cfg.stati ?? [])

        if (!inPratica) {
          setSog((s) => ({ ...s, unita: (cfg.unita ?? [])[0] ?? '' }))
          setCaricato(true)
          return
        }

        if (!pr?.ok) { setErroreAvvio(pr?.errore || 'Collegamento non valido.'); return }

        setColonneBloccate(pr.campiBloccati ?? [])
        setMioProgressivo(pr.mioProgressivo ?? null)
        setLinkOspiti(pr.linkOspiti ?? [])
        setStatoPratica(pr.stato ?? '')

        const s = soggiornoDaColonne(pr.soggiorno ?? {})
        setSog((prec) => ({ ...prec, ...s }))
        // Se l'intestatario e' gia' stato dichiarato, la sezione fattura si
        // apre gia': altrimenti sembrerebbe che il dato sia sparito.
        if (s.intestatario && s.piva) setFatturaAltri(true)

        const schede = (pr.ospiti ?? []).map((x: Record<string, string>) => ospiteDaColonne(x))
        const attesi = Number(s.ospitiAttesi || 0)

        if (pr.mioProgressivo) {
          // Il link di un singolo ospite: una scheda sola, la sua.
          const mia = schede.find((sc: FormOspite) => Number(sc.progressivo) === pr.mioProgressivo)
          setOspiti([mia ? daForm(mia) : { ...OSPITE_VUOTO }])
        } else {
          // Tante schede quanti gli ospiti prenotati: chi compila vede subito
          // quante ne mancano, invece di doverle aggiungere una a una.
          const complete = [...schede.map(daForm)]
          while (complete.length < Math.max(attesi, 1)) complete.push({ ...OSPITE_VUOTO })
          setOspiti(complete)
        }

        setCaricato(true)
      })
      .catch(() => setErroreAvvio('Non riesco a caricare i dati della prenotazione.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, p, t, o])

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

  /**
   * A chi va la fattura, per come stanno le cose adesso: l'azienda se e' stata
   * dichiarata, altrimenti il primo ospite. Serve a scrivere il nome accanto
   * all'indirizzo, perche' "l'indirizzo" in un modulo con tre persone dentro
   * non dice di chi.
   */
  const destinatarioFattura = fatturaAltri
    ? sog.intestatario.trim().toUpperCase()
    : intestatarioDedotto

  const cambiaOspite = (i: number, campo: keyof Ospite, valore: string | boolean) =>
    setOspiti((prev) => prev.map((o, j) => (j === i ? { ...o, [campo]: valore } : o)))

  /**
   * Carica una foto del documento.
   *
   * Prima la riduce sul telefono, poi la manda. Ogni ospite carica solo per la
   * propria scheda — e il controllo vero e' sul server, non qui.
   */
  async function caricaDocumento(progressivo: number, lato: 'fronte' | 'retro', file: File) {
    setDocInvio(`${progressivo}-${lato}`)
    try {
      const ridotta = await riduciImmagine(file)
      const res = await fetch(
        `/api/checkin/documento?${q}&prog=${progressivo}&lato=${lato}`,
        {
          method: 'POST',
          headers: { 'Content-Type': ridotta.type || 'image/jpeg' },
          body: ridotta,
        },
      )
      const d = await res.json()
      if (!d.ok) {
        setEsito({ tipo: 'ko', testo: [d.errore ?? 'Foto non caricata.'] })
        window.scrollTo(0, 0)
        return
      }
      setDocCaricati((prec) => ({ ...prec, [`${progressivo}-${lato}`]: true }))
    } catch {
      setEsito({ tipo: 'ko', testo: ['Non sono riuscito a mandare la foto. Riprova.'] })
    } finally {
      setDocInvio('')
    }
  }

  /**
   * Quando il codice fiscale e' valido, i dati che contiene si compilano da
   * soli: sesso, data e luogo di nascita sono scritti dentro il codice.
   *
   * Richiederli a chi il codice lo ha appena scritto vuol dire fargli riempire
   * quattro caselle che il sistema conosce gia' — e ogni casella in piu' e'
   * un'occasione di scriverle diverse dal codice, cioe' di creare una
   * discordanza che poi qualcuno dovra' risolvere.
   *
   * Restano modificabili: se l'ospite corregge, la sua correzione vince.
   */
  async function riempiDalCf(i: number, cf: string) {
    const d = decodificaCf(cf, new Date().getFullYear())
    if (!d) return

    setOspiti((prev) => prev.map((o, j) => (
      j === i ? { ...o, sesso: d.sesso, dataNascita: d.dataNascita } : o
    )))

    if (d.estero) return // il luogo estero non sta nel nostro elenco comuni

    try {
      const res = await fetch(`/api/checkin/comuni?${q}&catastale=${encodeURIComponent(d.catastale)}`)
      const j = await res.json()
      const c = j.comuni?.[0]
      if (!c) return
      setOspiti((prev) => prev.map((os, idx) => (
        idx === i ? { ...os, comuneNascita: c.n, provNascita: c.p } : os
      )))
    } catch {
      // Se la ricerca non riesce, i campi restano da compilare a mano: nessun
      // danno, solo un aiuto in meno.
    }
  }

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

  /** Salva su una prenotazione gia' aperta. */
  async function salvaPratica() {
    const res = await fetch(`/api/checkin/pratica?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Un ospite non intestatario non manda NIENTE del soggiorno: quello che
        // non si puo' cambiare non si invia nemmeno.
        soggiorno: mioProgressivo
          ? {}
          : {
            ...soggiornoAColonne(sog),
            // Quante persone si presentano DAVVERO. E' il numero di schede
            // aperte: toglierne una o aggiungerne una e' il gesto esplicito.
            // Lasciarne una in bianco invece non conta, e continua a bloccare —
            // altrimenti un ospite sparirebbe per distrazione, e con lui la sua
            // imposta e la sua riga per la Questura.
            'Ospiti dichiarati': String(ospiti.length),
          },
        ospiti: ospiti.map((os, i) =>
          ospiteAColonne({
            ...os,
            progressivo: String(mioProgressivo ?? i + 1),
          }),
        ),
      }),
    })
    const d = await res.json()
    if (!d.ok) {
      setEsito({ tipo: 'ko', testo: [d.errore ?? 'Non salvato.'] })
      return
    }

    setStatoPratica(d.stato)
    setMancanze(d.mancanze ?? [])
    setEsito({
      tipo: d.stato === 'CHECKIN OK' ? 'ok' : 'ko',
      testo: d.stato === 'CHECKIN OK'
        ? ['Check-in completo. / Check-in complete.', 'Non serve altro: ci vediamo all’arrivo.']
        : ['Salvato. Manca ancora: / Saved. Still missing:', ...(d.mancanze ?? [])],
    })
    window.scrollTo(0, 0)
  }

  async function invia() {
    setInvio(true)
    setEsito(null)
    try {
      if (inPratica) {
        await salvaPratica()
        return
      }

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
        {/*
          Il logo e' bordeaux su fondo bianco (il file si chiama "Bianco" per il
          FONDO, non per il tratto). Su un'intestazione blu ci finirebbe dentro
          un rettangolo bianco e il colore stonerebbe: percio' la fascia del
          logo e' bianca, e il blu resta il colore di tutto il resto.
          Se il logo non si carica, l'intestazione regge lo stesso.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/api/checkin/logo" alt="LA Real Estate srls" className="logo" />
        <div className="titolo">
          <h1>Registrazione check-in</h1>
          <p>Dati per Questura, imposta di soggiorno e fattura</p>
          <p className="en-header">Guest registration — required by law for police records, tourist tax and invoicing</p>
        </div>
      </header>

      <div className="wrap">
        {esito && (
          <div className={`esito ${esito.tipo}`}>
            {esito.testo.map((t, i) => <div key={i}>{t}</div>)}
          </div>
        )}

        {statoPratica && (
          <div className={`stato ${statoPratica === 'CHECKIN OK' ? 'ok' : ''}`}>
            {statoPratica === 'CHECKIN OK'
              ? 'Check-in completo / Check-in complete'
              : 'Check-in da completare / Check-in incomplete'}
            {mancanze.length > 0 && (
              <ul>{mancanze.map((m, i) => <li key={i}>{m}</li>)}</ul>
            )}
          </div>
        )}

        {/*
          In una prenotazione gia' aperta l'ospite non modifica il soggiorno: lo
          RICONOSCE. Un riepilogo in sola lettura, senza l'importo — che e' un
          dato commerciale fra l'Ingegnere e il portale e non riguarda chi
          dorme in casa.
        */}
        {inPratica && soloLettura && (
          <section className="riepilogo">
            <h2>La tua prenotazione / Your booking</h2>
            <dl>
              <div><dt>Alloggio / Property</dt><dd>{sog.unita || '—'}</dd></div>
              <div><dt>Arrivo / Arrival</dt><dd>{dataIT(sog.checkin)}</dd></div>
              <div><dt>Partenza / Departure</dt><dd>{dataIT(sog.checkout)}</dd></div>
              <div><dt>Ospiti / Guests</dt><dd>{sog.ospitiAttesi || '—'}</dd></div>
              {sog.codPrenotazione && (
                <div><dt>Prenotazione / Booking ref.</dt><dd>{sog.codPrenotazione}</dd></div>
              )}
            </dl>
            {anteprima && anteprima.importo > 0 && (
              <div className="calcolo">
                Imposta di soggiorno € {anteprima.importo.toFixed(2)} — da pagare in struttura al check-in
                <span className="en-inline">Tourist tax — to be paid at the property on arrival</span>
              </div>
            )}
          </section>
        )}

        {!soloLettura && (
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
        )}

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

                {/*
                  Il link della SUA scheda, da girare a chi non e' presente.
                  Senza questo, chi compila non aveva modo di mandare agli altri
                  la loro parte: il flusso restava a meta', e l'intestatario si
                  ritrovava a dover chiedere i dati a voce e scriverli lui.
                */}
                {!mioProgressivo && linkOspiti[i]?.link && (
                  <a
                    className="manda"
                    href={`https://wa.me/?text=${encodeURIComponent(
                      `Ciao, completa qui la tua parte del check-in: ${linkOspiti[i].link}`,
                    )}`}
                    target="_blank" rel="noreferrer"
                  >
                    Compila lui? Mandagli il suo link
                    <span className="en">Not with you? Send this guest their own link</span>
                  </a>
                )}

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
                    <CercaComune
                      accesso={q} valore={o.comuneNascita} placeholder="scrivi le prime lettere…"
                      onScegli={(c) => {
                        cambiaOspite(i, 'comuneNascita', c.n)
                        cambiaOspite(i, 'provNascita', c.p)
                      }}
                    />
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

                <Eti it="Codice fiscale (obbligatorio per i cittadini italiani)" en="Italian tax code (only if you have one)" />
                <input
                  className={`maiusc cf ${cf.classe}`} maxLength={16}
                  value={o.codiceFiscale}
                  onChange={(e) => {
                    const v = e.target.value.toUpperCase()
                    cambiaOspite(i, 'codiceFiscale', v)
                    // Appena il codice e' completo, si legge quello che contiene.
                    if (v.length === 16) void riempiDalCf(i, v)
                  }}
                />
                {cf.messaggio && <div className={`verifica ${cf.classe}`}>{cf.messaggio}</div>}

                {inPratica && (
                  <div className="documenti">
                    <div className="titolo-doc">
                      Documento d'identità / Your ID document
                      <span className="en">Fronte e retro — foto o PDF · front and back, photo or PDF</span>
                    </div>
                    {(['fronte', 'retro'] as const).map((lato) => {
                      const prog = mioProgressivo ?? i + 1
                      const chiave = `${prog}-${lato}`
                      const fatto = docCaricati[chiave]
                      const inCorso = docInvio === chiave
                      return (
                        <label className={`doc ${fatto ? 'fatto' : ''}`} key={lato}>
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            /*
                              Niente `capture`: con quello il telefono apre
                              DIRETTAMENTE la fotocamera e non offre la galleria.
                              Ma l'ospite le foto del documento spesso ce le ha
                              gia' salvate — obbligarlo a rifarle e' una
                              scortesia inutile. Senza, compare la scelta
                              normale: fotocamera, galleria o file.
                            */
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              if (f) void caricaDocumento(prog, lato, f)
                              e.target.value = ''
                            }}
                          />
                          {inCorso ? 'Invio…' : fatto ? `✓ ${lato} caricato` : `Carica ${lato}`}
                        </label>
                      )
                    })}
                    <div className="hint">
                      Servono a registrare i dati e si cancellano da sole dopo il soggiorno.
                      <span className="en">Used to record your details, then deleted automatically after your stay.</span>
                    </div>

                    {/*
                      Gli estremi del documento stanno DOPO le foto, non prima.
                      Quando la lettura automatica sara' attiva, chi carica una
                      foto leggibile trovera' questi campi gia' pieni e non
                      dovra' toccarli: chiederli prima vorrebbe dire far
                      scrivere a mano qualcosa che stava per arrivare da solo.
                    */}
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
                  </div>
                )}

                {/*
                  Fuori dalla modalita' prenotazione le foto non ci sono, ma i
                  dati del documento servono lo stesso: alla ragazza che
                  registra un check-in al volo.
                */}
                {!inPratica && (
                  <>
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
                  </>
                )}
                {/*
                  La casella la vede solo chi gestisce. Il regolamento ha nove casi
                  di esenzione: quello dei minori si calcola dalla data di nascita, gli
                  altri otto (disabili, residenti, accompagnatori di degenti...) un
                  ospite non li riconosce, e l art. 3 c.4 obbliga comunque a
                  conservarne la dichiarazione scritta.
                */}
                {!soloLettura && (
                  <>
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
                  </>
                )}
              </div>
            )
          })}
          {!mioProgressivo && (
          <button className="btn btn-sec" onClick={() => setOspiti([...ospiti, { ...OSPITE_VUOTO }])}>
            + Aggiungi ospite / Add guest
          </button>
          )}
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
            Fattura a societa, ditta individuale o altra persona / Invoice to a company or someone else
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

          {/*
            L'etichetta porta il nome di chi verra' fatturato. Chiedere
            "l'indirizzo" e basta, in un modulo dove si sono appena scritte tre
            persone, lascia il dubbio su quale dei tre — e il dubbio si risolve
            scrivendo l'indirizzo sbagliato.
          */}
          <Eti
            it={destinatarioFattura ? `Indirizzo di residenza di ${destinatarioFattura} *` : 'Indirizzo di residenza *'}
            en={destinatarioFattura ? `Home address of ${destinatarioFattura} *` : 'Home address *'}
          />
          <input value={sog.indirizzo} onChange={(e) => setSog({ ...sog, indirizzo: e.target.value })} />

          <Eti it="Comune di residenza *" en="Town of residence *" />
          <CercaComune
            accesso={q} valore={sog.citta} placeholder="scrivi le prime lettere…"
            onScegli={(c) => setSog((s) => ({
              ...s,
              citta: c.n,
              provincia: c.p,
              // Il CAP arriva solo se il comune ne ha uno. Le citta' grandi ne
              // hanno decine: scriverne uno a caso sarebbe un indirizzo
              // sbagliato dall'aria giusta.
              cap: c.cap || s.cap,
            }))}
          />

          <div className="row">
            <div><Eti it="CAP *" en="Postcode *" /><input value={sog.cap} onChange={(e) => setSog({ ...sog, cap: e.target.value })} /></div>
            <div style={{ maxWidth: 90 }}><Eti it="Prov." en="Prov." /><input className="maiusc" maxLength={2} value={sog.provincia} onChange={(e) => setSog({ ...sog, provincia: e.target.value })} /></div>
          </div>
          {sog.citta && !sog.cap && (
            <div className="hint" style={{ color: '#8a6100' }}>
              Questo comune ha più CAP: scrivilo tu.
              <span className="en">This town has several postcodes — please type it.</span>
            </div>
          )}

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
        {/*
          L'imposta si vede PRIMA di confermare e resta visibile dopo. E' una
          somma che l'ospite paga in contanti all'arrivo: scoprirla sulla porta
          di casa e' il modo migliore per litigarci sopra.
        */}
        {anteprima && anteprima.notti > 0 && (
          <div className="tassa">
            <div className="cifra">€ {anteprima.importo.toFixed(2)}</div>
            <div className="conto">
              <b>Imposta di soggiorno — da pagare in struttura al check-in</b>
              <span className="dettaglio">
                {anteprima.pernottamentiTassati} pernottamenti tassabili
                {anteprima.esenti.length > 0 && `, ${anteprima.esenti.length} esente/i`}
              </span>
              <span className="en">
                Tourist tax — to be paid at the property on arrival
                <br />{anteprima.notti} nights, {ospiti.length} guests
              </span>
            </div>
          </div>
        )}

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
  header{background:#fff;border-bottom:3px solid var(--blu);padding:14px 18px 12px;
    position:sticky;top:0;z-index:10;box-shadow:0 1px 6px rgba(31,56,100,.08)}
  header .logo{display:block;height:38px;width:auto;max-width:100%;margin:0 0 10px}
  header .titolo h1{margin:0;font-size:16px;font-weight:600;color:var(--blu)}
  header .titolo p{margin:2px 0 0;font-size:11.5px;color:#6b7280;line-height:1.35}
  header .titolo p.en-header{color:#9aa3b2;font-style:italic}
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
  .manda{display:block;text-align:center;margin:8px 0 4px;padding:9px;border-radius:7px;
    border:1px dashed var(--blu);color:var(--blu);font-size:12.5px;font-weight:600;
    text-decoration:none;background:#fff}
  .manda .en{display:block;font-weight:400;font-size:10.5px;color:#8a94a6;font-style:italic}
  .documenti{margin-top:14px;padding-top:12px;border-top:1px dashed var(--bordo)}
  .titolo-doc{font-size:12px;font-weight:600;color:#4a5568;margin-bottom:8px}
  .titolo-doc .en{display:block;font-weight:400;font-size:11px;color:#8a94a6;font-style:italic}
  .doc{display:block;text-align:center;padding:12px;margin-bottom:8px;border-radius:8px;
    border:1.5px dashed var(--blu);color:var(--blu);font-size:14px;font-weight:600;cursor:pointer;
    background:#fff;text-transform:capitalize}
  .doc input{display:none}
  .doc.fatto{border-style:solid;border-color:var(--ok);color:var(--ok);background:#f2faf6}
  .tassa{display:flex;align-items:center;gap:12px;background:#eef2f9;border:1px solid var(--bordo);
    border-radius:8px;padding:10px 12px;margin-bottom:10px}
  .tassa .cifra{font-size:22px;font-weight:700;color:var(--blu);white-space:nowrap}
  .tassa .conto{font-size:12px;color:#2b3a55;line-height:1.45}
  .tassa .dettaglio{display:block;font-size:11px;color:#6b7280;margin-top:2px}
  .tassa .en{display:block;font-style:italic;color:#8a94a6}
  .stato{padding:12px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;line-height:1.5;
    background:#fff6e5;border:1px solid #e0c48a;color:#6b4e00;font-weight:600}
  .stato.ok{background:#e7f5ee;border-color:var(--ok);color:#0b5c3b}
  .stato ul{margin:6px 0 0;padding-left:18px;font-weight:400}
  .stato li{margin:2px 0}
  .riepilogo dl{margin:0}
  .riepilogo dl>div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;
    border-bottom:1px solid #eef1f6}
  .riepilogo dl>div:last-child{border-bottom:none}
  .riepilogo dt{font-size:11.5px;color:#6b7280;margin:0}
  .riepilogo dd{margin:0;font-size:15px;font-weight:600;color:var(--blu);text-align:right}
  .en-inline{display:block;font-size:11px;font-style:italic;color:#8a94a6;font-weight:400}
  .cerca{position:relative}
  .elenco{position:absolute;z-index:20;left:0;right:0;top:100%;margin:2px 0 0;padding:0;list-style:none;
    background:#fff;border:1px solid var(--blu);border-radius:8px;max-height:240px;overflow-y:auto;
    box-shadow:0 6px 18px rgba(31,56,100,.18)}
  .elenco li{padding:11px 12px;font-size:15px;cursor:pointer;display:flex;justify-content:space-between;
    align-items:center;gap:8px;border-bottom:1px solid #eef1f6}
  .elenco li:last-child{border-bottom:none}
  .elenco li:active{background:#eef2f9}
  .elenco .cap{font-size:11px;color:#6b7280;font-family:ui-monospace,Menlo,monospace}
  .elenco .cap.multi{color:#8a6100;font-family:inherit;font-style:italic}
  .calcolo{margin-top:10px;font-size:12px;color:var(--blu);font-weight:600;line-height:1.5}
  .calcolo .esenti{font-weight:400;color:#6b7280}
  .blocco{font-size:11px;color:var(--err);margin-top:8px;line-height:1.4;text-align:center}
  .blocco .en{display:block;font-style:italic;opacity:.8}
`

/**
 * Informativa privacy per gli ospiti — art. 13 GDPR.
 *
 * ── Perche' esiste (6 settembre 2026) ────────────────────────────────────────
 * Un audit ha cercato in tutto il progetto le parole "informativa", "GDPR",
 * "titolare del trattamento", "art. 13": ZERO occorrenze. Il form raccoglie
 * documenti d'identita' — anche di minori — e l'unica cosa che l'ospite leggeva
 * era una riga: "Dati per Questura, imposta di soggiorno e fattura".
 *
 * Senza questa pagina la raccolta e' indifendibile, per quanto bene sia
 * costruito il resto: le difese tecniche (foto ridotte sul telefono, Drive mai
 * condiviso, cancellazione automatica) sono promesse che nessuno aveva scritto.
 *
 * E' PUBBLICA, senza token: un'informativa che si legge solo avendo il link
 * della propria prenotazione non e' un'informativa.
 *
 * ⚠️ Testo redatto con cura ma NON validato da un legale. Va fatto rivedere
 * prima di raccogliere i dati di ospiti veri: qui si dichiarano tempi,
 * destinatari e basi giuridiche, e una dichiarazione sbagliata e' peggio del
 * silenzio.
 */

export const metadata = {
  title: 'Informativa privacy — LA REAL ESTATE S.R.L.S.',
}

const AGGIORNAMENTO = '6 settembre 2026'

export default function InformativaPrivacy() {
  return (
    <main className="pagina">
      <style>{`
        .pagina { max-width: 760px; margin: 0 auto; padding: 24px 18px 64px;
          font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
        .logo { height: 46px; width: auto; display: block; margin: 0 0 18px; }
        h1 { font-size: 1.5rem; margin: 0 0 4px; }
        h2 { font-size: 1.1rem; margin: 28px 0 8px; color: #123a6b; }
        .data { color: #666; font-size: .9rem; margin-bottom: 24px; }
        .en { color: #444; font-style: italic; font-size: .95rem; }
        table { border-collapse: collapse; width: 100%; margin: 8px 0 4px; font-size: .95rem; }
        th, td { border: 1px solid #d8d8d8; padding: 8px 10px; text-align: left; vertical-align: top; }
        th { background: #f3f6fa; font-weight: 600; }
        .nota { background: #fff8e6; border-left: 4px solid #e0a800; padding: 12px 14px; margin: 20px 0; }
        a { color: #123a6b; }
        @media (max-width: 600px) { table, thead, tbody, th, td, tr { display: block; }
          th { display: none; } td { border: none; border-bottom: 1px solid #eee; }
          td::before { content: attr(data-l); display: block; font-weight: 600; color: #123a6b; font-size: .85rem; } }
      `}</style>

      {/*
        Il marchio anche qui. Vista a schermo il 6 set 2026, la pagina sembrava
        staccata dal resto: un'informativa senza intestazione somiglia a un
        documento capitato per caso, e chi sta per consegnare la carta
        d'identita' deve riconoscere subito CHI gliela sta chiedendo.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/api/checkin/logo" alt="LA Real Estate srls" className="logo" />

      <h1>Informativa sul trattamento dei dati personali</h1>
      <p className="en">Privacy notice — how we handle your personal data</p>
      <p className="data">Ai sensi dell&apos;art. 13 del Regolamento (UE) 2016/679 · Aggiornata al {AGGIORNAMENTO}</p>

      <h2>1. Chi tratta i suoi dati</h2>
      <p>
        <strong>LA REAL ESTATE S.R.L.S.</strong> — Via Civita 8, 85046 Maratea (PZ), Italia.
        C.F. e P.IVA 02232730768.
      </p>
      <p>
        Per qualsiasi domanda su questa informativa o per esercitare i suoi diritti:{' '}
        <a href="mailto:larealestate.amministrazione@gmail.com">larealestate.amministrazione@gmail.com</a>.
      </p>
      <p className="en">
        Data controller: LA REAL ESTATE S.R.L.S., Via Civita 8, 85046 Maratea (PZ), Italy.
      </p>

      <h2>2. Quali dati raccogliamo</h2>
      <p>
        Nome e cognome, data e luogo di nascita, cittadinanza, sesso, codice fiscale (per i cittadini
        italiani), estremi del documento d&apos;identità (tipo, numero, luogo di rilascio) e la
        <strong> fotografia del documento</strong>. Per chi intesta la prenotazione, anche indirizzo,
        email, telefono e — se richiesta la fattura — i dati di fatturazione.
      </p>
      <p className="en">
        We collect: full name, date and place of birth, citizenship, sex, tax code (Italian citizens),
        identity document details and a <strong>photo of the document</strong>.
      </p>

      <h2>3. Perché li trattiamo, e su quale base</h2>
      <table>
        <thead>
          <tr><th>Finalità</th><th>Base giuridica</th></tr>
        </thead>
        <tbody>
          <tr>
            <td data-l="Finalità">Comunicazione degli alloggiati all&apos;autorità di pubblica sicurezza, entro 24 ore dall&apos;arrivo</td>
            <td data-l="Base giuridica">Obbligo di legge — art. 109 T.U.L.P.S. (art. 6.1.c GDPR)</td>
          </tr>
          <tr>
            <td data-l="Finalità">Calcolo, riscossione e dichiarazione dell&apos;imposta di soggiorno al Comune di Maratea</td>
            <td data-l="Base giuridica">Obbligo di legge — regolamento comunale (art. 6.1.c GDPR)</td>
          </tr>
          <tr>
            <td data-l="Finalità">Emissione della fattura o del documento fiscale e relativa conservazione</td>
            <td data-l="Base giuridica">Obbligo di legge fiscale (art. 6.1.c GDPR)</td>
          </tr>
          <tr>
            <td data-l="Finalità">Gestione del soggiorno: consegna delle chiavi, comunicazioni pratiche</td>
            <td data-l="Base giuridica">Esecuzione del contratto (art. 6.1.b GDPR)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Il conferimento è <strong>obbligatorio</strong>: senza questi dati non possiamo ospitarla,
        perché non potremmo adempiere agli obblighi di legge sopra indicati.
      </p>

      <h2>4. A chi li comunichiamo</h2>
      <ul>
        <li><strong>Questura</strong>, tramite il Portale Alloggiati del Ministero dell&apos;Interno.</li>
        <li><strong>Comune di Maratea</strong>, per la dichiarazione dell&apos;imposta di soggiorno (dati aggregati, non nominativi, salvo controlli).</li>
        <li><strong>Il nostro consulente fiscale</strong>, per gli adempimenti contabili.</li>
        <li>
          <strong>Fornitori tecnologici</strong> che ospitano il servizio, nominati responsabili del
          trattamento: Google Ireland Ltd (archiviazione dei dati e delle immagini), Vercel Inc.
          (hosting dell&apos;applicazione), Anthropic (assistente digitale che ci aiuta nella gestione
          amministrativa). Alcuni di questi fornitori possono trattare dati al di fuori dell&apos;Unione
          Europea, sulla base delle clausole contrattuali standard approvate dalla Commissione.
        </li>
      </ul>
      <p>I suoi dati <strong>non sono venduti né ceduti</strong> a terzi per finalità commerciali.</p>

      <h2>5. Per quanto tempo li conserviamo</h2>
      <table>
        <thead><tr><th>Dato</th><th>Conservazione</th></tr></thead>
        <tbody>
          <tr>
            <td data-l="Dato"><strong>Fotografia del documento d&apos;identità</strong></td>
            <td data-l="Conservazione">Cancellata automaticamente pochi giorni dopo la partenza. Serve solo a compilare correttamente la comunicazione alla Questura: assolto quell&apos;obbligo, non ha più motivo di esistere.</td>
          </tr>
          <tr>
            <td data-l="Dato">Dati anagrafici comunicati alla Questura</td>
            <td data-l="Conservazione">Per il tempo richiesto dalla normativa di pubblica sicurezza.</td>
          </tr>
          <tr>
            <td data-l="Dato">Dati di fatturazione e contabili</td>
            <td data-l="Conservazione">Dieci anni, come impone la legge fiscale.</td>
          </tr>
        </tbody>
      </table>

      <h2>6. Minori</h2>
      <p>
        Se soggiornano minori, i loro dati sono trattati per le stesse finalità di legge e sono forniti
        da chi esercita la responsabilità genitoriale. Per i minori fino a 12 anni compiuti l&apos;imposta
        di soggiorno non è dovuta: la data di nascita serve anche a riconoscere l&apos;esenzione.
      </p>

      <h2>7. I suoi diritti</h2>
      <p>
        Può chiederci in ogni momento l&apos;<strong>accesso</strong> ai suoi dati, la loro{' '}
        <strong>rettifica</strong>, la <strong>cancellazione</strong>, la{' '}
        <strong>limitazione</strong> del trattamento, e può <strong>opporsi</strong> al trattamento.
        Alcuni di questi diritti incontrano un limite: finché la legge ci impone di conservare un dato
        (comunicazione alla Questura, obblighi fiscali) non possiamo cancellarlo.
      </p>
      <p>
        Scriva a{' '}
        <a href="mailto:larealestate.amministrazione@gmail.com">larealestate.amministrazione@gmail.com</a>.
        Se ritiene che i suoi dati non siano trattati correttamente, può proporre reclamo al{' '}
        <a href="https://www.garanteprivacy.it" target="_blank" rel="noreferrer noopener">
          Garante per la protezione dei dati personali
        </a>.
      </p>
      <p className="en">
        You may request access, rectification, erasure or restriction of your data, and lodge a
        complaint with the Italian Data Protection Authority. Some data must be kept as long as the
        law requires (police reporting, tax obligations).
      </p>

      <h2>8. Come proteggiamo la fotografia del documento</h2>
      <p>
        L&apos;immagine viene <strong>ridotta sul suo telefono</strong> prima di partire, quindi non
        trasmettiamo l&apos;originale né i dati di posizione che spesso contiene. È conservata in una
        cartella privata, non è mai pubblicata né condivisa con un collegamento, e viene cancellata
        automaticamente dopo la partenza.
      </p>

      <div className="nota">
        Questa informativa descrive il funzionamento reale del sistema al {AGGIORNAMENTO}. Se cambia
        il modo in cui trattiamo i dati, cambia anche questa pagina.
      </div>
    </main>
  )
}

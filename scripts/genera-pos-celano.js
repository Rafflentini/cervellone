/* Genera POS Restruktura — cantiere Celano Lotto 2-D0 (massetti). Output .docx editabile.
   Dati reali da DVR REV.04 + anagrafica + visura. Campi mancanti evidenziati in giallo. */
const fs = require('fs')
const path = require('path')
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  PageBreak, Header, Footer, PageNumber, LevelFormat,
} = require('docx')

const RED = 'C8102E'
const GREY = '666666'
const HEAD_FILL = 'C8102E'

// ── helpers ──
const H1 = (t, opts = {}) => new Paragraph({
  heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 },
  pageBreakBefore: opts.brk === true,
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RED, space: 4 } },
  children: [new TextRun({ text: t, bold: true, color: RED, size: 26 })],
})
const H2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 },
  children: [new TextRun({ text: t, bold: true, color: '1A1A1A', size: 24 })],
})
const P = (t, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 100 }, alignment: opts.align || AlignmentType.JUSTIFIED,
  children: Array.isArray(t) ? t : [new TextRun({ text: t, size: 20 })],
})
const B = (label, val) => new Paragraph({
  spacing: { after: 60 }, bullet: { level: 0 },
  children: [new TextRun({ text: label + ': ', bold: true, size: 20 }), new TextRun({ text: val, size: 20 })],
})
const FILL = (t) => new TextRun({ text: t, size: 20, highlight: 'yellow' }) // campo da completare
const TODO = (t) => new Paragraph({ spacing: { after: 60 }, children: [FILL(t)] })

function cell(text, { bold = false, fill = null, color = '1A1A1A', size = 18, w } = {}) {
  const runs = Array.isArray(text) ? text : [new TextRun({ text: String(text), bold, color, size })]
  return new TableCell({
    width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
    shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: runs })],
  })
}
function headerRow(cells, widths) {
  return new TableRow({ tableHeader: true, children: cells.map((c, i) =>
    cell(c, { bold: true, fill: HEAD_FILL, color: 'FFFFFF', size: 18, w: widths && widths[i] })) })
}
function table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].reduce((a, k) => {
      a[k] = { style: BorderStyle.SINGLE, size: 4, color: '999999' }; return a }, {}),
    rows,
  })
}
// matrice P x D
const Rcolor = (r) => r >= 12 ? 'E74C3C' : r >= 8 ? 'E67E22' : r >= 4 ? 'F1C40F' : '2ECC71'
function riskTable(rischi) {
  const rows = [headerRow(['Fattore di rischio', 'P', 'D', 'R', 'Misure di prevenzione e protezione', 'DPI'], [22, 5, 5, 5, 41, 22])]
  for (const x of rischi) {
    const r = x.P * x.D
    rows.push(new TableRow({ children: [
      cell(x.rischio, { size: 17, bold: true }),
      cell(String(x.P), { size: 17 }), cell(String(x.D), { size: 17 }),
      cell(String(r), { size: 17, bold: true, fill: Rcolor(r), color: 'FFFFFF' }),
      cell(x.misure, { size: 16 }), cell(x.dpi, { size: 16 }),
    ] }))
  }
  return table(rows)
}

// ── DATI REALI ──
const fasi = [
  { nome: 'Fase 1 — Allestimento area e approvvigionamento materiali',
    descr: 'Ricezione e stoccaggio di leganti (cemento/premiscelato), inerti, additivi, rete elettrosaldata e materiali isolanti; movimentazione dall’area di scarico al piano di lavoro con mezzi meccanici e/o manuale.',
    rischi: [
      { rischio: 'Investimento da automezzi/autobetoniera in manovra', P: 2, D: 4, misure: 'Delimitazione area di scarico; viabilità separata pedoni/mezzi; moviere a terra durante le manovre; divieto di sosta nel raggio d’azione.', dpi: 'Indumenti alta visibilità, elmetto, scarpe S3' },
      { rischio: 'Movimentazione manuale dei carichi (sacchi 25/40 kg)', P: 3, D: 2, misure: 'Uso di transpallet/carriole/montacarichi; frazionamento dei carichi; formazione MMC; limiti di sollevamento (rif. ISO 11228 / TR 11.6.81).', dpi: 'Guanti antiabrasione, scarpe S3, fascia lombare se necessaria' },
      { rischio: 'Schiacciamento/caduta materiali da cataste o forche', P: 2, D: 3, misure: 'Stoccaggio stabile e su superfici piane; altezza cataste limitata; imbracatura corretta dei carichi sollevati.', dpi: 'Elmetto, scarpe S3, guanti' },
      { rischio: 'Polveri da cemento durante travaso/scarico', P: 3, D: 2, misure: 'Apertura sacchi con cautela; movimentazione che riduca la dispersione; aree ventilate; silos con filtri ove presenti.', dpi: 'Mascherina FFP2/FFP3, occhiali, guanti' },
    ] },
  { nome: 'Fase 2 — Preparazione del fondo e posa di isolante/rete',
    descr: 'Pulizia del sottofondo, posa di barriera al vapore/materassino isolante, posa di rete elettrosaldata o fibre, posa guide/livelli di staggia. Lavoro prevalentemente a terra, in posizione china/in ginocchio.',
    rischi: [
      { rischio: 'Posture incongrue e sovraccarico biomeccanico (lavoro a terra)', P: 3, D: 2, misure: 'Rotazione delle mansioni; pause; uso di ginocchiere e attrezzi a manico lungo; organizzazione ergonomica del posto di lavoro.', dpi: 'Ginocchiere, guanti, scarpe S3' },
      { rischio: 'Tagli/abrasioni da rete elettrosaldata e cesoie', P: 3, D: 2, misure: 'Manipolazione con guanti antitaglio; protezione delle estremità sporgenti della rete; attrezzi idonei e manutenuti.', dpi: 'Guanti antitaglio liv. C, occhiali' },
      { rischio: 'Scivolamenti, inciampi e cadute in piano', P: 3, D: 2, misure: 'Ordine e pulizia (housekeeping); percorsi liberi; rimozione sfridi; illuminazione adeguata.', dpi: 'Scarpe S3 antiscivolo' },
      { rischio: 'Cadute dall’alto in presenza di aperture/vani/bordi solaio', P: 2, D: 4, misure: 'Protezione di tutte le aperture con parapetti/coperture resistenti (a cura del PSC/affidataria); verifica prima dell’inizio; segnalazione.', dpi: 'Imbracatura e cordino se non eliminabile il rischio di caduta' },
    ] },
  { nome: 'Fase 3 — Confezionamento dell’impasto',
    descr: 'Produzione del massetto con betoniera/impastatrice o premiscelato pompabile da silos/autopompa. Uso di leganti, acqua e additivi.',
    rischi: [
      { rischio: 'Rischio chimico e dermatologico da contatto con cemento (ustioni alcaline, dermatiti)', P: 3, D: 3, misure: 'Evitare contatto cute/cemento umido; lavaggio immediato in caso di contatto; consultazione SDS; disponibilità di acqua pulita; rispetto del contenuto di cromo VI (Reg. REACH).', dpi: 'Guanti impermeabili nitrile/neoprene, occhiali, tuta a maniche lunghe, stivali' },
      { rischio: 'Esposizione a rumore (betoniera/pompa)', P: 3, D: 2, misure: 'Valutazione rumore (Capo II Titolo VIII D.Lgs 81/08); manutenzione macchine; riduzione tempi di esposizione; segnalazione aree >85 dB(A).', dpi: 'Otoprotettori (inserti/cuffie)' },
      { rischio: 'Contatto con organi in movimento dell’impastatrice', P: 2, D: 4, misure: 'Protezioni fisse/mobili integre; divieto di interventi a macchina in moto; arresto e messa in sicurezza per pulizia.', dpi: 'Guanti, indumenti aderenti (no parti svolazzanti)' },
      { rischio: 'Rischio elettrico da utensili e quadri di cantiere', P: 2, D: 3, misure: 'Quadri ASC con differenziali; cavi integri e sollevati da terra; collegamenti a norma; verifica periodica; divieto d’uso in presenza d’acqua senza idoneità.', dpi: 'Guanti, calzature isolanti S3' },
    ] },
  { nome: 'Fase 4 — Getto, stesura e staggiatura del massetto',
    descr: 'Versamento dell’impasto, distribuzione, livellamento con staggia (anche vibrante) sui riferimenti di quota. Possibile pompaggio.',
    rischi: [
      { rischio: 'Vibrazioni mano-braccio (staggia vibrante)', P: 3, D: 2, misure: 'Valutazione vibrazioni (Capo III Titolo VIII); attrezzi a basse vibrazioni; rotazione; limitazione tempi; manutenzione.', dpi: 'Guanti antivibranti' },
      { rischio: 'Proiezione di materiale e schizzi negli occhi', P: 3, D: 2, misure: 'Tecnica di getto corretta; distanza di sicurezza; protezione del viso.', dpi: 'Occhiali/visiera, guanti' },
      { rischio: 'Colpo di frusta/movimento incontrollato del tubo di pompaggio', P: 2, D: 3, misure: 'Personale addestrato all’uso della pompa; presa salda; comunicazione operatore-pompista; tubazioni in efficienza.', dpi: 'Elmetto, guanti, scarpe S3' },
      { rischio: 'Posture incongrue prolungate e MMC', P: 3, D: 2, misure: 'Organizzazione del lavoro; pause; alternanza operatori; attrezzi a manico lungo.', dpi: 'Ginocchiere, guanti' },
      { rischio: 'Scivolamento su superfici bagnate/fresche', P: 3, D: 2, misure: 'Percorsi definiti; segnalazione superfici fresche; pulizia immediata sversamenti.', dpi: 'Scarpe S3 antiscivolo' },
    ] },
  { nome: 'Fase 5 — Finitura superficiale e maturazione',
    descr: 'Frattazzatura manuale/meccanica, rifiniture, protezione e stagionatura del massetto; eventuale bagnatura di maturazione.',
    rischi: [
      { rischio: 'Vibrazioni e rumore da frattazzatrice meccanica (elicottero)', P: 3, D: 2, misure: 'Attrezzi manutenuti; rotazione; DPI; limitazione tempi di esposizione.', dpi: 'Guanti antivibranti, otoprotettori' },
      { rischio: 'Rischio chimico residuo da contatto prolungato con superficie cementizia', P: 2, D: 3, misure: 'DPI integri; igiene personale; limitazione del contatto diretto.', dpi: 'Guanti impermeabili, ginocchiere' },
      { rischio: 'Inciampo/caduta su area non transitabile in maturazione', P: 2, D: 2, misure: 'Delimitazione e segnalazione area in maturazione; divieto di transito; cartellonistica.', dpi: 'Scarpe S3' },
    ] },
]

const rischiSpecifici = [
  { rischio: 'Rumore (Titolo VIII Capo II)', P: 3, D: 2, misure: 'Valutazione con misurazioni o banche dati; se LEX,8h > 85 dB(A): DPI obbligatori, formazione, sorveglianza sanitaria; segnalazione aree.', dpi: 'Otoprotettori' },
  { rischio: 'Vibrazioni mano-braccio (Titolo VIII Capo III)', P: 3, D: 2, misure: 'Valutazione A(8); scelta attrezzi a bassa vibrazione; rotazione; sorveglianza sanitaria se superato valore d’azione.', dpi: 'Guanti antivibranti' },
  { rischio: 'Movimentazione manuale dei carichi (Titolo VI)', P: 3, D: 2, misure: 'Valutazione (metodo NIOSH); ausili meccanici; formazione; limiti di peso; organizzazione.', dpi: 'Guanti, fascia lombare' },
  { rischio: 'Polveri e Silice cristallina respirabile (Titolo IX)', P: 3, D: 3, misure: 'Lavorazioni a umido ove possibile; aspirazione; limitazione dispersione; misurazione esposizione; sorveglianza sanitaria.', dpi: 'FFP3, occhiali, tuta' },
  { rischio: 'Agenti chimici — cemento/additivi (Titolo IX Capo I)', P: 3, D: 3, misure: 'Schede di sicurezza (SDS); riduzione contatto; igiene; uso corretto additivi; controllo cromo VI.', dpi: 'Guanti impermeabili, occhiali, tuta' },
  { rischio: 'Rischio elettrico (Titolo III)', P: 2, D: 3, misure: 'Impianto di cantiere a norma CEI; quadri ASC; differenziali; verifiche; cavi sollevati.', dpi: 'Calzature isolanti, guanti' },
  { rischio: 'Cadute dall’alto / aperture nel solaio (Titolo IV)', P: 2, D: 4, misure: 'Protezioni collettive (parapetti, coperture); verifica preliminare; coordinamento con affidataria/CSE.', dpi: 'Imbracatura/cordino se residuo' },
]

const dpi = [
  ['Elmetto di protezione', 'EN 397', 'Rischio caduta materiali dall’alto, urti', 'Tutte le fasi in cantiere con attività sovrastanti'],
  ['Calzature di sicurezza S3', 'EN ISO 20345', 'Schiacciamento, perforazione, scivolamento, umidità', 'Tutte le fasi'],
  ['Guanti antiabrasione/antitaglio', 'EN 388', 'Tagli, abrasioni (rete, attrezzi)', 'Movimentazione, posa rete, attrezzi'],
  ['Guanti impermeabili nitrile/neoprene', 'EN 374', 'Contatto con cemento e additivi (rischio chimico)', 'Confezionamento, getto, finitura'],
  ['Occhiali/visiera di protezione', 'EN 166', 'Proiezione schizzi/polveri', 'Confezionamento, getto, frattazzatura'],
  ['Maschera FFP2/FFP3', 'EN 149', 'Polveri di cemento e silice cristallina', 'Travaso leganti, lavorazioni a secco'],
  ['Otoprotettori (inserti/cuffie)', 'EN 352', 'Rumore (betoniera, pompa, frattazzatrice)', 'Confezionamento, finitura meccanica'],
  ['Guanti antivibranti', 'EN ISO 10819', 'Vibrazioni mano-braccio', 'Staggiatura/frattazzatura meccanica'],
  ['Ginocchiere', 'EN 14404', 'Lavoro prolungato a terra/in ginocchio', 'Preparazione fondo, finitura'],
  ['Indumenti ad alta visibilità', 'EN ISO 20471', 'Investimento in aree di manovra mezzi', 'Aree di scarico/manovra'],
  ['Tuta da lavoro a copertura integrale', 'EN ISO 13688', 'Contatto cute con cemento/additivi', 'Confezionamento, getto, finitura'],
]

// ── tabella chiave/valore (schede dati) ──
function kv(rows) {
  return table(rows.map(([k, v, hl]) => new TableRow({ children: [
    cell(k, { bold: true, fill: 'F2F2F2', w: 38, size: 18 }),
    new TableCell({ width: { size: 62, type: WidthType.PERCENTAGE }, margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: [new Paragraph({ children: [hl ? FILL(v) : new TextRun({ text: String(v), size: 18 })] })] }),
  ] })))
}

// ══════════ CORPO DEL DOCUMENTO ══════════
const body = []

// COPERTINA
body.push(
  new Paragraph({ spacing: { before: 600, after: 120 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'PIANO OPERATIVO DI SICUREZZA', bold: true, color: RED, size: 48 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
    children: [new TextRun({ text: '(P.O.S.)', bold: true, color: RED, size: 32 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 480 },
    children: [new TextRun({ text: 'redatto ai sensi dell’art. 89 e dell’Allegato XV del D.Lgs. 9 aprile 2008, n. 81 e s.m.i.', italics: true, size: 20, color: GREY })] }),
  kv([
    ['Impresa esecutrice', 'RESTRUKTURA S.r.l.'],
    ['Lavorazioni affidate', 'Esecuzione di massetti'],
    ['Cantiere', 'Lotto 2 – D0, Villa d’Agri – Marsicovetere (PZ)'],
    ['Committente / Impresa affidataria', 'CELANO COSTRUZIONI S.r.l.'],
    ['Ruolo dell’impresa', 'Impresa esecutrice in subappalto (opere di massetto)'],
    ['Data di emissione', '04/06/2026'],
    ['Revisione', 'Rev. 00'],
  ]),
  new Paragraph({ spacing: { before: 480 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'RESTRUKTURA S.r.l. — Via Roma 60, 85050 Marsicovetere (PZ) — P.IVA/C.F. 02087420762', size: 18, color: GREY })] }),
  new Paragraph({ children: [new PageBreak()] }),
)

// INDICE
body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 },
  children: [new TextRun({ text: 'INDICE', bold: true, color: RED, size: 28 })] }))
;[
  '1. Premessa, scopo e riferimenti normativi',
  '2. Anagrafica dell’impresa esecutrice',
  '3. Posizioni assicurative e previdenziali',
  '4. Organigramma della sicurezza',
  '5. Dati del cantiere, committente e coordinatori',
  '6. Descrizione dell’opera e delle lavorazioni affidate',
  '7. Organizzazione del cantiere e cronoprogramma',
  '8. Metodologia di valutazione dei rischi',
  '9. Valutazione dei rischi per fase di lavorazione',
  '10. Rischi specifici e relative misure',
  '11. Dispositivi di Protezione Individuale (DPI)',
  '12. Macchine, attrezzature e sostanze utilizzate',
  '13. Gestione delle emergenze e primo soccorso',
  '14. Misure di coordinamento con il PSC e gestione delle interferenze',
  '15. Formazione, informazione, addestramento e sorveglianza sanitaria',
  '16. Segnaletica di sicurezza',
  '17. Dichiarazioni finali e firme',
  '18. Allegato — Dati da completare prima della consegna',
].forEach(t => body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: t, size: 20 })] })))

// 1. PREMESSA
body.push(H1('1. PREMESSA, SCOPO E RIFERIMENTI NORMATIVI'))
body.push(P('Il presente Piano Operativo di Sicurezza (P.O.S.) è redatto dall’impresa RESTRUKTURA S.r.l., in qualità di impresa esecutrice delle opere di massetto affidate in subappalto dall’impresa affidataria CELANO COSTRUZIONI S.r.l., per il cantiere ubicato nel Lotto 2 – D0 in Villa d’Agri, Comune di Marsicovetere (PZ).'))
body.push(P('Il documento costituisce il piano complementare di dettaglio del Piano di Sicurezza e Coordinamento (PSC) redatto per l’opera, ai sensi dell’art. 89, comma 1, lett. h) del D.Lgs. 81/2008, e ne recepisce le prescrizioni. Esso contiene l’individuazione, l’analisi e la valutazione dei rischi connessi alle lavorazioni eseguite dall’impresa, nonché le conseguenti misure di prevenzione e protezione e i dispositivi di protezione individuale adottati.'))
body.push(H2('Riferimenti normativi principali'))
;['D.Lgs. 9 aprile 2008, n. 81 e s.m.i. — Testo Unico sulla salute e sicurezza nei luoghi di lavoro',
  'Allegato XV al D.Lgs. 81/2008 — contenuti minimi del POS',
  'D.Lgs. 106/2009 — disposizioni integrative e correttive',
  'Titoli IV (cantieri), VI (MMC), VIII (agenti fisici), IX (sostanze pericolose) del D.Lgs. 81/2008',
  'Normative tecniche di prodotto applicabili ai DPI (serie EN)'].forEach(t => body.push(B('Rif', t)))

// 2. ANAGRAFICA IMPRESA
body.push(H1('2. ANAGRAFICA DELL’IMPRESA ESECUTRICE'))
body.push(kv([
  ['Ragione sociale', 'RESTRUKTURA S.r.l.'],
  ['Sede legale', 'Via Roma n. 60, 85050 Marsicovetere (PZ)'],
  ['Partita IVA / Codice Fiscale', '02087420762'],
  ['Numero REA', 'PZ-206380'],
  ['Datore di Lavoro / Legale rappresentante', 'Ing. Raffaele Lentini'],
  ['Attività svolta in cantiere', 'Esecuzione di massetti'],
  ['Recapiti (tel./PEC)', 'da completare', true],
]))

// 3. POSIZIONI
body.push(H1('3. POSIZIONI ASSICURATIVE E PREVIDENZIALI'))
body.push(kv([
  ['Posizione INPS (matricola)', '6405841659 — sede di Potenza'],
  ['Posizione INAIL — Cod. Ditta', '20748666/52'],
  ['Posizione INAIL — P.A.T.', '96119656/99  (da verificare/confermare)', true],
  ['Cassa Edile', 'Cassa Edile di Potenza — cod. impresa 11338'],
  ['DURC', 'Prot. INPS_50276445 — REGOLARE — validità fino al 07/08/2026'],
]))
body.push(P([new TextRun({ text: 'Nota: ', bold: true, size: 18 }), new TextRun({ text: 'il DURC risulta regolare nei confronti di INPS, INAIL e Cassa Edile alla data di emissione del presente documento.', size: 18 })]))

// 4. ORGANIGRAMMA
body.push(H1('4. ORGANIGRAMMA DELLA SICUREZZA'))
body.push(P('Si riportano le figure della prevenzione dell’impresa esecutrice, come da Documento di Valutazione dei Rischi (DVR) aziendale Rev. 04.'))
body.push(table([
  headerRow(['Ruolo', 'Nominativo', 'Note'], [34, 33, 33]),
  ...[
    ['Datore di Lavoro', 'Ing. Raffaele Lentini', '—'],
    ['Responsabile S.P.P. (RSPP)', 'Ing. Raffaele Lentini', 'Datore di lavoro–RSPP'],
    ['Medico Competente', 'Dott. Carmelo Romano (esterno)', 'Vedi nota sorveglianza sanitaria, §15'],
    ['Rappr. dei Lavoratori per la Sicurezza (RLS)', 'Sig.ra Rosaria Sassano', 'Nomina del 16/09/2024'],
    ['Preposto / Capocantiere', 'Sig. Quinto Labriola', '—'],
    ['Addetto antincendio e gestione emergenze', 'Ing. Raffaele Lentini', '—'],
    ['Addetto al primo soccorso', 'Ing. Raffaele Lentini', '—'],
  ].map(r => new TableRow({ children: r.map((c, i) => cell(c, { size: 18, bold: i === 0 })) })),
]))
body.push(P([new TextRun({ text: 'Operai addetti alle lavorazioni di cantiere: ', bold: true, size: 18 }), FILL('da inserire (numero e nominativi degli operai effettivamente impiegati nel cantiere)')]))

// 5. CANTIERE
body.push(H1('5. DATI DEL CANTIERE, COMMITTENTE E COORDINATORI'))
body.push(kv([
  ['Ubicazione cantiere', 'Lotto 2 – D0, Villa d’Agri – Marsicovetere (PZ)'],
  ['Indirizzo esatto', 'da confermare (rif. PSC/contratto)', true],
  ['Committente / Impresa affidataria', 'CELANO COSTRUZIONI S.r.l.'],
  ['Coordinatore per l’esecuzione (CSE)', 'Ing. Carmine Scavetta'],
  ['Coordinatore per la progettazione (CSP)', 'da confermare dal PSC', true],
  ['Direttore dei Lavori', 'da inserire', true],
  ['Natura dell’opera', 'Edificio in c.a. su pali e isolatori sismici (contesto generale dell’opera)'],
  ['Opere affidate a Restruktura', 'Esecuzione dei massetti'],
  ['Importo dei lavori in subappalto', 'da inserire (rif. contratto)', true],
  ['Durata prevista delle lavorazioni', 'da inserire (data inizio/fine)', true],
  ['PSC dell’opera', 'Esistente (Lotto 2 – D0) — il presente POS ne recepisce le prescrizioni'],
]))

// 6. DESCRIZIONE OPERA
body.push(H1('6. DESCRIZIONE DELL’OPERA E DELLE LAVORAZIONI AFFIDATE'))
body.push(P('Le lavorazioni affidate all’impresa RESTRUKTURA S.r.l. consistono nella realizzazione di massetti (sottofondi e/o massetti di finitura) all’interno del fabbricato in costruzione. La lavorazione si articola nelle seguenti fasi operative:'))
;['Allestimento dell’area di lavoro e approvvigionamento dei materiali (leganti, inerti, additivi, rete, isolanti);',
  'Preparazione del fondo: pulizia, posa di barriera al vapore/strato isolante e di rete elettrosaldata, posa dei riferimenti di quota;',
  'Confezionamento dell’impasto (betoniera/impastatrice o premiscelato pompabile);',
  'Getto, stesura e staggiatura del massetto sulle quote di progetto;',
  'Finitura superficiale (frattazzatura) e maturazione/stagionatura.'].forEach(t => body.push(B('Fase', t)))

// 7. ORGANIZZAZIONE
body.push(H1('7. ORGANIZZAZIONE DEL CANTIERE E CRONOPROGRAMMA'))
body.push(P('L’organizzazione del cantiere, gli apprestamenti (recinzioni, baraccamenti, servizi igienico-assistenziali, viabilità, impianti) e la logistica generale sono definiti dall’impresa affidataria CELANO COSTRUZIONI S.r.l. nel rispetto del PSC. L’impresa esecutrice opera all’interno di tale organizzazione, coordinandosi con l’affidataria e con il CSE per la sovrapposizione temporale e spaziale delle lavorazioni.'))
body.push(P([new TextRun({ text: 'Cronoprogramma delle lavorazioni di massetto: ', bold: true, size: 18 }), FILL('da inserire (date di inizio e fine, durata in giorni, eventuale sovrapposizione con altre imprese)')]))

// 8. METODOLOGIA
body.push(H1('8. METODOLOGIA DI VALUTAZIONE DEI RISCHI'))
body.push(P('La valutazione dei rischi è condotta, per ciascuna fase di lavorazione, individuando i fattori di rischio e stimando l’entità del rischio R come prodotto della Probabilità di accadimento (P) e della Magnitudo del Danno (D), secondo le scale seguenti.'))
body.push(H2('Scala di Probabilità (P) e Danno (D)'))
body.push(table([
  headerRow(['Valore', 'Probabilità (P)', 'Danno (D)'], [12, 44, 44]),
  ...[
    ['1', 'Improbabile', 'Lieve (inabilità rapidamente reversibile)'],
    ['2', 'Poco probabile', 'Modesto (inabilità reversibile)'],
    ['3', 'Probabile', 'Grave (inabilità parziale permanente)'],
    ['4', 'Molto probabile', 'Gravissimo (invalidità totale o morte)'],
  ].map(r => new TableRow({ children: r.map((c, i) => cell(c, { size: 18, bold: i === 0 })) })),
]))
body.push(H2('Matrice del rischio R = P × D'))
body.push(P([
  new TextRun({ text: 'R = 1–3 ', bold: true, size: 18 }), new TextRun({ text: 'rischio basso (accettabile, mantenere le misure);  ', size: 18 }),
  new TextRun({ text: 'R = 4–7 ', bold: true, size: 18 }), new TextRun({ text: 'rischio medio (programmare interventi di miglioramento);  ', size: 18 }),
  new TextRun({ text: 'R = 8–11 ', bold: true, size: 18 }), new TextRun({ text: 'rischio alto (interventi a breve termine);  ', size: 18 }),
  new TextRun({ text: 'R = 12–16 ', bold: true, size: 18 }), new TextRun({ text: 'rischio molto alto (interventi immediati).', size: 18 }),
]))

// 9. VALUTAZIONE PER FASE
body.push(H1('9. VALUTAZIONE DEI RISCHI PER FASE DI LAVORAZIONE'))
body.push(P('Per ciascuna fase si riportano la descrizione, i fattori di rischio, la stima P×D=R e le misure di prevenzione e protezione, con indicazione dei DPI.'))
fasi.forEach((f, idx) => {
  body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, pageBreakBefore: idx > 0,
    children: [new TextRun({ text: f.nome, bold: true, color: '1A1A1A', size: 24 })] }))
  body.push(P(f.descr))
  body.push(riskTable(f.rischi))
})

// 10. RISCHI SPECIFICI
body.push(H1('10. RISCHI SPECIFICI E RELATIVE MISURE'))
body.push(P('Si riportano i rischi specifici di natura igienico-ambientale e infortunistica connessi alle lavorazioni, con i relativi riferimenti normativi e misure.'))
body.push(riskTable(rischiSpecifici))

// 11. DPI
body.push(H1('11. DISPOSITIVI DI PROTEZIONE INDIVIDUALE (DPI)'))
body.push(P('I lavoratori sono dotati dei DPI di seguito elencati, idonei ai rischi e conformi alle norme tecniche applicabili. L’impresa ne garantisce la fornitura, la formazione all’uso e la sostituzione.'))
body.push(table([
  headerRow(['DPI', 'Norma EN', 'Rischio da cui protegge', 'Impiego'], [24, 16, 34, 26]),
  ...dpi.map(r => new TableRow({ children: r.map((c, i) => cell(c, { size: 16, bold: i === 0 })) })),
]))

// 12. MACCHINE
body.push(H1('12. MACCHINE, ATTREZZATURE E SOSTANZE UTILIZZATE'))
body.push(table([
  headerRow(['Macchina / Attrezzatura / Sostanza', 'Principali rischi', 'Misure'], [30, 33, 37]),
  ...[
    ['Betoniera / impastatrice', 'Organi in movimento, rumore, elettrico, polveri', 'Protezioni integre; uso da personale formato; manutenzione; DPI'],
    ['Autopompa / pompa per massetto', 'Colpo di frusta tubazioni, alta pressione, investimento', 'Personale addestrato; tubazioni in efficienza; coordinamento; delimitazione'],
    ['Staggia vibrante / frattazzatrice (elicottero)', 'Vibrazioni, rumore, proiezioni', 'Attrezzi a bassa vibrazione; rotazione; DPI; manutenzione'],
    ['Utensili elettrici portatili', 'Elettrico, proiezioni, tagli', 'Doppio isolamento; quadri con differenziali; cavi integri'],
    ['Cemento / leganti / additivi', 'Chimico (ustioni alcaline, dermatiti), polveri/silice', 'Schede di sicurezza (SDS); DPI impermeabili; igiene; lavorazioni a umido'],
    ['Carriole / transpallet / mezzi di sollevamento', 'MMC, schiacciamento, ribaltamento', 'Ausili idonei; formazione MMC; percorsi adeguati'],
  ].map(r => new TableRow({ children: r.map((c, i) => cell(c, { size: 17, bold: i === 0 })) })),
]))

// 13. EMERGENZE
body.push(H1('13. GESTIONE DELLE EMERGENZE E PRIMO SOCCORSO'))
body.push(P('La gestione delle emergenze in cantiere è coordinata con l’impresa affidataria secondo il piano di emergenza generale del cantiere e il PSC. L’impresa esecutrice individua i propri addetti e assicura la presenza dei presidi di primo soccorso.'))
body.push(table([
  headerRow(['Funzione', 'Riferimento'], [40, 60]),
  ...[
    ['Addetto antincendio / gestione emergenze', 'Ing. Raffaele Lentini'],
    ['Addetto al primo soccorso', 'Ing. Raffaele Lentini'],
    ['Presidi di primo soccorso', 'Cassetta di pronto soccorso / pacchetto di medicazione in cantiere'],
    ['Numeri di emergenza', 'Emergenza unica 112 — Emergenza sanitaria 118 — Vigili del Fuoco 115'],
    ['Punto di raccolta e vie di esodo', 'come da planimetria di emergenza del cantiere (PSC)'],
  ].map(r => new TableRow({ children: r.map((c, i) => cell(c, { size: 18, bold: i === 0 })) })),
]))
body.push(P([new TextRun({ text: 'Attestati formazione addetti antincendio/primo soccorso: ', bold: true, size: 18 }), FILL('allegare/indicare estremi')]))

// 14. COORDINAMENTO
body.push(H1('14. MISURE DI COORDINAMENTO CON IL PSC E GESTIONE DELLE INTERFERENZE'))
body.push(P('L’impresa esecutrice recepisce integralmente le prescrizioni del PSC e si coordina con l’impresa affidataria CELANO COSTRUZIONI S.r.l. e con il CSE Ing. Carmine Scavetta. In particolare:'))
;['Partecipazione alle riunioni di coordinamento indette dal CSE;',
  'Rispetto delle prescrizioni del PSC in materia di sfasamento spaziale e temporale delle lavorazioni;',
  'Comunicazione preventiva al CSE/affidataria delle proprie lavorazioni e dei mezzi impiegati (autopompa, autobetoniera);',
  'Verifica preliminare della protezione di aperture, vani e bordi (protezioni collettive a cura dell’affidataria);',
  'Gestione delle interferenze con le altre imprese presenti in cantiere secondo il PSC.'].forEach(t => body.push(B('Misura', t)))

// 15. FORMAZIONE/SORVEGLIANZA
body.push(H1('15. FORMAZIONE, INFORMAZIONE, ADDESTRAMENTO E SORVEGLIANZA SANITARIA'))
body.push(P('I lavoratori hanno ricevuto formazione e informazione ai sensi degli artt. 36-37 del D.Lgs. 81/2008 e addestramento all’uso dei DPI e delle attrezzature. La sorveglianza sanitaria è affidata al Medico Competente, con visite e protocollo sanitario in relazione ai rischi (rumore, vibrazioni, MMC, chimico, silice).'))
body.push(P([new TextRun({ text: '⚠ Avviso importante — sorveglianza sanitaria: ', bold: true, color: RED, size: 18 }), new TextRun({ text: 'l’incarico del Medico Competente Dott. Carmelo Romano risulta con scadenza 17/05/2026; alla data di emissione del presente POS l’incarico è da rinnovare. È necessario formalizzare il rinnovo della nomina prima dell’avvio delle lavorazioni per garantire la copertura della sorveglianza sanitaria.', size: 18 })]))
body.push(P([new TextRun({ text: 'Estremi attestati di formazione dei lavoratori: ', bold: true, size: 18 }), FILL('da inserire/allegare')]))

// 16. SEGNALETICA
body.push(H1('16. SEGNALETICA DI SICUREZZA'))
body.push(P('In cantiere è esposta la segnaletica di sicurezza prevista dal Titolo V del D.Lgs. 81/2008: segnali di divieto (es. accesso vietato ai non addetti), di avvertimento (rischio caduta, materiale in maturazione), di obbligo (uso DPI: elmetto, scarpe, guanti, occhiali, otoprotettori, mascherina) e di salvataggio/emergenza (vie di esodo, presidi di primo soccorso, estintori), in coerenza con il PSC.'))

// 17. FIRME
body.push(H1('17. DICHIARAZIONI FINALI E FIRME'))
body.push(P('L’impresa RESTRUKTURA S.r.l. dichiara che il presente POS è stato redatto in conformità all’Allegato XV del D.Lgs. 81/2008, che ne è stata data informazione ai lavoratori e che le misure in esso contenute saranno attuate e aggiornate in caso di varianti delle lavorazioni.'))
body.push(P('Marsicovetere, lì 04/06/2026', { after: 360 }))
body.push(table([
  headerRow(['Funzione', 'Nominativo', 'Firma'], [34, 33, 33]),
  ...[
    ['Datore di Lavoro / RSPP', 'Ing. Raffaele Lentini', ''],
    ['Medico Competente', 'Dott. Carmelo Romano', ''],
    ['RLS', 'Sig.ra Rosaria Sassano', ''],
    ['Preposto / Capocantiere', 'Sig. Quinto Labriola', ''],
    ['Per presa visione — CSE', 'Ing. Carmine Scavetta', ''],
  ].map(r => new TableRow({ children: [cell(r[0], { size: 18, bold: true }), cell(r[1], { size: 18 }),
    new TableCell({ width: { size: 33, type: WidthType.PERCENTAGE }, margins: { top: 200, bottom: 40, left: 80, right: 80 },
      children: [new Paragraph({ children: [new TextRun({ text: '________________', size: 18 })] })] })] })),
]))

// 18. ALLEGATO CAMPI DA COMPLETARE
body.push(H1('18. ALLEGATO — DATI DA COMPLETARE PRIMA DELLA CONSEGNA'))
body.push(P('I seguenti dati non sono presenti nel DVR/visura aziendale e devono essere inseriti/verificati dall’Ingegnere prima della consegna a CELANO COSTRUZIONI S.r.l. (evidenziati in giallo nel testo):'))
;['P.A.T. INAIL — confermare il numero (96119656/99 indicato salvo verifica)',
  'Numero e nominativi degli operai effettivamente impiegati in cantiere (gli addetti d’ufficio non costituiscono squadra di cantiere)',
  'Direttore dei Lavori e Coordinatore per la progettazione (CSP) — dal PSC',
  'Importo dei lavori in subappalto — dal contratto',
  'Durata delle lavorazioni (date inizio/fine, cronoprogramma)',
  'Indirizzo esatto del cantiere — dal PSC/contratto',
  'Rinnovo della nomina del Medico Competente (incarico scaduto il 17/05/2026)',
  'Estremi/allegati degli attestati di formazione e idoneità sanitaria',
  'Recapiti aziendali (telefono/PEC)'].forEach(t => body.push(B('Da completare', t)))

// ── DOCUMENTO ──
const doc = new Document({
  creator: 'RESTRUKTURA S.r.l.',
  title: 'POS Restruktura - Cantiere Celano Lotto 2 D0 - Massetti',
  styles: { default: { document: { run: { font: 'Calibri' } } } },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 900, left: 1000, right: 1000 } } },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: 'P.O.S. — RESTRUKTURA S.r.l. — Cantiere Celano Lotto 2/D0', size: 14, color: GREY })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'RESTRUKTURA S.r.l. — P.IVA 02087420762     |     Pag. ', size: 16, color: GREY }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }),
        new TextRun({ text: ' di ', size: 16, color: GREY }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: GREY }),
      ] })] }) },
    children: body,
  }],
})

const out = path.join(__dirname, '..', 'POS_Restruktura_Celano_Lotto2_D0.docx')
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log('OK', out, buf.length, 'bytes') })
  .catch(e => { console.error('ERR', e); process.exit(1) })

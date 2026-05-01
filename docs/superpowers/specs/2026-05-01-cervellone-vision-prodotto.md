# Cervellone — Visione di prodotto e strategia complessiva

**Data:** 1 maggio 2026
**Tipo:** Spec strategica multi-fase (visione di prodotto, NON sub-progetto implementativo)
**Owner:** Ing. Raffaele Lentini
**Status:** approvata, da eseguire fase per fase

---

## Premessa

Cervellone NON è un chatbot Telegram. È un **AI assistant operativo completo** per Restruktura SRL: una società di ingegneria seria che si vuole strutturare con AI per gestire progettazione, direzione lavori, pratiche edilizie, segreteria, marketing e operazioni quotidiane.

Questa spec definisce: cosa Cervellone deve saper fare, dove sono i punti deboli/pecche da risolvere, quali sistemi costruire, in che ordine, con che ROI economico misurato.

L'utente usa già Claude AI / Claude Code / Claude Projects come supporto al lavoro. Cervellone aggiunge **valore incrementale** (delta misurato: ~12-14h/sett recuperate, ~€32.000-37.000/anno) e copre quattro aree dove gli strumenti generici non arrivano: multi-canale, cron 24/7, verifica norme italiane vigenti, Local Agent dominio.

---

## SEZIONE 1 — Mappa funzionale completa

12 aree operative di una società di ingegneria strutturata. Per ognuna: cosa Cervellone fa + sistemi infrastrutturali richiesti (S1-S9 definiti nella SEZIONE 3).

### A. Studio tecnico — progettazione
- Calcoli strutturali (CA, acciaio, legno, muratura) con relazioni e verifiche NTC2018 [S2, S8]
- Computi metrici estimativi con prezziari regionali incrociati (17 prezziari) [S5]
- Quadri economici con somme a disposizione, IVA, oneri [S5]
- Cronoprogrammi (Gantt) [S5]
- Capitolati tecnici [S5]
- Disegni CAD via sub-agent: DXF, poi DWG via Local Agent + AutoCAD [S2, S6]
- Relazioni geologiche/geotecniche partendo da prove [S2]

### B. Direzione lavori e sicurezza cantiere
- POS, PSC, PSS, fascicolo tecnico [S5, S8]
- DURC + verifica subappaltatori [S6]
- SAL con foto cantiere come input [S5]
- Verbali di cantiere e riserve [S5]
- Collaudi statici e funzionali [S2, S5]
- Certificazioni: APE, acustica, antincendio CPI [S5, S6]
- Promemoria SAL automatici [cron]

### C. Pratiche edilizie e burocratiche
- SCIA, CILA, PdC con testi precompilati per Comune [S5, S9]
- Catasto: bozze DOCFA, PREGEO + check Sister manuale (NO scraping)
- Agibilità, fine lavori [S5]
- Pratiche genio civile sismiche Basilicata [S5, S9]
- CPI antincendio: relazioni e modulistica VVF [S5]
- Bonus fiscali: Sismabonus, Ecobonus 65/110%, asseverazioni [S5, S8]
- Vincoli paesaggistici, Soprintendenza [S5, S9]

### D. Amministrazione e segreteria operativa
- Preventivi clienti (con CME confronto, regola in memoria) [S5]
- Fatture elettroniche via Fatture in Cloud API [S6]
- Riconciliazione bancaria (CSV/MT940 → Supabase) [S2, S6]
- Scadenze fiscali F24, INPS, INAIL → reminder [cron]
- Cassa Edile, DURC ricorrenti [cron, S6]
- Polizze RC e cantiere (rinnovi, scadenze) [cron]

### E. Commerciale e sviluppo business
- Offerte commerciali con storytelling Restruktura [S5]
- Brochure e presentazioni clienti (PDF/PPT) [S5]
- PonteggioSicuro.it: contenuti SEO, blog automatico, lead capture [cron]
- Newsletter clienti + ex clienti [cron]
- Gare d'appalto pubbliche, MEPA, monitoring bandi [cron]
- Gestione lead: classificazione, follow-up automatico, CRM-light [cron]

### F. HR e gestione team interno
- Onboarding nuovi collaboratori (S7 quando arriverà 2° utente)
- Tracking task assegnati su Supabase
- Agende e riunioni (Google Calendar via S6)
- Formazione: sintesi normative aggiornate per il team

### G. Conoscenza tecnica e ricerca
- Normative aggiornate live (NTC, regolamenti regionali) [S8]
- Brevetti e letteratura tecnica (search + sintesi) [S2]
- Best practice e casi studio Restruktura (memoria RAG già presente)
- Monitoraggio modifiche normative → notifica all'Ingegnere [S8 cron]

### H. Routine programmate (cron)
- Lunedì 9:00: riepilogo cantieri attivi + scadenze settimana
- Ogni mattina: check email, classifica, suggerisci risposte [S6]
- Solleciti pagamenti scaduti automatici [S6]
- Backup giornaliero progetti [S4]
- Re-audit trimestrale qualità output Cervellone [S1]

### I. Esecuzione su PC dell'Ingegnere
- Operare su file in `C:/Progetti/...` (apri, modifica, salva) [S6]
- Excel desktop con macro/Office Scripts [S6]
- AutoCAD/Revit: comandi remoti, plot, export [S6]
- Outlook locale: leggere, archiviare, rispondere [S6]
- Stampa, archivio digitale (scanner → OCR → catalogazione) [S6]

### J. Esecuzione codice e test
- Calcoli custom (Python/JS) in microVM ephemeral [S2]
- Parsing documenti complessi (DWG, IFC, BIM) [S2]
- Validazione output Cervellone (test automatici post-generazione) [S1, S2]
- Generazione DXF programmaticamente [S2]

### K. Multi-canale (oltre Telegram + web)
- WhatsApp Business API
- Email (invio + ricezione + classificazione) [S6]
- SMS notifiche urgenti
- Dashboard web di controllo

### L. Integrazioni strumenti esterni
- Google Workspace: Drive, Gmail, Calendar, Meet [S6]
- Microsoft 365: OneDrive, Outlook, Excel Online [S6]
- Fatture in Cloud, INPS, INAIL [S6]
- Catasto / Agenzia Entrate (Sister) — preparazione, NON scraping
- Geoportali regionali, mappe rischio sismico [S2]
- Meta Ads + Google Ads (per PonteggioSicuro) [cron]

---

## SEZIONE 2 — Pecche, punti deboli, gap onesti

### A. Limiti strutturali AI (non eliminabili al 100%)
| Pecca | Severità | Mitigazione |
|-------|----------|-------------|
| Hallucination su normative/articoli/coefficienti | 🔴 BLOCCANTE | S8 + Quality Gate + revisione umana obbligatoria |
| Calcoli numerici imprecisi | 🔴 BLOCCANTE | S2 (Sandbox Python con NumPy/SciPy), MAI calcoli a memoria |
| Visual reasoning su CAD complessi | 🟡 IMPORTANTE | S2 sub-agent + parsing DXF programmatico |
| Knowledge cutoff | 🟡 IMPORTANTE | S3 + S8 cron mensile aggiornamento |

### B. Limiti legali, GDPR, deontologici
| Pecca | Severità | Mitigazione |
|-------|----------|-------------|
| Nessuna firma giuridica AI | 🔴 STRUTTURALE | S1 review obbligatoria + audit trail |
| GDPR + dati clienti extra-UE | 🟡 IMPORTANTE | DPA Anthropic + anonymization PII |
| Codice deontologico uso AI | 🟡 IMPORTANTE | Disclaim contrattuale, validazione finale Ingegnere |
| Conservazione documentale a norma | 🟡 IMPORTANTE | Integrazione Aruba/Namirial |
| Audit trail immutabile | 🟡 IMPORTANTE | S1 log append-only + checksum hash |

### C. Gap integrazione strumenti tecnici
| Pecca | Severità | Mitigazione |
|-------|----------|-------------|
| AutoCAD/Revit no API AI-friendly | 🟡 | S6 Local Agent con script LISP/VBA |
| SAP2000/Midas API limitate | 🟡 | Cervellone prepara input file |
| Catasto/Sister scraping illegale | 🔴 | NON automatizzare |
| DURC online INPS/INAIL | 🟡 | Convenzione Ordine o commercialista |
| Comuni: ogni portale diverso | 🟡 | Modulistica precompilata, upload manuale |
| Fatture in Cloud API | 🟢 OK | Integrazione fattibile [S6] |

### D. Gap di processo
| Pecca | Severità | Mitigazione |
|-------|----------|-------------|
| Manca processo review obbligatoria | 🔴 | S1 con stati `bozza/in_review/approvato` |
| Manca versioning documenti | 🟡 | Tabella `document_versions` |
| Manca tracking richieste | 🟡 | Audit log per ogni request → output |
| Continuità senza Internet | 🟡 | S6 Local Agent con cache offline |

### E. Rischi infrastrutturali
| Pecca | Severità | Mitigazione |
|-------|----------|-------------|
| Single point of failure | 🟡 | S4 multi-provider (Anthropic + Sonnet fallback + Gemini) |
| Cost runaway Anthropic | 🟡 | Cap mensile, alert spending |
| Backup memoria Supabase | 🔴 | pg_dump giornaliero criptato off-site (Quick Win) |
| Disaster recovery PC | 🟡 | Local Agent multi-machine |

### F-H. Altri gap
- UX multi-user (S7, differita)
- Procedure Comuni locali (S9 risolve)
- Output graficamente professionale (S5 template)
- OCR scansioni vecchie (S5 cascata)

---

## SEZIONE 3 — I 9 Sistemi operativi

### Sistema 1 — Quality Gate System
**Risolve:** governance, audit, review obbligatoria, versioning, tracking, conservazione.
**Componenti:** stati documento (`bozza/in_review/approvato/firmato`), audit_log append-only, tool `richiedi_review()`, UI `/review/[id]` con diff.
**Stima:** 4 giorni | **Quando:** W7

### Sistema 2 — Numerical Engine + Vercel Sandbox
**Risolve:** calcoli numerici, parsing tecnico, generazione DXF, validazioni.
**Componenti:** Vercel Sandbox custom (Python 3.12 + NumPy/SciPy/ezdxf/ifcopenshell), tool `esegui_calcolo()`, libreria interna `cervellone-calc/`.
**Stima:** 7 giorni | **Quando:** W5-W6

### Sistema 3 — Knowledge Refresh nazionale
**Risolve:** knowledge cutoff (livello base, normative nazionali generali).
**Componenti:** cron mensile aggiornamento corpus normativo, RAG dedicato `knowledge_normativa`.
**Stima:** 4 giorni (assorbito in S8) | **Quando:** W3-W4

### Sistema 4 — Resilience Layer
**Risolve:** SPOF, cost runaway, backup, disaster recovery, rate limit.
**Componenti:** wrapper multi-provider AI con fallback, cap costi, pg_dump giornaliero criptato S3/Backblaze, health check endpoint.
**Stima:** 5 giorni | **Quando:** W12

### Sistema 5 — Document Pipeline
**Risolve:** output professionali, branding Restruktura, modulistica precompilata.
**Componenti:** template `.docx`/`.xlsx` con branding (POS, preventivo, CME, relazione, SCIA Villa d'Agri, ecc.), engine `docxtemplater`.
**Stima:** 3 giorni + cresce nel tempo | **Quando:** W11

### Sistema 6 — Local Operations Bridge
**Risolve:** AutoCAD/Revit, software calcolo, Outlook locale, Excel desktop, file PC.
**Componenti:** Cervellone Local Agent (servizio Windows TS/Python con Claude Agent SDK come base), skill modulari (`excel_op`, `autocad_op`, `outlook_op`, `file_op`, `print_op`), token rotante + IP whitelist + sandbox sicurezza.
**Stima:** 10 giorni | **Quando:** W8-W10

### Sistema 7 — Multi-User Foundation
**Risolve:** crescita team (segretaria, geometra, impiantista).
**Componenti:** schema `users`/`roles`/`permissions`, RLS Supabase, Auth (esistente), UI admin.
**Stima:** 4 giorni | **Quando:** quando arriva 2° utente reale (YAGNI)

### Sistema 8 — Source Verification & Norm Lifecycle
**Risolve:** citazioni normative italiane SEMPRE vigenti, lifecycle abrogazioni, notifiche modifiche.
**Componenti:** tabelle `norme`/`norme_relazioni`/`norme_versioni`, scraper Normattiva/EUR-Lex, tool obbligatorio `verifica_norma()`, cron giornaliero G.U. + settimanale critiche + mensile completo, citazione formattata con metadati.
**Stima:** 9 giorni | **Quando:** W3-W4 (estensione di S3)

### Sistema 9 — Territorial Knowledge Persistence
**Risolve:** documenti normativi locali (regolamenti edilizi comunali, PRG, NTA, oneri, modulistica) cross-progetto, persistenti per Comune/Regione.
**Componenti:** tabelle `territori`/`documenti_territoriali`/chunks, tool `salva_documento_territoriale()`/`scarica_da_portale_comune()`/`cerca_knowledge_territoriale()`, auto-loading territoriale per progetto, versioning con notifica retroattiva, whitelist domini istituzionali.
**Stima:** 6 giorni | **Quando:** W3-W4 parallelo S8
**Nota:** parzialmente coperto da Claude Projects che l'utente già usa. Vero delta: cross-project, versioning automatico, scala su 50+ Comuni, notifica retroattiva su norme cambiate.

---

## SEZIONE 4 — Schema strategico operativo

### Sequenza temporale 12 settimane

| Settimana | Cosa si fa | Sblocca |
|-----------|-----------|---------|
| W1 (5-9 mag) | Fix bug Telegram + Trigger.dev v3 | Bot risponde, task lunghi durable |
| W2 | Cron base + heartbeat task lunghi | Routine schedulate, UX progresso |
| W3-W4 | S8 (Source Verification) + S9 (Territorial Knowledge) + S3 base | Citazioni norme verificate, memoria territoriale |
| W5-W6 | S2 (Numerical Engine + Sandbox) | Calcoli affidabili, parsing tecnico |
| W7 | S1 (Quality Gate) | Review obbligatoria, audit, versioning |
| W8-W10 | S6 (Local Agent) | Cervellone agisce su PC reale |
| W11 | S5 (Document Pipeline) | Output professionali con template |
| W12 | S4 (Resilience Layer) | Backup, multi-provider, cap costi |
| futuro | S7 (Multi-User) | Solo quando arriva 2° utente |

### Dipendenze critiche
- S1 (Quality Gate) → precede uso per documenti firmabili
- S8 (Source Verification) → precede generazione pratiche edilizie reali
- S2 (Numerical Engine) → precede calcoli strutturali in produzione
- S6 (Local Agent) → additive, non blocca chat/cloud

### Decisioni operative IMMEDIATE (bloccate)
| Decisione | Risposta |
|-----------|----------|
| Stack durable | Trigger.dev v3 (NON Vercel WDK beta) |
| Modello AI default | Claude Opus 4.7 + override `/sonnet` |
| Thinking budget | Opus 8k, Sonnet 4k (era 100k = bug V10) |
| Sandbox calcoli | Vercel Sandbox (Firecracker microVM) |
| Local Agent base | Claude Agent SDK come fondamento |
| Banca dati normativa | Normattiva (free) + valutazione DeJure (€) entro Q3 |
| Backup Supabase | pg_dump giornaliero criptato off-site (S3/Backblaze) |
| Multi-provider AI | Anthropic primary, Sonnet fallback, Gemini futuro |
| Multi-user | NO ora. YAGNI fino a 2° utente reale |

### Anti-pattern (cosa NON fare)
- ❌ Espandere skill V10 prima di riparare streaming Telegram
- ❌ Aggiungere integrazioni (Gmail, Drive) prima di S1 Quality Gate
- ❌ Automatizzare Catasto/Sister via scraping (illegale)
- ❌ Multi-user prima del 2° utente reale
- ❌ Sostituire Trigger.dev con WDK finché beta
- ❌ Firmare documenti generati senza Quality Gate attivo
- ❌ Saltare Source Verification ("lo aggiungo dopo")

### Quick wins (≤1 giorno) in parallelo
- Cap costi Anthropic dashboard (5 min, oggi)
- GitHub Action backup Supabase giornaliero (1h)
- Whitelist domini fonti normative (2h, prima S8)
- Health check `/api/health` (1h)
- Disclaim contrattuale uso AI nei contratti clienti

---

## SEZIONE 5 — Confronto onesto vs Claude AI / Code / Projects / Dispatch

L'utente già usa Claude AI, Claude Code e Claude Projects come supporto. Cervellone aggiunge **valore incrementale**, non sostituisce.

### Delta incrementale per task (vs uso bene di Claude AI/Code/Projects)

| Task | Delta sett. recuperate |
|------|----------------------:|
| Email cliente standard | +1-1,5h |
| Preventivi | +1h |
| POS / sicurezza | +1h |
| Pratiche edilizie locali (S9) | +1-1,5h ⭐ |
| Direzione lavori (memoria persistente cantieri) | +1,5h ⭐ |
| Calcoli strutturali (S2) | +0,5h |
| Riepiloghi automatici (cron) | +0,5h ⭐ |
| Verifica norme italiane vigenti (S8) | +2h ⭐⭐ |
| Marketing PonteggioSicuro (cron + lead) | +1,5h |
| Local Agent dominio (Excel/AutoCAD/Outlook cantieri) | +2h ⭐ |
| **TOTALE INCREMENTALE/SETT** | **12-14h** |

### Quattro aree-killer dove Cervellone è genuinamente unico
1. **Multi-canale** (Telegram/WhatsApp/email) — Claude AI è solo browser/CLI
2. **Cron 24/7 dominio-specific** — Claude Tasks beta limitata
3. **Verifica norme italiane vigenti (S8)** — nessun tool generico fa lifecycle italiano
4. **Local Agent con skill dominio** — Claude Code è generico, non sa Restruktura

### Aree dove Claude AI/Code resta migliore o pari
- Coding generico, refactor, debug → Claude Code
- Brainstorming creativo, copywriting libero → Claude AI
- Capability AI emergenti → Anthropic le rilascia subito, Cervellone integra dopo
- Task una tantum non-ricorrenti → claude.ai più veloce

### Risparmio token (chat lunghe)
| Metrica | Claude AI | Cervellone V10+ |
|---------|----------|-----------------|
| Token input medio/turno | ~100k (50 turni) | ~10k (RAG + cache) |
| Costo Opus per turno | $1,50 | $0,15 |
| Costo 50 turni | $75 | **$7,50** |
| Risparmio token | – | **-90%** |
| Saturazione context | ⚠️ 100+ turni | ❌ mai (RAG scalabile) |
| Memoria dopo 6 mesi | ❌ persa/degradata | ✅ infinita via RAG |

Stima risparmio token annuo: **€1.500-2.500** (più di metà del costo cash si autoripaga).

---

## SEZIONE 6 — Business case economico

### Costi cash reali (esce dal conto)
| Voce | Annuo |
|------|------:|
| Anthropic API uso intensivo | €1.000-2.200 |
| Vercel Pro | €220 |
| Trigger.dev (free tier sufficiente inizio) | €0-220 |
| Supabase Pro | €280 |
| OpenAI embeddings | €55 |
| Backup S3/Backblaze | €30 |
| **TOTALE CASH ANNUO** | **€1.600-3.000** |

### Tempo di sviluppo (TUO tempo)
- Anno 1: 57 giorni distribuiti su 3-4 mesi part-time (~3-4h/giorno parallelo al lavoro normale)
- Anno 2+: 10-15 giorni/anno manutenzione

### TCO 5 anni (cash + valore recuperato)
| Anno | Cash | Valore recuperato | Saldo annuo cash | Cumulato |
|------|-----:|------------------:|------------------:|----------:|
| 1 | €2.500 | €21.000 | +€18.500 | +€18.500 |
| 2 | €2.500 | €45.000 | +€42.500 | +€61.000 |
| 3 | €2.500 | €58.000 | +€55.500 | +€116.500 |
| 4 | €2.500 | €58.000 | +€55.500 | +€172.000 |
| 5 | €2.500 | €58.000 | +€55.500 | **+€227.500** |

**Payback cash: 2 mesi anno 1.**

### Curva del vantaggio reale percepito
| Periodo | Vantaggio percepito |
|---------|--------------------:|
| Oggi → 7 maggio | -10% (V10 rotto) |
| Fine W1 (8 maggio) | +5% (Telegram torna a parlare) |
| Fine W2 (16 maggio) | +15% (cron lunedì 9:00 cantieri) |
| Fine W4 (30 maggio) | +30% (S8 + S9 attivi, primo Comune caricato) |
| Fine W6 (13 giugno) | +50% (calcoli affidabili, fidi a firmare) |
| Fine W7 (20 giugno) | +60% (Quality Gate, audit trail) |
| Fine W10 (11 luglio) | +75% (Local Agent agisce su PC reale) |
| Fine W12 (25 luglio) | +80% (production-ready) |
| Mese 4-6 (ago-ott 2026) | +85-90% (knowledge cumulata, ROI misurabile) |
| Mese 12 (mag 2027) | +95% (insostituibile per Restruktura) |

---

## SEZIONE 7 — Limiti residui non eliminabili (onestà)

- 🔴 **Hallucination AI** — riducibile con S2 + S8, mai 0%. Rimane: revisione umana
- 🔴 **Firma giuridica AI** — sempre Ingegnere. Punto.
- 🔴 **Catasto/Sister automatico** — illegale. Sempre manuale
- 🟡 **Codice deontologico** — disclaim contrattuale + validazione finale
- 🟡 **Norme tecniche UNI/EN/ISO a pagamento** — solo se acquistate, non scaricabili
- 🟡 **Norme regionali frammentate** — alcune regioni mal digitalizzate
- 🟢 **Giurisprudenza Cassazione/TAR** — NON copriamo. Se serve: banca dati commerciale

---

## SEZIONE 8 — Riferimenti

- Memoria architettura target: `memory/cervellone-architettura-target.md`
- Roadmap operativa: `memory/cervellone-roadmap.md`
- Spec V10 precedente: `docs/superpowers/specs/2026-04-18-cervellone-v10-skill-modulari.md`
- Spec Fase 1 implementativa: `docs/superpowers/specs/2026-05-01-fase1-riparazione-trigger-dev-design.md`
- Workflow utente: `memory/feedback_claude_projects_workflow.md`
- Trigger.dev v3 docs: https://trigger.dev/docs/v3
- Vercel Sandbox docs: https://vercel.com/docs/vercel-sandbox

---

## Approvazione e prossimo passo

Spec strategica approvata in brainstorming del 1 maggio 2026 (Ing. Lentini).

**Prossimo passo concreto:** invocare `superpowers:writing-plans` per produrre il piano implementativo dettagliato di **W1 (Fase 1: Fix Telegram + Trigger.dev)** già in spec separata `2026-05-01-fase1-riparazione-trigger-dev-design.md`. Il piano sarà eseguito in worktree dedicato con TDD.

# Check-in come pratica aperta — design

**24 agosto 2026.** Estende la web app di check-in de LA REAL ESTATE SRLS (LIVE dal 24/08) dal modello "registrazione in un colpo solo" a quello descritto dall'Ingegnere: una prenotazione che nasce prima, un link che gira, più persone che compilano la propria parte, e uno stato che si chiude da solo quando è tutto pieno.

Presuppone: [`2026-08-21-la-real-estate-contabilita-design.md`](2026-08-21-la-real-estate-contabilita-design.md), sezioni 9-15.

---

## 1. Il flusso, come l'ha descritto l'Ingegnere

1. Arriva la prenotazione. L'Ingegnere dà a Cervellone **uno screenshot**, oppure scrive a mano i pochi dati che ha: numero e data prenotazione, nome, numero ospiti, appartamento.
2. Il sistema **genera un link precompilato**.
3. Il link va all'ospite, che completa la sua parte e **carica le foto fronte/retro** del documento.
4. Oppure l'ospite gira il link agli altri, che compilano **solo la propria scheda**.
5. Quando è tutto completo, sul foglio compare **CHECKIN OK**.
6. Se manca qualcosa, **la ragazza** che consegna le chiavi completa dallo stesso link.

## 2. Cosa cambia rispetto a oggi

**D11 — La riga nasce prima del check-in.** Oggi il foglio riceve una riga quando qualcuno preme "Salva". Qui la prenotazione esiste *prima*, e il form la riprende e la completa. Si passa da "registrazione" a **pratica aperta che si chiude quando è piena**.

Conseguenza non ovvia: ogni salvataggio è un **aggiornamento di riga**, non un'aggiunta. Serve saper riscrivere una riga esistente per `ID Soggiorno` — cosa che oggi il codice non fa (scrive solo in fondo).

**D12 — Un token per prenotazione, e uno per ospite.** Oggi c'è un token unico per tutti. Se quel link gira su WhatsApp fra ospiti che non si conoscono, chiunque ce l'abbia apre *qualunque* prenotazione e vede i documenti altrui.

I token **non si conservano**: si derivano.

```
token prenotazione = HMAC-SHA256(CHECKIN_SECRET, "p:" + idSoggiorno)      → primi 24 car.
token ospite       = HMAC-SHA256(CHECKIN_SECRET, "o:" + idSoggiorno + ":" + n)
```

Motivo: un segreto scritto nel foglio è un segreto in un documento che gira. Derivandolo non c'è niente da custodire, niente da sincronizzare, e il collegamento si verifica senza leggere il foglio. Si revocano **tutti** ruotando `CHECKIN_SECRET` — accettabile: sono link di durata breve per costruzione (vedi D14).

**D13 — Tre livelli di accesso, non uno.**

| Chi | Link | Può |
|---|---|---|
| Ingegnere / ragazza | `?k=` (token generale) | tutto, campi bloccati compresi |
| Ospite intestatario | `?p=<id>&t=` | tutto tranne i campi bloccati; vede le schede degli altri ospiti solo per nome |
| Altro ospite | `?p=<id>&o=<n>&t=` | **solo la propria scheda** e le proprie foto |

**D14 — Il link scade.** Dopo il check-out una pratica non ha più motivo di essere aperta. Trascorsi 7 giorni dal check-out, il link risponde "collegamento scaduto". Non è una difesa forte, è **riduzione di superficie**: un link dimenticato in una chat non deve restare buono per sempre.

**D15 — I campi che vengono dall'Ingegnere sono in sola lettura per l'ospite.** Numero prenotazione, appartamento, date, numero ospiti e soprattutto **importo**. Se l'importo fosse modificabile, un ospite potrebbe — anche in buona fede — "correggerlo", e quella cifra finirebbe in fattura al posto di quella incassata. Il blocco è nel **server**, non solo nel form: un campo nascosto nell'interfaccia si rimanda comunque a mano.

## 3. Lo stato della pratica

Nuova colonna `Stato check-in` su `Soggiorni`:

| Stato | Quando |
|---|---|
| `DA COMPILARE` | appena creata |
| `PARZIALE` | qualcuno ha compilato, ma manca qualcosa |
| `CHECKIN OK` | tutto quello che serve c'è |

**`CHECKIN OK` si dichiara solo se, tutte insieme:**

- le schede ospiti compilate sono **tante quante il numero ospiti** della prenotazione;
- ogni ospite ha cognome, nome, data e luogo di nascita, cittadinanza, tipo e numero documento;
- ogni ospite italiano ha un **codice fiscale valido**;
- l'intestatario ha **indirizzo, CAP e comune** (senza, la fattura non si genera — [schema XSD FatturaPA](https://www.fatturapa.gov.it/), elemento `Sede` obbligatorio).

Il controllo sul **numero di ospiti** non è un dettaglio: se la prenotazione dice 4 e le schede sono 2, oggi nessuno se ne accorgerebbe — e due persone dormirebbero in casa senza essere comunicate alla Questura.

## 4. Le foto dei documenti

**Servono**: sono il modo in cui l'ospite trasmette i dati senza sbagliarli, e la prova del riconoscimento.

**E sono la parte più rischiosa del progetto**, non per ragioni tecniche. Il Garante privacy è intervenuto più volte sulle strutture ricettive: si possono acquisire i **dati** necessari alla comunicazione alla Questura, ma **conservare copia del documento** è quasi sempre eccedente rispetto allo scopo. Un archivio di documenti d'identità di decine di persone è, in caso di accesso non autorizzato, una violazione grave.

**D16 — Le foto sono di passaggio, non un archivio.** Fin dal primo giorno, non "poi":

- finiscono in una cartella Drive **privata**, mai in un link condivisibile;
- si **cancellano da sole** dopo l'invio ad Alloggiati, o comunque dopo N giorni dal check-out (`Config: giorni_conservazione_documenti`);
- il foglio conserva i **dati**, mai le immagini;
- ogni ospite vede e carica **solo le proprie**.

⚠️ **Da confermare con un legale o col commercialista**, insieme alle altre domande aperte. La difesa tecnica si costruisce comunque: è quella che rende la risposta "sì, si può" difendibile.

## 5. Come si crea una prenotazione

**Via 1 — a mano, e funziona da subito.** Una pagina `/checkin/nuova` (dietro il token generale): cinque campi — appartamento, date, nome, numero ospiti, importo — e in cambio il **link da girare**, con un pulsante per condividerlo.

**Via 2 — dallo screenshot.** L'Ingegnere manda a Cervellone la schermata della prenotazione, il bot estrae i campi e crea la pratica.

La Via 1 viene **prima**, e non perché la seconda sia difficile: perché la seconda dipende da Cervellone, che il 24 agosto è fermo per credito Anthropic esaurito. Un flusso che si ferma quando si ferma il bot non è un flusso, è una dipendenza.

## 6. Ordine di lavoro

1. **Ossatura**: prenotazione creata prima, token derivati, campi bloccati lato server, aggiornamento di riga per `ID Soggiorno`, stato calcolato.
2. **Foto dei documenti**, con la cancellazione automatica **fin dall'inizio**.
3. **Lettura automatica del documento** (banda MRZ di passaporti e carte d'identità): cognome, nome, data di nascita, numero documento, cittadinanza e scadenza si estraggono con cifre di controllo. All'ospite resta da *controllare*, non da scrivere. È la singola miglioria che cambia di più.
4. **Promemoria e Alloggiati**: avviso a 48 ore dall'arrivo se la pratica non è chiusa; file Alloggiati generato la sera dell'arrivo; con la WebServiceKey, invio automatico.
5. **Screenshot della prenotazione**.

## 7. Automazioni collegate, già decise altrove

- **Imposta di soggiorno**: riepilogo mensile e promemoria del **giorno 16** (artt. 6-7 del regolamento). Oggi quella scadenza non la segue nessuno.
- **Fatture settimanali** e **autofattura TD17**: Parti 2 e 3 della spec del 21 agosto.
- **Domande a colpo d'occhio**: *chi arriva domani*, *quali check-in non sono completi*, *quali soggiorni non hanno fattura*.
- ⚠️ **Doppio versamento dell'imposta**: l'art. 3 c.3 rende responsabili del versamento anche i portali telematici. Se Booking incassa e riversa, e versiamo anche noi, **si paga due volte**. Da verificare una volta e chiudere per sempre.

## 8. Come si prova

- I tre livelli di accesso vanno provati **sui casi che devono fallire**: il token di un ospite su un'altra prenotazione, il token di prenotazione usato per modificare l'importo, un link dopo la scadenza.
- Il blocco dei campi va provato **sul server**, mandando a mano un importo diverso: la difesa che vive solo nell'interfaccia non è una difesa.
- `CHECKIN OK` va provato sui casi incompleti, non su quello pieno: manca un ospite, manca un CF, manca l'indirizzo.
- La cancellazione delle foto va provata **guardando la cartella Drive**, non fidandosi del codice. Il 24 agosto un difetto vero (`0000000` che diventava `0`) si è visto solo rileggendo il foglio.

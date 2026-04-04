# Chat UI Redesign — Stile Claude AI

## Obiettivo
Ridisegnare l'interfaccia chat del Cervellone ispirandosi a Claude AI web, mantenendo l'identità Cervellone/Restruktura. Solo modifiche CSS/layout al file `src/app/chat/page.tsx` — nessuna modifica alla logica.

## File coinvolti
- `src/app/chat/page.tsx` — unico file da modificare (tutto il JSX/styling)

## File NON coinvolti
- `src/components/SplitPanel.tsx` — resta invariato
- `src/components/DocumentPreviewPanel.tsx` — resta invariato
- `src/components/MarkdownRenderer.tsx` — resta invariato
- Tutta la logica (streaming, API, file upload, ZIP, conversazioni) — invariata

---

## 1. Layout generale

- **Sfondo pagina**: `bg-white` (era `bg-gray-50`)
- **Nessun header fisso**: rimuovere l'header `<header>` scuro con logo. Logo e "Nuova chat" si spostano nella sidebar.
- **Messaggi centrati**: container messaggi con `max-w-3xl mx-auto` (768px)

## 2. Sidebar

### Da (attuale)
- Sfondo `bg-gray-900` (scuro)
- Testo bianco
- Bordo conversazioni `border-gray-800`
- Bottone nuova chat: `bg-blue-600`

### A (nuovo)
- Sfondo `bg-white` con `border-r border-gray-200`
- Testo `text-gray-800`
- **Header sidebar**: logo Cervellone (28px) + "Cervellone" in bold + bottone "Nuova chat" (outline, non pieno)
- **Conversazione**: `hover:bg-gray-100`, padding generoso
- **Conversazione attiva**: `bg-blue-50 border-l-2 border-blue-500`
- **Bottoni rinomina/cancella**: `text-gray-400 hover:text-gray-600` (visibili su sfondo chiaro)
- **Footer**: "Esci" in `text-gray-500 hover:text-gray-700`
- **Mobile overlay**: sfondo chiaro (non scuro)
- **Bordo bottom conversazioni**: `border-gray-100` (leggero)

## 3. Messaggi

### Messaggio utente (destra)
- Allineamento: `justify-end` (resta)
- Sfondo: `bg-gray-100` (era `bg-blue-600`), `text-gray-800` (era `text-white`)
- Border-radius: `rounded-2xl` (resta)
- Max-width: `max-w-[75%]`
- Label "Tu" sopra il messaggio: `text-xs text-gray-500 font-medium mb-1 text-right`

### Messaggio assistente (sinistra)
- Layout: flex row con avatar a sinistra
- Avatar: logo Cervellone 28px in un cerchio `bg-gray-100 rounded-full p-1`, flex-shrink-0
- Testo: sfondo `bg-white`, nessun bordo, nessuna ombra (era `shadow-sm border border-gray-100`)
- Max-width: `max-w-[85%]`
- Nessuna label sopra (avatar basta)

### Spaziatura
- Gap tra messaggi: `space-y-6` (era `space-y-4`)

## 4. Input area (floating centrato)

### Da (attuale)
- Container pieno: `bg-white border-t border-gray-200 px-4 py-3`
- Textarea: `bg-gray-100 rounded-2xl`
- Bottoni fuori dalla textarea

### A (nuovo)
- Container: `px-4 py-4` senza border-top, senza sfondo (trasparente)
- Box interno: `max-w-3xl mx-auto bg-white border border-gray-300 rounded-2xl shadow-sm px-4 py-3`
- Textarea dentro il box: `bg-transparent border-none outline-none`, niente ring on focus
- Bottoni (allega, microfono, invio) tutti dentro il box, in una riga flex:
  - Riga superiore: textarea (flex-1)
  - Riga inferiore: [allega] [microfono] ... [invio] — allineati dentro il box
- Hint sotto il box: `text-xs text-gray-400 text-center mt-2`

### Layout interno input box
```
+---------------------------------------------+
| [textarea multiline]                        |
|                                             |
| [clip] [mic] [audio-levels]    ... [send]   |
+---------------------------------------------+
  Invio per mandare - Shift+Invio per a capo
```

## 5. Welcome screen (chat vuota)

- Logo Cervellone 80px centrato (resta)
- "Ciao Raffaele!" — `text-xl font-semibold text-gray-700`
- "Come posso aiutarti oggi?" — `text-sm text-gray-400`
- 4 suggestion chips: `bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-blue-300 hover:bg-blue-50` — layout `grid grid-cols-2 gap-3 max-w-md`
- Testo "trascina file" sotto: `text-xs text-gray-300`
- Tutto centrato verticalmente nella viewport

## 6. Indicatore loading

- Attuale: tre pallini animati `•••` — resta uguale, funziona bene

## 7. Bottoni download (TXT/MD)

- Restano invariati, solo colori aggiornati se necessario per coerenza con lo sfondo bianco

## 8. File allegati pending

- Stile attuale va bene, già coerente con il nuovo design (bg-gray-100 rounded)

## 9. Drag & drop overlay

- Resta invariato (bg-blue-50 con bordo tratteggiato)

## 10. Modale ZIP

- Resta invariata (non è parte del redesign chat)

---

## Riepilogo cambiamenti

| Elemento | Prima | Dopo |
|----------|-------|------|
| Header | `bg-gray-900` fisso | Rimosso (logo in sidebar) |
| Sfondo | `bg-gray-50` | `bg-white` |
| Sidebar | `bg-gray-900` scura | `bg-white` chiara con bordo |
| Msg utente | Bolla `bg-blue-600 text-white` | `bg-gray-100 text-gray-800` + label "Tu" |
| Msg assistente | `shadow-sm border` | Avatar + testo piatto, nessuna ombra |
| Input | Barra piena border-top | Box floating centrato con bordo e ombra |
| Messaggi container | Full width | `max-w-3xl mx-auto` |

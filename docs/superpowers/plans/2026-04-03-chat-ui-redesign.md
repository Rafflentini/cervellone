# Chat UI Redesign — Stile Claude AI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ridisegnare l'interfaccia chat del Cervellone ispirandosi a Claude AI web — sidebar chiara, messaggi senza bolle con avatar, input floating centrato, nessun header fisso.

**Architecture:** Modifiche solo al JSX/Tailwind in `src/app/chat/page.tsx`. Nessuna modifica alla logica (streaming, API, file, conversazioni). I componenti SplitPanel, DocumentPreviewPanel, MarkdownRenderer restano invariati.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4

---

### Task 1: Sidebar chiara

**Files:**
- Modify: `src/app/chat/page.tsx:826-871` (sidebar JSX)

- [ ] **Step 1: Aggiorna sidebar container**

Sostituire le classi della sidebar da scura a chiara:

```tsx
{/* PRIMA */}
<div className={`fixed inset-y-0 left-0 z-40 w-72 bg-gray-900 text-white transform transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 md:flex md:flex-col`}>

{/* DOPO */}
<div className={`fixed inset-y-0 left-0 z-40 w-72 bg-white border-r border-gray-200 text-gray-800 transform transition-transform duration-200 ${showSidebar ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 md:flex md:flex-col`}>
```

- [ ] **Step 2: Aggiorna header sidebar**

```tsx
{/* PRIMA */}
<div className="flex items-center justify-between p-4 border-b border-gray-700">
  <h2 className="font-bold text-sm">Conversazioni</h2>
  <button onClick={newChat} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">
    + Nuova
  </button>
</div>

{/* DOPO */}
<div className="flex items-center justify-between p-4 border-b border-gray-100">
  <div className="flex items-center gap-2">
    <CervelloneLogo size={28} />
    <span className="font-bold text-sm text-gray-800">Cervellone</span>
  </div>
  <button onClick={newChat} className="border border-gray-300 hover:bg-gray-100 text-gray-700 text-xs px-3 py-1.5 rounded-lg transition-colors">
    + Nuova
  </button>
</div>
```

- [ ] **Step 3: Aggiorna lista conversazioni**

```tsx
{/* PRIMA */}
{conversations.length === 0 && (
  <p className="text-gray-500 text-xs text-center mt-8 px-4">Nessuna conversazione.<br />Inizia a scrivere!</p>
)}

{/* DOPO */}
{conversations.length === 0 && (
  <p className="text-gray-400 text-xs text-center mt-8 px-4">Nessuna conversazione.<br />Inizia a scrivere!</p>
)}
```

Ogni conversazione:

```tsx
{/* PRIMA */}
<div
  key={conv.id}
  onClick={() => openConversation(conv)}
  className={`group w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800 transition-colors cursor-pointer flex items-center ${currentConvId === conv.id ? 'bg-gray-800' : ''}`}
>
  <div className="flex-1 min-w-0">
    <p className="text-sm truncate">{conv.title}</p>
    <p className="text-xs text-gray-500 mt-0.5">{formatDate(conv.updated_at)}</p>
  </div>

{/* DOPO */}
<div
  key={conv.id}
  onClick={() => openConversation(conv)}
  className={`group w-full text-left px-3 py-3 border-b border-gray-100 hover:bg-gray-100 transition-colors cursor-pointer flex items-center rounded-lg mx-1 ${currentConvId === conv.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}
>
  <div className="flex-1 min-w-0">
    <p className="text-sm truncate text-gray-800">{conv.title}</p>
    <p className="text-xs text-gray-400 mt-0.5">{formatDate(conv.updated_at)}</p>
  </div>
```

Bottoni rinomina/cancella:

```tsx
{/* PRIMA */}
<button ... className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 ...">
{/* DOPO */}
<button ... className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-500 ...">

{/* PRIMA */}
<button ... className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 ...">
{/* DOPO */}
<button ... className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 ...">
```

- [ ] **Step 4: Aggiorna footer sidebar**

```tsx
{/* PRIMA */}
<div className="p-4 border-t border-gray-700">
  <button onClick={logout} className="text-gray-400 hover:text-white text-sm transition-colors w-full text-left">Esci</button>
</div>

{/* DOPO */}
<div className="p-4 border-t border-gray-100">
  <button onClick={logout} className="text-gray-500 hover:text-gray-700 text-sm transition-colors w-full text-left">Esci</button>
</div>
```

- [ ] **Step 5: Aggiorna overlay mobile**

```tsx
{/* PRIMA */}
<div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setShowSidebar(false)} />

{/* DOPO — resta ok, l'overlay scuro funziona anche con sidebar chiara */}
```

Nessuna modifica necessaria.

- [ ] **Step 6: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "ui: light sidebar with clean borders and active state"
```

---

### Task 2: Rimuovere header e aggiornare sfondo

**Files:**
- Modify: `src/app/chat/page.tsx:889-904` (header), `src/app/chat/page.tsx:824` (container)

- [ ] **Step 1: Cambiare sfondo pagina**

```tsx
{/* PRIMA */}
<div className="flex h-full bg-gray-50">

{/* DOPO */}
<div className="flex h-full bg-white">
```

- [ ] **Step 2: Rimuovere l'header scuro**

Rimuovere intero blocco header (righe ~891-904):

```tsx
{/* RIMUOVERE TUTTO QUESTO: */}
<header className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between shadow-md flex-shrink-0">
  <div className="flex items-center gap-3">
    <button onClick={() => setShowSidebar(!showSidebar)} className="md:hidden text-gray-400 hover:text-white">
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
    <CervelloneLogo size={32} />
    <span className="font-bold text-lg">Cervellone</span>
  </div>
  <button onClick={newChat} className="text-gray-400 hover:text-white text-sm transition-colors">
    Nuova chat
  </button>
</header>
```

Sostituire con un bottone hamburger minimal per mobile:

```tsx
{/* Hamburger mobile — visibile solo su mobile */}
<div className="md:hidden flex items-center px-4 py-2 flex-shrink-0">
  <button onClick={() => setShowSidebar(!showSidebar)} className="text-gray-500 hover:text-gray-700">
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  </button>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "ui: remove dark header, white background, mobile hamburger"
```

---

### Task 3: Messaggi — nuovo stile

**Files:**
- Modify: `src/app/chat/page.tsx:942-1015` (rendering messaggi)

- [ ] **Step 1: Aggiornare spaziatura messaggi**

```tsx
{/* PRIMA */}
<div className={`relative flex-1 overflow-y-auto px-4 py-4 space-y-4 transition-colors ...`}>

{/* DOPO */}
<div className={`relative flex-1 overflow-y-auto px-4 py-6 space-y-6 transition-colors ...`}>
```

- [ ] **Step 2: Ridisegnare il rendering dei messaggi**

Sostituire il blocco di rendering messaggi (da riga ~942). Il codice completo:

```tsx
{messages.map((msg, i) => (
  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} max-w-3xl mx-auto`}>
    {/* Avatar assistente */}
    {msg.role === 'assistant' && (
      <div className="flex-shrink-0 mr-3 mt-1">
        <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center">
          <CervelloneLogo size={18} />
        </div>
      </div>
    )}
    <div className={`${
      msg.role === 'user'
        ? 'max-w-[75%]'
        : 'max-w-[85%] flex-1 min-w-0'
    }`}>
      {/* Label "Tu" per messaggi utente */}
      {msg.role === 'user' && (
        <p className="text-xs text-gray-500 font-medium mb-1 text-right">Tu</p>
      )}
      <div className={`rounded-2xl text-sm leading-relaxed ${
        msg.role === 'user'
          ? 'bg-gray-100 text-gray-800 rounded-br-sm px-4 py-3'
          : 'text-gray-800 px-1 py-1'
      }`}>
        {msg.files && msg.files.length > 0 && (
          <div className={`mb-2 flex flex-wrap gap-2 ${msg.role === 'user' ? '' : 'px-3'}`}>
            {msg.files.map((f, fi) =>
              f.isImage ? (
                <img key={fi} src={f.preview} alt={f.name} className="max-h-40 max-w-full rounded-lg object-cover" />
              ) : (
                <div key={fi} className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${
                  msg.role === 'user' ? 'bg-gray-200/60 text-gray-600' : 'bg-gray-100 text-gray-600'
                }`}>
                  <span>{f.isPdf ? '📄' : '📝'}</span>
                  <span className="truncate max-w-[120px]">{f.name}</span>
                </div>
              )
            )}
          </div>
        )}
        {msg.role === 'assistant' ? (
          <>
            {parseDocumentBlocks(msg.text).map((block, bi) =>
              block.type === 'document' ? (
                <button
                  key={bi}
                  onClick={() => setPreviewHtml(block.content)}
                  className="my-2 w-full text-left bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 hover:from-blue-100 hover:to-indigo-100 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-blue-800">Documento generato</p>
                      <p className="text-xs text-blue-500 group-hover:text-blue-600">Clicca per aprire anteprima</p>
                    </div>
                    <svg className="w-5 h-5 text-blue-400 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              ) : (
                <MarkdownRenderer key={bi} content={block.content} />
              )
            )}
          </>
        ) : (
          <span className="whitespace-pre-wrap">{msg.text}</span>
        )}
        {msg.role === 'assistant' && loading && i === messages.length - 1 && msg.text === '' && (
          <span className="inline-flex gap-1">
            <span className="animate-bounce">•</span>
            <span className="animate-bounce [animation-delay:0.1s]">•</span>
            <span className="animate-bounce [animation-delay:0.2s]">•</span>
          </span>
        )}
        {/* Bottoni download */}
        {msg.role === 'assistant' && msg.text.length > 200 && !(loading && i === messages.length - 1) && (
          <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-gray-100">
            <button onClick={() => downloadAsFile(msg.text, 'txt', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
              TXT
            </button>
            <button onClick={() => downloadAsFile(msg.text, 'md', i)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
              MD
            </button>
          </div>
        )}
      </div>
    </div>
  </div>
))}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "ui: messages with avatar, user label, no bubbles"
```

---

### Task 4: Input floating centrato

**Files:**
- Modify: `src/app/chat/page.tsx:1019-1106` (input area)

- [ ] **Step 1: Ridisegnare l'area input**

Sostituire l'intero blocco input (da `{/* Input */}`) con:

```tsx
{/* Input floating */}
<div className="px-4 py-4 flex-shrink-0">
  {/* File pendenti */}
  {pendingFiles.length > 0 && (
    <div className="flex flex-wrap gap-2 mb-2 max-w-3xl mx-auto">
      {pendingFiles.map((f, i) => (
        <div key={i} className="relative">
          {f.isImage ? (
            <>
              <img src={f.preview} alt={f.name} className="h-16 w-16 object-cover rounded-xl border border-gray-200" />
              <button onClick={() => removeFile(i)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center">×</button>
            </>
          ) : (
            <div className="flex items-center gap-1 bg-gray-100 rounded-xl px-3 py-2 text-xs text-gray-700 border border-gray-200">
              <span>{f.isPdf ? '📄' : '📝'}</span>
              <span className="truncate max-w-[100px]">{f.name}</span>
              <button onClick={() => removeFile(i)} className="text-red-400 hover:text-red-600 ml-1">×</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )}

  <input
    ref={fileInputRef}
    type="file"
    accept="image/*,.pdf,.docx,.doc,.zip"
    multiple
    className="hidden"
    onChange={handleFileInput}
  />

  {/* Box input floating */}
  <div className="max-w-3xl mx-auto border border-gray-300 rounded-2xl shadow-sm bg-white px-4 py-3 focus-within:border-blue-400 focus-within:shadow-md transition-all">
    <textarea
      ref={textareaRef}
      value={input}
      onChange={(e) => { setInput(e.target.value); autoResize() }}
      onKeyDown={handleKeyDown}
      placeholder={isRecording ? 'Sto ascoltando...' : 'Scrivi un messaggio...'}
      rows={1}
      className={`w-full resize-none text-gray-900 placeholder-gray-400 text-sm outline-none bg-transparent max-h-40 ${isRecording ? 'placeholder-red-400' : ''}`}
    />
    <div className="flex items-center justify-between mt-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className="text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors"
          title="Allega file"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <button
          onClick={toggleVoice}
          disabled={loading}
          className={`transition-colors ${isRecording ? 'text-red-500' : 'text-gray-400 hover:text-gray-600 disabled:opacity-40'}`}
          title={isRecording ? 'Ferma registrazione' : 'Dettatura vocale'}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </button>
        {isRecording && (
          <div className="flex items-end gap-[3px] h-5">
            {audioLevels.map((level, idx) => (
              <div
                key={idx}
                className="w-[3px] rounded-full bg-red-500 transition-all duration-75"
                style={{ height: `${Math.max(4, level * 20)}px` }}
              />
            ))}
          </div>
        )}
      </div>
      <button
        onClick={sendMessage}
        disabled={loading || (!input.trim() && pendingFiles.length === 0)}
        className="bg-gray-800 hover:bg-gray-900 disabled:opacity-30 text-white rounded-full w-8 h-8 flex items-center justify-center transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
        </svg>
      </button>
    </div>
  </div>
  <p className="text-center text-xs text-gray-400 mt-2">Invio per mandare · Shift+Invio per a capo · trascina file nella chat</p>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "ui: floating centered input box with controls inside"
```

---

### Task 5: Welcome screen

**Files:**
- Modify: `src/app/chat/page.tsx:923-940` (welcome screen)

- [ ] **Step 1: Aggiornare welcome screen**

```tsx
{messages.length === 0 && (
  <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16 max-w-3xl mx-auto">
    <CervelloneLogo size={80} />
    <div>
      <p className="font-semibold text-gray-700 text-xl">Ciao Raffaele!</p>
      <p className="text-sm text-gray-400 mt-1">Come posso aiutarti oggi?</p>
      <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
        {['Genera un POS cantiere', 'Aiutami con un computo metrico', 'Scrivi un post per i social', 'Calcola un preventivo ponteggi'].map(s => (
          <button key={s} onClick={() => setInput(s)}
            className="bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-blue-300 hover:bg-blue-50 transition-colors text-gray-600 text-left text-sm">
            {s}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-300 mt-6">Puoi anche trascinare file o ZIP nella chat</p>
    </div>
  </div>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/chat/page.tsx
git commit -m "ui: cleaner welcome screen with updated styling"
```

---

### Task 6: Pulizia — rimuovere commenti DEBUG

**Files:**
- Modify: `src/app/chat/page.tsx:479-493` (debug logs in sendMessage)
- Modify: `src/app/api/chat/route.ts:174` (debug log in API)

- [ ] **Step 1: Rimuovere debug logs dal frontend**

Rimuovere righe 479-493 in `src/app/chat/page.tsx`:

```tsx
// RIMUOVERE:
// DEBUG: log cosa viene mandato all'API
for (const m of apiMessages) {
  if (Array.isArray(m.content)) {
    const types = (m.content as Record<string, unknown>[]).map((b) => {
      if (b.type === 'document' || b.type === 'image') {
        const src = b.source as Record<string, unknown> | undefined
        return `${b.type}(data: ${src?.data ? String(src.data).length + ' chars' : 'VUOTO!'})`
      }
      return b.type
    })
    console.log(`SEND → ${m.role}: [${types.join(', ')}]`)
  } else {
    console.log(`SEND → ${m.role}: "${String(m.content).slice(0, 80)}"`)
  }
}
```

- [ ] **Step 2: Rimuovere debug log dalla API route**

In `src/app/api/chat/route.ts` rimuovere riga ~174:

```tsx
// RIMUOVERE:
// DEBUG: log cosa arriva dal frontend
console.log('CHAT ricevuto:', rawMessages?.length, 'messaggi')
```

- [ ] **Step 3: Rimuovere anche il console.log body size**

In `src/app/chat/page.tsx`, rimuovere:

```tsx
// RIMUOVERE:
const bodySizeMB = (new Blob([jsonBody]).size / (1024 * 1024)).toFixed(1)
console.log(`CHAT body size: ${bodySizeMB} MB`)
```

Mantenere solo `const jsonBody = JSON.stringify(...)`.

- [ ] **Step 4: Commit**

```bash
git add src/app/chat/page.tsx src/app/api/chat/route.ts
git commit -m "cleanup: remove debug console.log statements"
```

---

### Task 7: Verifica visiva

- [ ] **Step 1: Chiedere all'utente di avviare il server dev**

L'utente deve avviare `npm run dev` manualmente da PowerShell (node.exe non ha permessi dalla bash).

- [ ] **Step 2: Verificare su http://localhost:3000**

Checklist visiva:
- [ ] Sidebar chiara con bordo destro
- [ ] Logo Cervellone in sidebar
- [ ] Conversazione attiva con sfondo blue-50
- [ ] Nessun header scuro
- [ ] Hamburger mobile visibile solo su mobile
- [ ] Messaggi utente a destra con sfondo grigio chiaro + label "Tu"
- [ ] Messaggi assistente a sinistra con avatar Cervellone
- [ ] Input floating centrato con bordo e ombra
- [ ] Bottoni allega/microfono/invio dentro il box input
- [ ] Welcome screen centrata con suggestion chips
- [ ] SplitPanel/DocumentPreviewPanel funzionante come prima

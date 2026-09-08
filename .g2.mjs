import fs from "fs";
const p = "src/app/api/conversations/[id]/messages/route.test.ts";
let s = fs.readFileSync(p, "utf8");
function sost(v, n) { if (!s.includes(v)) throw new Error("ancora: " + v.slice(0, 60)); s = s.replace(v, n); }

// Dal 9 set questa rotta accetta solo 'user': i test che usavano 'assistant'
// misuravano dedup ed embedding, non il ruolo. Cambiano ruolo, non intento.
sost(`      req({ role: 'assistant', content: 'Contenzioso Blasi: la controreplica poggia sull articolo 5.1 del contratto.' }, getAuthToken()),`,
     `      req({ role: 'user', content: 'Contenzioso Blasi: la controreplica poggia sull articolo 5.1 del contratto.' }, getAuthToken()),`);
sost(`    expect(role).toBe('assistant')`, `    expect(role).toBe('user')`);
sost(`  it('NON scarta una risposta breve ripetuta del bot su un altro argomento', async () => {
    duplicatoEsistente = { id: 'msg-fatto-precedente' }

    const { POST } = await import('./route')
    await POST(req({ role: 'assistant', content: 'Fatto.' }, getAuthToken()), params)`,
`  it('NON scarta un messaggio breve ripetuto su un altro argomento', async () => {
    duplicatoEsistente = { id: 'msg-fatto-precedente' }

    const { POST } = await import('./route')
    await POST(req({ role: 'user', content: 'Fatto.' }, getAuthToken()), params)`);
sost(`      req({ role: 'assistant', content: 'Un testo completamente diverso dal precedente, abbastanza lungo.' }, getAuthToken()),`,
     `      req({ role: 'user', content: 'Un testo completamente diverso dal precedente, abbastanza lungo.' }, getAuthToken()),`);
fs.writeFileSync(p, s);
console.log("ok");

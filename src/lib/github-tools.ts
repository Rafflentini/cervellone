/**
 * lib/github-tools.ts — Self-healing tools (spec 2026-05-04).
 *
 * Cervellone può:
 * - Leggere il proprio codice da GitHub (read-only)
 * - Proporre modifiche aprendo PR (mai push diretto su main)
 * - Verificare lo stato del deploy Vercel di un commit
 *
 * Pattern human-in-the-loop: Cervellone propone, l'Ingegnere approva via merge.
 *
 * Setup richiesto: GITHUB_TOKEN (PAT scope `repo`) in env Vercel.
 */

const GITHUB_API = 'https://api.github.com'
const REPO_OWNER = 'Rafflentini'
const REPO_NAME = 'cervellone'
const REPO_FULL = `${REPO_OWNER}/${REPO_NAME}`

// Vercel project context per deploy status
const VERCEL_PROJECT_ID = 'prj_82oAdncoRjfm5LulvBgzWbel5Pva'
const VERCEL_TEAM_ID = 'team_QOxzPu6kcaxY8Jdc45arGmgL'

// File che il bot NON può modificare via PR (sicurezza)
// Il bot può AGGIUNGERE/ESTENDERE tool, ma MAI toccare secrets, CI, migration, auth.
const PROTECTED_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.github/', // tutto CI/workflows
  'package.json', // troppo critico, modifiche manuali
  'package-lock.json',
  'pnpm-lock.yaml', // lockfile alternativo
  'yarn.lock', // lockfile alternativo
  'supabase/migrations/', // schema DB, mai automatico
  'src/lib/auth', // auth (file o cartella)
  'src/app/api/auth', // route auth reali (route.ts, google/, google/callback/)
  'src/lib/google-oauth.ts', // gestione OAuth
  'src/proxy.ts', // middleware/proxy
]

function isProtectedPath(path: string): boolean {
  // Normalizza eventuale "./" o slash iniziale
  const p = path.replace(/^\.?\//, '')
  // BUG 2: tratta come protetto/invalido path con traversal, assoluti o segmenti vuoti
  if (p.includes('..') || p.startsWith('/') || p.includes('//')) {
    return true
  }
  // BUG 1: regola difensiva — qualsiasi segmento "auth" è protetto
  if (/(^|\/)auth(\/|\.|$)/.test(p)) {
    return true
  }
  // BUG 3: matching per SEGMENTI di path (non prefisso di stringa)
  return PROTECTED_PATHS.some(protectedPath => {
    const t = protectedPath.replace(/\/$/, '')
    return p === t || p.startsWith(t + '/') || p.split('/').includes(t)
  })
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN non configurato in env Vercel — l\'Ingegnere deve aggiungerlo per abilitare self-healing')
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

// ── github_read_file ──

async function readFile(path: string, ref?: string): Promise<string> {
  console.log(`[GH] readFile path="${path}" ref="${ref || 'main'}"`)
  try {
    const url = `${GITHUB_API}/repos/${REPO_FULL}/contents/${path}${ref ? `?ref=${ref}` : ''}`
    const res = await fetch(url, { headers: ghHeaders() })
    if (!res.ok) {
      const body = await res.text()
      return `Errore GitHub readFile: HTTP ${res.status} — ${body.slice(0, 200)}`
    }
    const data = await res.json() as { content?: string; encoding?: string; size?: number; sha?: string }
    if (data.encoding !== 'base64' || !data.content) {
      return `File "${path}" non leggibile (encoding=${data.encoding})`
    }
    const sizeKB = Math.round((data.size || 0) / 1024)
    if (sizeKB > 100) {
      return `⚠️ File "${path}" troppo grande (${sizeKB}KB > 100KB max). Riduci scope o leggi un file più piccolo.`
    }
    const content = Buffer.from(data.content, 'base64').toString('utf-8')
    return `📄 ${path} (${sizeKB}KB, sha=${data.sha?.slice(0, 7)})\n\n\`\`\`\n${content}\n\`\`\``
  } catch (err) {
    console.error('[GH] readFile ERROR:', err)
    return `Errore lettura file GitHub: ${err instanceof Error ? err.message : err}`
  }
}

// ── github_propose_fix ──

async function proposeFix(
  files: Array<{ path: string; content: string }>,
  branchName: string,
  prTitle: string,
  prBody: string,
): Promise<string> {
  console.log(`[GH] proposeFix files=${files.length} (${files.map(f => f.path).join(', ').slice(0, 120)}) branch="${branchName}" title="${prTitle.slice(0, 50)}"`)

  // 1. Fence: tutti i file devono essere validi e non protetti PRIMA di aprire qualsiasi PR
  if (!Array.isArray(files) || files.length === 0) {
    return `⛔ Nessun file fornito. Passa almeno un { path, content }.`
  }
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path.trim() || typeof f.content !== 'string') {
      return `⛔ File invalido: ogni elemento deve avere { path: string (non vuoto), content: string }.`
    }
    if (isProtectedPath(f.path)) {
      return `⛔ File "${f.path}" è protetto. Non posso proporre modifiche automatiche su file sensibili (.env, .github/CI, package.json, supabase/migrations, auth, proxy). L'Ingegnere deve modificarlo manualmente. PR NON aperta.`
    }
  }

  if (!/^[a-z0-9/_-]+$/i.test(branchName) || branchName.length > 100) {
    return `⛔ Branch name non valido: "${branchName}". Solo a-z, 0-9, _, -, /. Max 100 char. Esempio: "fix/bug-7-streaming"`
  }
  // BUG 5: rifiuta slash iniziale/finale, traversal, doppi slash, suffisso .lock
  if (/(^\/|\/$|\.\.|\/\/|\.lock$)/.test(branchName)) {
    return `⛔ Branch name non valido: "${branchName}". Niente slash iniziale/finale, "..", "//", o suffisso ".lock". Esempio: "fix/bug-7-streaming"`
  }

  try {
    // 2. Get main HEAD SHA
    const mainRefRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/refs/heads/main`,
      { headers: ghHeaders() },
    )
    if (!mainRefRes.ok) {
      const b = await mainRefRes.text()
      return `Errore lettura main HEAD: HTTP ${mainRefRes.status} — ${b.slice(0, 200)}`
    }
    const mainRef = await mainRefRes.json() as { object?: { sha?: string } }
    const mainSha = mainRef.object?.sha
    if (!mainSha) return `Errore: SHA main HEAD non recuperato.`

    // 3. Get base tree SHA dal commit di main
    const mainCommitRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/commits/${mainSha}`,
      { headers: ghHeaders() },
    )
    if (!mainCommitRes.ok) {
      const b = await mainCommitRes.text()
      return `Errore lettura commit main: HTTP ${mainCommitRes.status} — ${b.slice(0, 200)}`
    }
    const mainCommit = await mainCommitRes.json() as { tree?: { sha?: string } }
    const baseTreeSha = mainCommit.tree?.sha
    if (!baseTreeSha) return `Errore: base tree SHA non recuperato.`

    // 4. Crea un blob per ogni file (Git Data API — gestisce nuovi + esistenti uniformemente)
    const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = []
    for (const f of files) {
      const blobRes = await fetch(
        `${GITHUB_API}/repos/${REPO_FULL}/git/blobs`,
        {
          method: 'POST',
          headers: ghHeaders(),
          body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
        },
      )
      if (!blobRes.ok) {
        const b = await blobRes.text()
        return `Errore creando blob per "${f.path}": HTTP ${blobRes.status} — ${b.slice(0, 200)}`
      }
      const blob = await blobRes.json() as { sha?: string }
      if (!blob.sha) return `Errore: blob SHA non recuperato per "${f.path}".`
      treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
    }

    // 5. Crea il tree basato su quello di main
    const treeRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/trees`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      },
    )
    if (!treeRes.ok) {
      const b = await treeRes.text()
      return `Errore creando tree: HTTP ${treeRes.status} — ${b.slice(0, 200)}`
    }
    const tree = await treeRes.json() as { sha?: string }
    const newTreeSha = tree.sha
    if (!newTreeSha) return `Errore: tree SHA non recuperato.`

    // 6. Crea il commit
    const commitRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/commits`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ message: prTitle, tree: newTreeSha, parents: [mainSha] }),
      },
    )
    if (!commitRes.ok) {
      const b = await commitRes.text()
      return `Errore creando commit: HTTP ${commitRes.status} — ${b.slice(0, 200)}`
    }
    const commit = await commitRes.json() as { sha?: string }
    const commitSha = commit.sha
    if (!commitSha) return `Errore: commit SHA non recuperato.`

    // 7. Crea il branch ref puntando al commit
    const createBranchRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/refs`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
      },
    )
    if (!createBranchRes.ok) {
      const errBody = await createBranchRes.text()
      if (createBranchRes.status === 422) {
        return `⛔ Branch "${branchName}" esiste già. Usa un nome diverso o chiudi la PR esistente.`
      }
      return `Errore creando branch: HTTP ${createBranchRes.status} — ${errBody.slice(0, 200)}`
    }

    // 8. Apri la PR (BUG 4: se fallisce, cleanup del branch orfano per permettere retry)
    let pr: { html_url?: string; number?: number }
    try {
      const prRes = await fetch(
        `${GITHUB_API}/repos/${REPO_FULL}/pulls`,
        {
          method: 'POST',
          headers: ghHeaders(),
          body: JSON.stringify({
            title: prTitle.slice(0, 100),
            body: `${prBody}\n\n---\n_PR automatica proposta da Cervellone (suggested fix, ${files.length} file). Da revisionare e approvare prima del merge._`,
            head: branchName,
            base: 'main',
          }),
        },
      )
      if (!prRes.ok) {
        const errBody = await prRes.text()
        // Cleanup best-effort del branch orfano (riusa il pattern di mergePr)
        try {
          await fetch(`${GITHUB_API}/repos/${REPO_FULL}/git/refs/heads/${branchName}`, {
            method: 'DELETE',
            headers: ghHeaders(),
          })
        } catch { /* ignore */ }
        return `Errore aprendo PR: HTTP ${prRes.status} — ${errBody.slice(0, 200)}`
      }
      pr = await prRes.json() as { html_url?: string; number?: number }
    } catch (prErr) {
      // Cleanup best-effort del branch orfano anche su eccezione di rete
      try {
        await fetch(`${GITHUB_API}/repos/${REPO_FULL}/git/refs/heads/${branchName}`, {
          method: 'DELETE',
          headers: ghHeaders(),
        })
      } catch { /* ignore */ }
      return `Errore aprendo PR: ${prErr instanceof Error ? prErr.message : prErr}`
    }
    console.log(`[GH] proposeFix PR #${pr.number} created: ${pr.html_url} (${files.length} file)`)
    return `✅ PR #${pr.number} aperta su ${REPO_FULL} (${files.length} file: ${files.map(f => f.path).join(', ')})\n👉 ${pr.html_url}\n\nL'Ingegnere deve revisionare e mergiare manualmente. Niente push diretto su main.`
  } catch (err) {
    console.error('[GH] proposeFix ERROR:', err)
    return `Errore proponendo fix: ${err instanceof Error ? err.message : err}`
  }
}

// ── vercel_deploy_status ──

async function deployStatus(commitSha: string): Promise<string> {
  console.log(`[VERCEL] deployStatus commit="${commitSha.slice(0, 7)}"`)
  try {
    const token = process.env.VERCEL_TOKEN
    if (!token) {
      return '⚠️ VERCEL_TOKEN non configurato. Setup richiesto per verificare deploy.'
    }
    const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&limit=10`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text()
      return `Errore Vercel API: HTTP ${res.status} — ${body.slice(0, 200)}`
    }
    const data = await res.json() as {
      deployments?: Array<{
        uid?: string
        url?: string
        state?: string
        createdAt?: number
        ready?: number
        meta?: { githubCommitSha?: string; githubCommitMessage?: string }
        target?: string
      }>
    }
    const matches = (data.deployments || []).filter(d =>
      d.meta?.githubCommitSha?.startsWith(commitSha) || commitSha.startsWith(d.meta?.githubCommitSha || '~~')
    )
    if (matches.length === 0) {
      return `Nessun deploy Vercel trovato per commit ${commitSha.slice(0, 7)}. Potrebbe non essere ancora partito o filtrato.`
    }
    const lines = matches.slice(0, 3).map(d => {
      const created = d.createdAt ? new Date(d.createdAt).toLocaleString('it-IT') : '?'
      const dur = d.ready && d.createdAt ? `${Math.round((d.ready - d.createdAt) / 1000)}s` : 'in corso'
      const tgt = d.target || 'preview'
      return `[${tgt}] ${d.state} — created ${created} — duration ${dur}\n   url: https://${d.url}`
    })
    return `Deploy per commit ${commitSha.slice(0, 7)}:\n${lines.join('\n')}`
  } catch (err) {
    console.error('[VERCEL] deployStatus ERROR:', err)
    return `Errore verifica deploy: ${err instanceof Error ? err.message : err}`
  }
}

// ── github_merge_pr ──

async function mergePr(prNumber: string, mergeMethod: string = 'squash'): Promise<string> {
  const num = parseInt(prNumber, 10)
  if (!Number.isInteger(num) || num <= 0) {
    return `⛔ PR number invalido: "${prNumber}"`
  }
  if (!['squash', 'merge', 'rebase'].includes(mergeMethod)) {
    return `⛔ merge method invalido: "${mergeMethod}". Usa squash | merge | rebase.`
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return '⚠️ GITHUB_TOKEN non configurato.'
  }
  console.log(`[GH] mergePr #${num} method=${mergeMethod}`)
  try {
    // 1. Fetch PR per safety check: autore + stato + mergeable
    const prRes = await fetch(`https://api.github.com/repos/${REPO_FULL}/pulls/${num}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
    })
    if (!prRes.ok) return `Errore GitHub fetch PR #${num}: HTTP ${prRes.status}`
    const pr = await prRes.json() as {
      state: string
      merged: boolean
      mergeable: boolean | null
      mergeable_state: string
      user: { login: string }
      head: { ref: string }
      base: { ref: string }
      title: string
    }
    if (pr.merged) return `⚠️ PR #${num} è già mergiata.`
    if (pr.state !== 'open') return `⛔ PR #${num} è in stato "${pr.state}" — solo PR open mergiabili.`
    if (pr.base.ref !== 'main') return `⛔ PR #${num} ha base "${pr.base.ref}" diversa da "main" — rifiutato per safety.`
    if (pr.mergeable === false) return `⛔ PR #${num} ha conflitti (mergeable_state="${pr.mergeable_state}"). Risolvili prima.`
    // Note: mergeable può essere null se GitHub non ha ancora calcolato — accettiamo, GitHub bloccherà se conflict reale

    // 2. Esegui merge via API
    const mergeRes = await fetch(`https://api.github.com/repos/${REPO_FULL}/pulls/${num}/merge`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merge_method: mergeMethod,
        commit_title: `${pr.title} (#${num})`,
      }),
    })
    if (!mergeRes.ok) {
      const body = await mergeRes.text()
      return `Errore merge PR #${num}: HTTP ${mergeRes.status} — ${body.slice(0, 300)}`
    }
    const mergeData = await mergeRes.json() as { sha: string; merged: boolean; message: string }
    if (!mergeData.merged) {
      return `⛔ Merge fallito: ${mergeData.message}`
    }

    // 3. Tenta delete branch (best-effort, non fatale se fallisce)
    try {
      await fetch(`https://api.github.com/repos/${REPO_FULL}/git/refs/heads/${pr.head.ref}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
    } catch { /* ignore */ }

    console.log(`[GH] mergePr #${num} ok sha=${mergeData.sha.slice(0, 7)}`)
    return `✅ PR #${num} mergiata su main (${mergeMethod}). Commit ${mergeData.sha.slice(0, 7)}. Branch ${pr.head.ref} cancellato. Vercel deploy partirà tra pochi secondi — usa vercel_deploy_status(${mergeData.sha.slice(0, 7)}) per verificare quando READY.`
  } catch (err) {
    console.error('[GH] mergePr ERROR:', err)
    return `Errore merge: ${err instanceof Error ? err.message : err}`
  }
}

// ── Definizioni tool per Anthropic API ──

export const GITHUB_TOOLS = [
  {
    name: 'github_read_file',
    description: `Legge il contenuto di un file dal repo GitHub ${REPO_FULL} (codice sorgente di Cervellone). Usa per ispezionare il proprio codice quando l'Ingegnere segnala un bug o chiede come funziona una feature. Read-only, sicuro. Limite 100KB.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path relativo al root del repo, es. "src/lib/claude.ts"' },
        ref: { type: 'string', description: 'Branch/commit (default: main). Opzionale.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'github_propose_fix',
    description: `Propone una modifica al codice creando branch + commit + PR su GitHub. Può CREARE nuovi file e MODIFICARE più file in un solo PR (es. aggiungere un nuovo tool = nuovo file + modifica del registry che lo importa). NON pusha mai su main direttamente — l'Ingegnere deve approvare la PR. Usa SOLO per fix/feature concreti con motivazione tecnica chiara basata su log d'errore o bug riprodotto. File protetti (.env, .github/CI, package.json, supabase/migrations, auth, proxy) esclusi per sicurezza.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'array',
          description: 'Uno o più file da creare/modificare in un solo PR. Ogni elemento: { path, content } con il contenuto COMPLETO del file (non diff). Per i file esistenti passa il contenuto intero aggiornato.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path relativo al root del repo, es. "src/lib/foo-tools.ts"' },
              content: { type: 'string', description: 'Contenuto NUOVO completo del file (non diff)' },
            },
            required: ['path', 'content'],
          },
        },
        branch_name: { type: 'string', description: 'Nome del branch, es. "fix/bug-7-streaming". Solo a-z, 0-9, _, -, /. Max 100 char.' },
        pr_title: { type: 'string', description: 'Titolo PR, max 100 char, formato "fix(area): cosa"' },
        pr_body: { type: 'string', description: 'Markdown strutturato: ## Problema (cosa) + ## Causa (perché) + ## Fix (come) + ## Test (come verificare). Cita log Vercel se disponibili.' },
      },
      required: ['files', 'branch_name', 'pr_title', 'pr_body'],
    },
  },
  {
    name: 'vercel_deploy_status',
    description: `Verifica lo stato del deploy Vercel di un commit specifico. Usa dopo aver visto un merge della tua PR per confermare che il fix è andato live. Restituisce stato (READY/BUILDING/ERROR), URL deploy, durata.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        commit_sha: { type: 'string', description: 'SHA completo o short del commit da verificare' },
      },
      required: ['commit_sha'],
    },
  },
  {
    name: 'github_merge_pr',
    description: `Mergia una PR aperta nel repo ${REPO_FULL}. Safety: solo PR open verso main, no conflitti, autore qualunque (di solito te stesso). Default merge_method=squash (clean history). Cancella branch dopo merge. Usa SOLO per chiudere proprie PR già aperte via github_propose_fix quando l'Ingegnere è impedito (es. cantiere, mobile, no GitHub web). NON mergiare PR umane senza esplicita richiesta dell'Ingegnere.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        pr_number: { type: 'string', description: 'Numero PR (es. "5", "12")' },
        merge_method: { type: 'string', description: 'OPZIONALE — squash (default) | merge | rebase. Squash crea 1 commit pulito su main.' },
      },
      required: ['pr_number'],
    },
  },
]

// ── Esecuzione tool ──

export async function executeGithubTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
): Promise<string> {
  switch (name) {
    case 'github_read_file':
      return readFile(input.path, input.ref)
    case 'github_propose_fix': {
      // input.files può arrivare come array (chiamata diretta) o come stringa JSON
      // (alcuni wrapper stringificano i valori non-string prima del dispatch).
      let files: unknown = input.files
      if (typeof files === 'string') {
        try {
          files = JSON.parse(files)
        } catch {
          return `⛔ "files" è una stringa non-JSON valida. Atteso array di { path, content }.`
        }
      }
      if (!Array.isArray(files) || files.length === 0) {
        return `⛔ "files" deve essere un array non vuoto di { path, content }.`
      }
      return proposeFix(
        files as Array<{ path: string; content: string }>,
        input.branch_name,
        input.pr_title,
        input.pr_body,
      )
    }
    case 'vercel_deploy_status':
      return deployStatus(input.commit_sha)
    case 'github_merge_pr':
      return mergePr(input.pr_number, input.merge_method || 'squash')
    default:
      return `Tool GitHub "${name}" non riconosciuto.`
  }
}

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
const PROTECTED_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.github/workflows/',
  'package.json', // troppo critico, modifiche manuali
]

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.some(p => path.startsWith(p))
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
  path: string,
  content: string,
  branchName: string,
  prTitle: string,
  prBody: string,
): Promise<string> {
  console.log(`[GH] proposeFix path="${path}" branch="${branchName}" title="${prTitle.slice(0, 50)}"`)

  if (isProtectedPath(path)) {
    return `⛔ File "${path}" è protetto. Non posso proporre modifiche automatiche su file sensibili (.env, workflows, package.json). L'Ingegnere deve modificarlo manualmente.`
  }

  if (!/^[a-z0-9/_-]+$/i.test(branchName) || branchName.length > 100) {
    return `⛔ Branch name non valido: "${branchName}". Solo a-z, 0-9, _, -, /. Max 100 char. Esempio: "fix/bug-7-streaming"`
  }

  try {
    // 1. Get current file SHA on main
    const fileRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/contents/${path}?ref=main`,
      { headers: ghHeaders() },
    )
    if (!fileRes.ok) {
      return `Errore: file "${path}" non trovato su main (HTTP ${fileRes.status}). Crearlo via PR senza sha non ancora supportato — modifica manuale.`
    }
    const fileMeta = await fileRes.json() as { sha?: string }
    const fileSha = fileMeta.sha
    if (!fileSha) return `Errore: SHA del file non recuperato.`

    // 2. Get main HEAD SHA
    const mainRefRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/refs/heads/main`,
      { headers: ghHeaders() },
    )
    if (!mainRefRes.ok) return `Errore lettura main HEAD: HTTP ${mainRefRes.status}`
    const mainRef = await mainRefRes.json() as { object?: { sha?: string } }
    const mainSha = mainRef.object?.sha
    if (!mainSha) return `Errore: SHA main HEAD non recuperato.`

    // 3. Create branch from main
    const createBranchRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/git/refs`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: mainSha,
        }),
      },
    )
    if (!createBranchRes.ok) {
      const errBody = await createBranchRes.text()
      if (createBranchRes.status === 422) {
        return `⛔ Branch "${branchName}" esiste già. Usa un nome diverso o chiudi la PR esistente.`
      }
      return `Errore creando branch: HTTP ${createBranchRes.status} — ${errBody.slice(0, 200)}`
    }

    // 4. Commit file on new branch
    const commitRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/contents/${path}`,
      {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
          message: prTitle,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          sha: fileSha,
          branch: branchName,
        }),
      },
    )
    if (!commitRes.ok) {
      const errBody = await commitRes.text()
      return `Errore commit su branch: HTTP ${commitRes.status} — ${errBody.slice(0, 200)}`
    }

    // 5. Open PR
    const prRes = await fetch(
      `${GITHUB_API}/repos/${REPO_FULL}/pulls`,
      {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({
          title: prTitle.slice(0, 100),
          body: `${prBody}\n\n---\n_PR proposta automaticamente da Cervellone (suggested fix). Da revisionare e approvare prima del merge._`,
          head: branchName,
          base: 'main',
        }),
      },
    )
    if (!prRes.ok) {
      const errBody = await prRes.text()
      return `Errore aprendo PR: HTTP ${prRes.status} — ${errBody.slice(0, 200)}`
    }
    const pr = await prRes.json() as { html_url?: string; number?: number }
    console.log(`[GH] proposeFix PR #${pr.number} created: ${pr.html_url}`)
    return `✅ PR #${pr.number} aperta su ${REPO_FULL}\n👉 ${pr.html_url}\n\nL'Ingegnere deve revisionare e mergiare manualmente. Niente push diretto su main.`
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
    description: `Propone una modifica al codice creando branch + commit + PR su GitHub. NON pusha mai su main direttamente — l'Ingegnere deve approvare la PR. Usa SOLO per fix concreti con motivazione tecnica chiara basata su log d'errore o bug riprodotto. File protetti (.env, workflows, package.json) esclusi per sicurezza.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path del file da modificare (deve esistere su main)' },
        content: { type: 'string', description: 'Contenuto NUOVO completo del file (non diff)' },
        branch_name: { type: 'string', description: 'Nome del branch, es. "fix/bug-7-streaming". Solo a-z, 0-9, _, -, /. Max 100 char.' },
        pr_title: { type: 'string', description: 'Titolo PR, max 100 char, formato "fix(area): cosa"' },
        pr_body: { type: 'string', description: 'Markdown strutturato: ## Problema (cosa) + ## Causa (perché) + ## Fix (come) + ## Test (come verificare). Cita log Vercel se disponibili.' },
      },
      required: ['path', 'content', 'branch_name', 'pr_title', 'pr_body'],
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
]

// ── Esecuzione tool ──

export async function executeGithubTool(
  name: string,
  input: Record<string, string>,
): Promise<string> {
  switch (name) {
    case 'github_read_file':
      return readFile(input.path, input.ref)
    case 'github_propose_fix':
      return proposeFix(
        input.path,
        input.content,
        input.branch_name,
        input.pr_title,
        input.pr_body,
      )
    case 'vercel_deploy_status':
      return deployStatus(input.commit_sha)
    default:
      return `Tool GitHub "${name}" non riconosciuto.`
  }
}

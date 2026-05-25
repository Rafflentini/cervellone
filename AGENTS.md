<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Multi-agent collaboration (Claude Code + Codex)

Two AI agents work on this repo. They never call each other directly — **the GitHub repo
is the only channel between them.**

- **Claude Code = orchestrator.** Owns the backlog, splits work into scoped task specs,
  reviews every PR, and merges. Works in the main checkout on branch `main`.
- **Codex = executor.** Picks up one task spec at a time, implements it on a dedicated
  branch, opens a PR, and reports in the PR description. Works in an isolated git worktree
  (folder `cervellone-codex`, branch `codex/...`) so it never collides with Claude's tree.

## Rules for the executor (Codex)
1. Read this file before writing code (see the Next.js warning above).
2. **One task at a time.** Edit ONLY the files listed in the task spec. If you need others,
   stop and flag it in the PR — do not widen scope on your own.
3. **Never commit or push to `main`.** Per task: branch (`feat/<name>` or `fix/<name>`) from
   an up-to-date base → commit → open a PR. Claude reviews and merges.
4. Before opening the PR: run build and tests; include the result in the PR description.
5. The PR description is your only channel to Claude. Always state: what you did, files
   touched, build/test result, and any doubts or decisions taken.
6. **Never touch:** `.env` / secrets, `package.json` (without explicit OK), CI workflows.

## Coordination
Current ownership and in-flight work are tracked in `COLLAB.md`. Read it before starting,
and never edit files another agent has marked as owned/in-flight.

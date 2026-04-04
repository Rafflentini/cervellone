# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-ui.spec.ts >> Chat UI Redesign (3 aprile 2026) >> logout funziona
- Location: tests\chat-ui.spec.ts:75:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login
Call log:
  - navigating to "http://localhost:3000/login", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | 
  3  | // Helper per autenticarsi
  4  | async function login(page: import('@playwright/test').Page) {
> 5  |   await page.goto('/login')
     |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login
  6  |   await page.fill('input[type="password"]', 'Raffaele2026!')
  7  |   await page.click('button[type="submit"]')
  8  |   await page.waitForURL('**/chat')
  9  | }
  10 | 
  11 | test.describe('Chat UI Redesign (3 aprile 2026)', () => {
  12 |   test.beforeEach(async ({ page }) => {
  13 |     await login(page)
  14 |   })
  15 | 
  16 |   test('welcome screen con logo, saluto e suggerimenti', async ({ page }) => {
  17 |     // Saluto personalizzato
  18 |     await expect(page.locator('text=Ciao Raffaele!')).toBeVisible()
  19 |     await expect(page.locator('text=Come posso aiutarti oggi?')).toBeVisible()
  20 | 
  21 |     // 4 pulsanti suggerimento
  22 |     const suggestions = page.locator('button:has-text("Genera un POS cantiere"), button:has-text("Aiutami con un computo metrico"), button:has-text("Scrivi un post per i social"), button:has-text("Calcola un preventivo ponteggi")')
  23 |     await expect(suggestions.first()).toBeVisible()
  24 | 
  25 |     // Testo drag & drop
  26 |     await expect(page.locator('text=Puoi anche trascinare file o ZIP nella chat')).toBeVisible()
  27 |   })
  28 | 
  29 |   test('sidebar chiara con logo e bottone Nuova', async ({ page }) => {
  30 |     // Sidebar visibile su desktop (md:)
  31 |     const sidebar = page.locator('text=Cervellone').first()
  32 |     await expect(sidebar).toBeVisible()
  33 | 
  34 |     // Bottone nuova conversazione
  35 |     await expect(page.locator('button:has-text("+ Nuova")')).toBeVisible()
  36 | 
  37 |     // Bottone Esci
  38 |     await expect(page.locator('button:has-text("Esci")')).toBeVisible()
  39 |   })
  40 | 
  41 |   test('input floating centrato con attachment e microfono', async ({ page }) => {
  42 |     // Textarea placeholder
  43 |     const textarea = page.locator('textarea[placeholder="Scrivi un messaggio..."]')
  44 |     await expect(textarea).toBeVisible()
  45 | 
  46 |     // Bottone allega (icona clip)
  47 |     await expect(page.locator('button[title="Allega file"]')).toBeVisible()
  48 | 
  49 |     // Bottone voce (icona microfono)
  50 |     await expect(page.locator('button[title="Dettatura vocale"]')).toBeVisible()
  51 | 
  52 |     // Bottone invio (freccia su, disabilitato senza testo)
  53 |     const sendBtn = page.locator('button:has(svg) >> nth=-1').last()
  54 |     // Il bottone invio esiste
  55 |     await expect(page.locator('div.max-w-3xl.mx-auto button.rounded-full')).toBeVisible()
  56 | 
  57 |     // Testo istruzioni sotto input
  58 |     await expect(page.locator('text=Invio per mandare')).toBeVisible()
  59 |   })
  60 | 
  61 |   test('click suggerimento riempie input', async ({ page }) => {
  62 |     const suggestion = page.locator('button:has-text("Genera un POS cantiere")')
  63 |     await suggestion.click()
  64 | 
  65 |     const textarea = page.locator('textarea')
  66 |     await expect(textarea).toHaveValue('Genera un POS cantiere')
  67 |   })
  68 | 
  69 |   test('sfondo bianco (non scuro) - UI redesign', async ({ page }) => {
  70 |     // Il contenitore principale ha bg-white
  71 |     const mainContainer = page.locator('div.bg-white').first()
  72 |     await expect(mainContainer).toBeVisible()
  73 |   })
  74 | 
  75 |   test('logout funziona', async ({ page }) => {
  76 |     await page.click('button:has-text("Esci")')
  77 |     await page.waitForURL('**/login')
  78 |     expect(page.url()).toContain('/login')
  79 |   })
  80 | })
  81 | 
```
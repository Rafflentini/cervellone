import { test, expect } from '@playwright/test'

// Helper per autenticarsi
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.fill('input[type="password"]', 'Raffaele2026!')
  await page.click('button[type="submit"]')
  await page.waitForURL('**/chat')
}

test.describe('Chat UI Redesign (3 aprile 2026)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('welcome screen con logo, saluto e suggerimenti', async ({ page }) => {
    // Saluto personalizzato
    await expect(page.locator('text=Ciao Raffaele!')).toBeVisible()
    await expect(page.locator('text=Come posso aiutarti oggi?')).toBeVisible()

    // 4 pulsanti suggerimento
    const suggestions = page.locator('button:has-text("Genera un POS cantiere"), button:has-text("Aiutami con un computo metrico"), button:has-text("Scrivi un post per i social"), button:has-text("Calcola un preventivo ponteggi")')
    await expect(suggestions.first()).toBeVisible()

    // Testo drag & drop
    await expect(page.locator('text=Puoi anche trascinare file o ZIP nella chat')).toBeVisible()
  })

  test('sidebar chiara con logo e bottone Nuova', async ({ page }) => {
    // Sidebar visibile su desktop (md:)
    const sidebar = page.locator('text=Cervellone').first()
    await expect(sidebar).toBeVisible()

    // Bottone nuova conversazione
    await expect(page.locator('button:has-text("+ Nuova")')).toBeVisible()

    // Bottone Esci
    await expect(page.locator('button:has-text("Esci")')).toBeVisible()
  })

  test('input floating centrato con attachment e microfono', async ({ page }) => {
    // Textarea placeholder
    const textarea = page.locator('textarea[placeholder="Scrivi un messaggio..."]')
    await expect(textarea).toBeVisible()

    // Bottone allega (icona clip)
    await expect(page.locator('button[title="Allega file"]')).toBeVisible()

    // Bottone voce (icona microfono)
    await expect(page.locator('button[title="Dettatura vocale"]')).toBeVisible()

    // Bottone invio (freccia su, disabilitato senza testo)
    const sendBtn = page.locator('button:has(svg) >> nth=-1').last()
    // Il bottone invio esiste
    await expect(page.locator('div.max-w-3xl.mx-auto button.rounded-full')).toBeVisible()

    // Testo istruzioni sotto input
    await expect(page.locator('text=Invio per mandare')).toBeVisible()
  })

  test('click suggerimento riempie input', async ({ page }) => {
    const suggestion = page.locator('button:has-text("Genera un POS cantiere")')
    await suggestion.click()

    const textarea = page.locator('textarea')
    await expect(textarea).toHaveValue('Genera un POS cantiere')
  })

  test('sfondo bianco (non scuro) - UI redesign', async ({ page }) => {
    // Il contenitore principale ha bg-white
    const mainContainer = page.locator('div.bg-white').first()
    await expect(mainContainer).toBeVisible()
  })

  test('logout funziona', async ({ page }) => {
    await page.click('button:has-text("Esci")')
    await page.waitForURL('**/login')
    expect(page.url()).toContain('/login')
  })
})

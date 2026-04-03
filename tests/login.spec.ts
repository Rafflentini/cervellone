import { test, expect } from '@playwright/test'

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    // Pulisci cookie per garantire stato non-autenticato
    await page.context().clearCookies()
  })

  test('mostra la pagina di login con logo e form', async ({ page }) => {
    await page.goto('/login')

    // Logo Cervellone presente
    await expect(page.locator('h1')).toHaveText('Cervellone')
    await expect(page.locator('text=Assistente AI personale')).toBeVisible()

    // Form elementi presenti
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toHaveText('Accedi')
  })

  test('bottone Accedi disabilitato se password vuota', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('button[type="submit"]')).toBeDisabled()
  })

  test('password errata mostra errore', async ({ page }) => {
    await page.goto('/login')

    await page.fill('input[type="password"]', 'password_sbagliata')
    await page.click('button[type="submit"]')

    await expect(page.locator('text=Password errata. Riprova.')).toBeVisible()
  })

  test('password corretta fa redirect a /chat', async ({ page }) => {
    await page.goto('/login')

    await page.fill('input[type="password"]', 'Raffaele2026!')
    await page.click('button[type="submit"]')

    await page.waitForURL('**/chat')
    expect(page.url()).toContain('/chat')
  })

  test('accesso a /chat senza auth redirect a /login', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForURL('**/login')
    expect(page.url()).toContain('/login')
  })

  test('accesso a / senza auth redirect a /login', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL('**/login')
    expect(page.url()).toContain('/login')
  })
})

# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: login.spec.ts >> Login Page >> password errata mostra errore
- Location: tests\login.spec.ts:27:7

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
  3  | test.describe('Login Page', () => {
  4  |   test.beforeEach(async ({ page }) => {
  5  |     // Pulisci cookie per garantire stato non-autenticato
  6  |     await page.context().clearCookies()
  7  |   })
  8  | 
  9  |   test('mostra la pagina di login con logo e form', async ({ page }) => {
  10 |     await page.goto('/login')
  11 | 
  12 |     // Logo Cervellone presente
  13 |     await expect(page.locator('h1')).toHaveText('Cervellone')
  14 |     await expect(page.locator('text=Assistente AI personale')).toBeVisible()
  15 | 
  16 |     // Form elementi presenti
  17 |     await expect(page.locator('input[type="password"]')).toBeVisible()
  18 |     await expect(page.locator('button[type="submit"]')).toBeVisible()
  19 |     await expect(page.locator('button[type="submit"]')).toHaveText('Accedi')
  20 |   })
  21 | 
  22 |   test('bottone Accedi disabilitato se password vuota', async ({ page }) => {
  23 |     await page.goto('/login')
  24 |     await expect(page.locator('button[type="submit"]')).toBeDisabled()
  25 |   })
  26 | 
  27 |   test('password errata mostra errore', async ({ page }) => {
> 28 |     await page.goto('/login')
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login
  29 | 
  30 |     await page.fill('input[type="password"]', 'password_sbagliata')
  31 |     await page.click('button[type="submit"]')
  32 | 
  33 |     await expect(page.locator('text=Password errata. Riprova.')).toBeVisible()
  34 |   })
  35 | 
  36 |   test('password corretta fa redirect a /chat', async ({ page }) => {
  37 |     await page.goto('/login')
  38 | 
  39 |     await page.fill('input[type="password"]', 'Raffaele2026!')
  40 |     await page.click('button[type="submit"]')
  41 | 
  42 |     await page.waitForURL('**/chat')
  43 |     expect(page.url()).toContain('/chat')
  44 |   })
  45 | 
  46 |   test('accesso a /chat senza auth redirect a /login', async ({ page }) => {
  47 |     await page.goto('/chat')
  48 |     await page.waitForURL('**/login')
  49 |     expect(page.url()).toContain('/login')
  50 |   })
  51 | 
  52 |   test('accesso a / senza auth redirect a /login', async ({ page }) => {
  53 |     await page.goto('/')
  54 |     await page.waitForURL('**/login')
  55 |     expect(page.url()).toContain('/login')
  56 |   })
  57 | })
  58 | 
```
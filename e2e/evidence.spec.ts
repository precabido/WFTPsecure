/**
 * Visual evidence capture (§34).
 *
 * Every screenshot comes from the running build, driving the real UI — none is
 * mocked or hand-made. Run with:
 *   npx playwright test evidence --project=desktop-chrome
 *   npx playwright test evidence --project=mobile
 */

import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const EVIDENCE_DIR = join(process.cwd(), 'docs', 'evidence');

let suffix = 'desktop';

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test.beforeEach(async ({}, testInfo) => {
  suffix = testInfo.project.name === 'mobile' ? 'mobile' : 'desktop';
});

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE_DIR, `${name}-${suffix}.png`), fullPage });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const current = await page.locator('html').getAttribute('data-theme');
  if (current !== theme) {
    await page.getByRole('button', { name: /Oscuro|Dark|Claro|Light/ }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('01 home light and dark', async ({ page }) => {
  await page.goto('/');
  await setTheme(page, 'light');
  await shot(page, '01-home-light', true);

  await setTheme(page, 'dark');
  await shot(page, '02-home-dark', true);
});

test('03 composer with files and advanced settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /Archivos|Files/ }).click();

  // Attach real files through the file input, as a user would.
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'deploy-key.pem', mimeType: 'application/x-pem-file', buffer: Buffer.alloc(2048, 7) },
    { name: 'runbook.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(51200, 3) },
    { name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.alloc(18000, 9) },
  ]);
  await expect(page.getByText('deploy-key.pem')).toBeVisible();
  await shot(page, '03-composer-files', true);

  await page.getByRole('button', { name: /Personalizar|Customise/ }).click();
  await page.getByRole('button', { name: /Credenciales|Credentials/ }).click();
  await shot(page, '04-advanced-settings', true);
});

test('05 sealed result with QR and fingerprint', async ({ page }) => {
  await page.goto('/');
  await page.locator('#composer-message').fill(
    'Rotación de credenciales de despliegue.\nUsuario: deploy-bot\nCaduca el viernes.',
  );
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
  await expect(page.getByRole('heading', { name: /Cápsula sellada|Capsule sealed/ })).toBeVisible();
  // Wait for the lazily-loaded QR to render before capturing.
  await expect(page.getByRole('img', { name: /Código QR|QR code/ })).toBeVisible();
  await shot(page, '05-sealed-result', true);
});

test('06 recipient gate, opened content, and destroyed state', async ({ page }) => {
  await page.goto('/');
  await page.locator('#composer-message').fill(
    'API_KEY=sk-demo-not-a-real-key-0000\nDB_URL=postgres://demo@localhost/demo',
  );
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
  const url = await page
    .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
    .inputValue();

  await page.goto(url);
  await expect(page.getByRole('heading', { name: /esperándote|waiting for you/ })).toBeVisible();
  await shot(page, '06-recipient-gate', true);

  await page.getByTestId('open-and-consume').click();
  await expect(page.getByText(/API_KEY=sk-demo/)).toBeVisible({ timeout: 20_000 });
  await shot(page, '07-capsule-opened', true);

  await page.getByRole('button', { name: /Destruir ahora|Destroy now/ }).click();
  await expect(page.getByText(/ya no está disponible|no longer available/)).toBeVisible();
  await shot(page, '08-capsule-destroyed', true);
});

test('09 management panel', async ({ page }) => {
  await page.goto('/');
  await page.locator('#composer-message').fill('capsule under management');
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
  const manageUrl = await page
    .getByRole('textbox', { name: /Enlace privado de gestión|Private management link/ })
    .first()
    .inputValue();

  await page.goto(manageUrl);
  await expect(page.getByText(/Controla la cápsula|Control the capsule/)).toBeVisible();
  await shot(page, '09-management-panel', true);
});

test('10 unavailable state after consumption', async ({ page, browser }) => {
  await page.goto('/');
  await page.locator('#composer-message').fill('already consumed');
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
  const url = await page
    .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
    .inputValue();

  await page.goto(url);
  await page.getByTestId('open-and-consume').click();
  await expect(page.getByText('already consumed')).toBeVisible({ timeout: 20_000 });

  const second = await browser.newContext();
  try {
    const secondPage = await second.newPage();
    await secondPage.goto(url);
    await expect(secondPage.getByText(/ya no está disponible|no longer available/)).toBeVisible();
    await secondPage.screenshot({ path: join(EVIDENCE_DIR, `10-unavailable-${suffix}.png`), fullPage: true });
  } finally {
    await second.close();
  }
});

test('11 password gate and split delivery', async ({ page }) => {
  await page.goto('/');
  await page.locator('#composer-message').fill('protected with a passphrase');
  await page.getByRole('button', { name: /Personalizar|Customise/ }).click();
  await page.locator('input[type="password"]').first().fill('marea-cobre-faro-onix');
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
  const url = await page
    .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
    .inputValue();

  await page.goto(url);
  await expect(page.getByText(/Introduce la contraseña|Enter the password/)).toBeVisible();
  await shot(page, '11-password-gate', true);
});

test('12 HTTP preview warning and security page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Vista previa pública por HTTP|Public preview over HTTP/)).toBeVisible();
  await page.screenshot({
    path: join(EVIDENCE_DIR, `12-http-preview-warning-${suffix}.png`),
    clip: { x: 0, y: 0, width: (page.viewportSize()?.width ?? 1280), height: 140 },
  });

  await page.goto('/security');
  await shot(page, '13-security-page', true);
});

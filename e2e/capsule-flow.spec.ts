/**
 * End-to-end capsule flow in a real browser (§33 "E2E", §39).
 *
 * This is the test that proves the product works as advertised, because it uses
 * the shipped client-side crypto: the browser generates the key, encrypts, and
 * the assertions below check what actually crossed the network.
 */

import { test, expect, type Page } from '@playwright/test';

/** Collect console errors so we can assert the §33 "zero console errors" rule. */
function watchConsole(page: Page): { errors: string[]; requests: string[] } {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => requests.push(request.url()));
  return { errors, requests };
}

const SECRET = 'CINDERLINK-E2E-SECRET-ceniza-marea-4471';

async function createNote(page: Page, text: string): Promise<{ recipientUrl: string; manageUrl: string }> {
  await page.goto('/');
  await page.getByRole('tab', { name: /Nota|Note/ }).click();
  await page.locator('#composer-message').fill(text);
  await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();

  await expect(page.getByRole('heading', { name: /Cápsula sellada|Capsule sealed/ })).toBeVisible();

  const recipientUrl = await page
    .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
    .inputValue();
  const manageUrl = await page
    .getByRole('textbox', { name: /Enlace privado de gestión|Private management link/ })
    .first()
    .inputValue();

  return { recipientUrl, manageUrl };
}

test.describe('note capsule lifecycle', () => {
  test('creates, opens once, and refuses a second open', async ({ page }) => {
    const watcher = watchConsole(page);

    const { recipientUrl } = await createNote(page, SECRET);
    expect(recipientUrl).toContain('/c/');
    // The key must be in the fragment, never in the path or query.
    expect(recipientUrl).toMatch(/#v=1&k=/);
    const [pathPart] = recipientUrl.split('#');
    expect(pathPart).not.toContain('k=');

    // --- The secret must never have been sent to the server -----------------
    // Every request URL the browser made, checked for the plaintext.
    for (const url of watcher.requests) {
      expect(url).not.toContain(SECRET);
    }

    // --- Loading the gate must NOT consume -------------------------------
    await page.goto(recipientUrl);
    await expect(page.getByRole('heading', { name: /esperándote|waiting for you/ })).toBeVisible();

    // Reload several times, as a scanner or a nervous user would.
    for (let i = 0; i < 3; i += 1) {
      await page.reload();
      await expect(page.getByRole('heading', { name: /esperándote|waiting for you/ })).toBeVisible();
    }

    // --- Explicit action consumes ----------------------------------------
    await page.getByTestId('open-and-consume').click();
    await expect(page.getByText(SECRET)).toBeVisible({ timeout: 20_000 });

    expect(watcher.errors, `console errors: ${watcher.errors.join(' | ')}`).toHaveLength(0);
  });

  test('a second person on a fresh device cannot open a consumed capsule', async ({ page, browser }) => {
    const payload = 'second-recipient-must-not-see-this-8823';
    const { recipientUrl } = await createNote(page, payload);

    // First recipient opens it.
    await page.goto(recipientUrl);
    await page.getByTestId('open-and-consume').click();
    await expect(page.getByText(payload)).toBeVisible({ timeout: 20_000 });

    // A different person, on a different device: a fresh browser context with
    // its own storage and its own session. Navigating the SAME page object to
    // the same URL would be a same-document navigation and would prove nothing.
    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await secondPage.goto(recipientUrl);
      await expect(secondPage.getByText(/ya no está disponible|no longer available/)).toBeVisible();
      await expect(secondPage.getByText(payload)).toHaveCount(0);
      // And the gate must not even offer the action.
      await expect(secondPage.getByTestId('open-and-consume')).toHaveCount(0);
    } finally {
      await secondContext.close();
    }
  });

  test('reloading after opening does not re-reveal the content', async ({ page }) => {
    const payload = 'reload-must-not-reveal-5510';
    const { recipientUrl } = await createNote(page, payload);
    await page.goto(recipientUrl);
    await page.getByTestId('open-and-consume').click();
    await expect(page.getByText(payload)).toBeVisible({ timeout: 20_000 });

    // A hard reload re-runs the page from scratch against a consumed capsule.
    await page.reload();
    await expect(page.getByText(/ya no está disponible|no longer available/)).toBeVisible();
    await expect(page.getByText(payload)).toHaveCount(0);
  });

  test('a direct GET on the capsule API does not consume it', async ({ page, request }) => {
    const { recipientUrl } = await createNote(page, 'scanner-probe-payload');
    const capsuleId = new URL(recipientUrl).pathname.split('/').pop() as string;

    // Simulate a link scanner: GET and HEAD the status, and GET the page.
    for (let i = 0; i < 5; i += 1) {
      const status = await request.get(`/api/v1/capsules/${capsuleId}/status`);
      expect(status.status()).toBe(200);
      expect((await status.json()).state).toBe('available');

      const head = await request.head(`/api/v1/capsules/${capsuleId}/status`);
      expect(head.status()).toBe(200);

      const html = await request.get(`/c/${capsuleId}`);
      expect(html.status()).toBe(200);
    }

    // Still claimable by the real recipient.
    const claim = await request.post(`/api/v1/capsules/${capsuleId}/claim`);
    expect(claim.status()).toBe(200);
    expect((await claim.json()).retrievalToken).toBeTruthy();
  });

  test('revoking from the management page blocks opening', async ({ page }) => {
    const { recipientUrl, manageUrl } = await createNote(page, 'to-be-revoked');

    await page.goto(manageUrl);
    await expect(page.getByText(/available/)).toBeVisible();
    await page.getByTestId('revoke').click();
    await expect(page.getByText(/revoked/)).toBeVisible();

    await page.goto(recipientUrl);
    await expect(page.getByText(/ya no está disponible|no longer available/)).toBeVisible();
  });

  test('the management page never exposes the content', async ({ page }) => {
    const { manageUrl } = await createNote(page, SECRET);
    await page.goto(manageUrl);
    await expect(page.getByText(/Controla la cápsula|Control the capsule/)).toBeVisible();

    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toContain(SECRET);
    // §21: no IP, no browser, no geolocation on this page.
    expect(body.toLowerCase()).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

test.describe('password-protected capsule', () => {
  test('rejects the wrong password locally and accepts the right one', async ({ page }) => {
    const password = 'marea-cobre-faro-onix-tundra';

    await page.goto('/');
    await page.locator('#composer-message').fill('password-protected-payload-9931');
    await page.getByRole('button', { name: /Personalizar|Customise/ }).click();
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();

    await expect(page.getByRole('heading', { name: /Cápsula sellada|Capsule sealed/ })).toBeVisible();
    const recipientUrl = await page
      .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
      .inputValue();

    // The link must carry the wrapped key, not the key itself.
    expect(recipientUrl).toContain('p=a2');
    expect(recipientUrl).not.toMatch(/[&#]k=/);

    await page.goto(recipientUrl);

    // Wrong password: rejected locally, capsule NOT consumed.
    await page.locator('input[type="password"]').fill('definitely-wrong');
    await page.getByTestId('open-and-consume').click();
    await expect(page.getByText(/Contraseña incorrecta|Incorrect password/)).toBeVisible({ timeout: 30_000 });

    // Correct password still works — proof the failed attempt cost nothing.
    await page.locator('input[type="password"]').fill(password);
    await page.getByTestId('open-and-consume').click();
    await expect(page.getByText('password-protected-payload-9931')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('presentation', () => {
  test('shows the HTTP preview warning', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Vista previa pública por HTTP|Public preview over HTTP/)).toBeVisible();
    // §6: the UI must never claim the connection is secure.
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toMatch(/conexión segura|secure connection/i);
  });

  test('switches language and theme without console errors', async ({ page }) => {
    const watcher = watchConsole(page);
    await page.goto('/');

    await page.getByRole('button', { name: /Switch to English/ }).click();
    await expect(page.getByText('Share something. Decide when it disappears.')).toBeVisible();

    await page.getByRole('button', { name: /Oscuro|Dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    expect(watcher.errors, `console errors: ${watcher.errors.join(' | ')}`).toHaveLength(0);
  });

  test('loads no third-party resources at all', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.protocol !== 'data:' && url.protocol !== 'blob:') {
        external.push(request.url());
      }
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // §7: no CDN, no remote fonts, no external scripts.
    expect(external, `external requests: ${external.join(', ')}`).toHaveLength(0);
  });

  test('serves robots.txt disallowing everything', async ({ request }) => {
    const response = await request.get('/robots.txt');
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('Disallow: /');
  });
});

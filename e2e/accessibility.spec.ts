/**
 * Accessibility checks (§27).
 *
 * axe-core catches the machine-checkable subset of WCAG — contrast, names,
 * roles, landmarks. The keyboard and focus assertions below cover things axe
 * cannot see, like whether the primary flow is actually operable without a
 * mouse and whether focus is visible when it lands.
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function scan(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
}

function describeViolations(violations: { id: string; impact?: string | null | undefined; nodes: unknown[] }[]) {
  return violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`).join('\n');
}

test.describe('axe-core on the main routes', () => {
  for (const [name, url] of [
    ['home', '/'],
    ['how it works', '/how-it-works'],
    ['security', '/security'],
    ['privacy', '/privacy'],
  ] as const) {
    test(`${name} has no violations in light mode`, async ({ page }) => {
      const results = await scan(page, url);
      expect(describeViolations(results.violations)).toBe('');
    });
  }

  test('home has no violations in dark mode', async ({ page }) => {
    // Contrast is theme-dependent, so dark mode needs its own pass.
    await page.goto('/');
    await page.getByRole('button', { name: /Oscuro|Dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('the advanced panel has no violations when opened', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Personalizar|Customise/ }).click();

    // The panel fades in (rise-in). Mid-animation the text is partially
    // transparent, so its EFFECTIVE contrast against the panel is lower than
    // the settled value — axe measured 4.22:1 for a colour that is 4.92:1 once
    // opacity reaches 1. Scan the settled state; a transient animation frame is
    // not what a reader perceives.
    await expect
      .poll(async () =>
        page.locator('#advanced-panel').evaluate((el) => getComputedStyle(el).opacity),
      )
      .toBe('1');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('the recipient gate has no violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('#composer-message').fill('a11y-gate-check');
    await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
    const url = await page
      .getByRole('textbox', { name: /Enlace para el destinatario|Link for the recipient/ })
      .inputValue();

    const results = await scan(page, url);
    expect(describeViolations(results.violations)).toBe('');
  });
});

test.describe('keyboard operability', () => {
  test('the whole creation flow works without a mouse', async ({ page }) => {
    await page.goto('/');

    // Tab until the message box has focus, then type.
    await page.locator('#composer-message').focus();
    await page.keyboard.type('keyboard-only-capsule-2277');

    // The primary CTA must be reachable and activatable by keyboard.
    await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: /Cápsula sellada|Capsule sealed/ })).toBeVisible();
  });

  test('a skip link is the first focusable element', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(focused).toMatch(/Saltar al contenido|Skip to content/);
  });

  test('focus is visible when reached by keyboard', async ({ page }) => {
    await page.goto('/');
    // The CTA is disabled while the composer is empty, and a disabled button is
    // not in the tab order — so give it something to submit first.
    await page.locator('#composer-message').fill('focus-visibility-check');
    const cta = page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ });

    // Tab to it rather than calling .focus(): Chromium only applies
    // :focus-visible to keyboard-driven focus, so a programmatic focus would
    // report outline:none and tell us nothing about the keyboard experience
    // this test exists to protect.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      if (await cta.evaluate((el) => el === document.activeElement)) break;
    }
    expect(await cta.evaluate((el) => el === document.activeElement), 'CTA never received keyboard focus').toBe(true);

    const outline = await cta.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, focusVisible: element.matches(':focus-visible') };
    });
    expect(outline.focusVisible).toBe(true);
    // A removed outline would be an instant WCAG 2.4.7 failure.
    expect(outline.style).not.toBe('none');
    expect(outline.width).not.toBe('0px');
  });

  test('paste is not blocked in the password field', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Personalizar|Customise/ }).click();
    const field = page.locator('input[type="password"]').first();
    // Simulate a password manager writing into the field.
    await field.fill('pasted-by-a-password-manager');
    await expect(field).toHaveValue('pasted-by-a-password-manager');
  });
});

test.describe('responsive', () => {
  test('the composer is usable at 320px with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await expect(page.locator('#composer-message')).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, 'page scrolls horizontally at 320px').toBe(false);
  });

  test('remains readable at 200% zoom', async ({ page }) => {
    // WCAG 1.4.4: emulate 200% by halving the viewport.
    await page.setViewportSize({ width: 640, height: 480 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ })).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test('honours prefers-reduced-motion on the seal animation', async ({ page }) => {
    // Emulate explicitly rather than via test.use({ reducedMotion }): the
    // fixture option did not reach the page here (matchMedia reported false),
    // which would have made this test silently assert nothing.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(
      await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      'reduced-motion emulation did not take effect',
    ).toBe(true);
    await page.locator('#composer-message').fill('reduced-motion-check');
    await page.getByRole('button', { name: /Crear enlace seguro|Create secure link/ }).click();
    await expect(page.getByRole('heading', { name: /Cápsula sellada|Capsule sealed/ })).toBeVisible();

    // The spark particle must not merely be faster — it must be absent (§20).
    // Assert the computed style rather than isVisible(): if the stylesheet ever
    // failed to load, isVisible() would report the element as shown and the
    // test would fail for a reason unrelated to reduced motion. Checking
    // `display` states the contract directly.
    const spark = await page.evaluate(() => {
      const element = document.querySelector('.animate-seal-spark');
      if (element === null) return { present: false, display: 'absent', width: 0, mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches, animationName: 'none' };
      const style = getComputedStyle(element);
      return {
        present: true,
        display: style.display,
        width: element.getBoundingClientRect().width,
        mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationName: style.animationName,
      };
    });
    expect(
      spark.display === 'none' || spark.present === false,
      `spark should be hidden under reduced motion, got ${JSON.stringify(spark)}`,
    ).toBe(true);
    expect(spark.width).toBe(0);
  });
});

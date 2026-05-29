// @ts-check
const { test, expect } = require('@playwright/test');

const PAGE = '/cis-org-dashboard/';

test.describe('CIS Org Health Dashboard', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(PAGE, { waitUntil: 'load' });
    // Wait until JS has rendered at least one sprint row in the table
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#shd-tbody');
      return tbody && tbody.children.length > 0;
    }, { timeout: 25_000 });
  });

  // ─── Page load ───────────────────────────────────────────────────────────────

  test('page title is correct', async ({ page }) => {
    await expect(page).toHaveTitle(/CIS Org/i);
  });

  test('header shows dashboard name', async ({ page }) => {
    await expect(page.locator('text=CIS Org Health Dashboard')).toBeVisible();
  });

  test('no JS errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#shd-tbody');
      return tbody && tbody.children.length > 0;
    }, { timeout: 25_000 });
    expect(errors, 'JS errors:\n' + errors.join('\n')).toHaveLength(0);
  });

  // ─── KPI summary bar ─────────────────────────────────────────────────────────

  test('KPI summary cards are visible and non-empty', async ({ page }) => {
    const kpis = page.locator('.kpi-card');
    await expect(kpis.first()).toBeVisible({ timeout: 10_000 });
    const count = await kpis.count();
    expect(count).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < Math.min(count, 5); i++) {
      const text = await kpis.nth(i).innerText();
      expect(text.trim()).not.toBe('');
    }
  });

  // ─── Tabs ─────────────────────────────────────────────────────────────────────

  test('Sprints tab renders data table rows', async ({ page }) => {
    const rows = page.locator('#shd-tbody tr');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(5);
  });

  test('Delivery tab becomes active and renders content', async ({ page }) => {
    await page.click('text=Delivery');
    // Wait for the pane to become active (CSS class added by showTab())
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-dhd');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });
    // pane is active — chart-cards inside it should be visible
    const chartCards = page.locator('#pane-dhd .chart-card');
    await expect(chartCards.first()).toBeVisible({ timeout: 5_000 });
    expect(await chartCards.count()).toBeGreaterThan(0);
  });

  test('Initiatives tab becomes active and renders content', async ({ page }) => {
    await page.click('text=Initiatives');
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-hierarchy');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });
    await expect(page.locator('#pane-hierarchy')).toBeVisible();
  });

  test('DORA tab becomes active and renders content', async ({ page }) => {
    await page.click('text=DORA');
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-dora');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });
    await expect(page.locator('#pane-dora')).toBeVisible();
  });

  // ─── Filters ──────────────────────────────────────────────────────────────────

  test('board filter narrows sprint table rows', async ({ page }) => {
    const allRows = await page.locator('#shd-tbody tr').count();

    const boardSel = page.locator('#f-board');
    const options = await boardSel.locator('option').allInnerTexts();
    const firstBoard = options.find(o => o.trim() && !/all/i.test(o));
    expect(firstBoard).toBeTruthy();

    await boardSel.selectOption({ label: firstBoard });
    await page.waitForTimeout(400);

    const filteredRows = await page.locator('#shd-tbody tr').count();
    expect(filteredRows).toBeLessThan(allRows);
    expect(filteredRows).toBeGreaterThan(0);
  });

  test('clear filters resets status filter and shows more rows', async ({ page }) => {
    // Filter to only active sprints (clearAllFilters resets f-status)
    const statusSel = page.locator('#f-status');
    await statusSel.selectOption('active');
    await page.waitForTimeout(400);

    const filteredRows = await page.locator('#shd-tbody tr').count();

    // Clear
    await page.locator('#btn-clear-filters').click();
    await page.waitForTimeout(400);

    // Status select back to empty and more rows visible
    const statusVal = await statusSel.inputValue();
    expect(statusVal).toBe('');

    const restoredRows = await page.locator('#shd-tbody tr').count();
    expect(restoredRows).toBeGreaterThan(filteredRows);
  });

  // ─── Per-assignee tickets modal (capacity widget) ─────────────────────────────

  test('clicking an avatar opens per-assignee modal with capacity bar', async ({ page }) => {
    await page.locator('#f-status').selectOption('active');
    await page.waitForTimeout(400);
    const avatar = page.locator('.js-assignee-trigger').first();
    await expect(avatar).toBeVisible({ timeout: 5_000 });
    await avatar.click();
    const modal = page.locator('#assignee-tickets-modal.open');
    await expect(modal).toBeVisible({ timeout: 3_000 });
    // Capacity widget renders
    await expect(modal.locator('.assignee-capacity')).toBeVisible();
    // Fraction text matches "X / N SP" pattern
    const fraction = await modal.locator('.assignee-capacity-fraction').innerText();
    expect(fraction).toMatch(/\d+(\.\d+)? \/ \d+ SP/);
    // At least one ticket row
    const ticketRows = modal.locator('.assignee-ticket-row');
    expect(await ticketRows.count()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#assignee-tickets-modal.open')).toHaveCount(0);
  });

  // ─── Sync banner ─────────────────────────────────────────────────────────────

  test('sync banner exists and has a synced-at timestamp', async ({ page }) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('#data-banner');
      return el && el.innerText.trim().length > 0;
    }, { timeout: 10_000 });
    const text = await page.locator('#data-banner').innerText();
    expect(text).toMatch(/Last updated|next sync/i);
  });

});

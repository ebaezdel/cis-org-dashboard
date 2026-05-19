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

  // ─── Capacity card section ────────────────────────────────────────────────────

  test('capacity section shows empty state when no board+sprint filter', async ({ page }) => {
    await page.click('text=Delivery');
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-dhd');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });

    // #capacity-cards is present in active pane — check its content
    const emptyText = await page.evaluate(() => {
      const el = document.getElementById('capacity-cards');
      return el ? el.innerText : '';
    });
    expect(emptyText).toMatch(/board|sprint/i);
  });

  test('capacity cards appear after selecting board + specific sprint', async ({ page }) => {
    // Both board AND a specific sprint are required
    const boardSel = page.locator('#f-board');
    const boardOptions = await boardSel.locator('option').allInnerTexts();
    const firstBoard = boardOptions.find(o => o.trim() && !/all/i.test(o));
    expect(firstBoard).toBeTruthy();
    await boardSel.selectOption({ label: firstBoard });
    await page.waitForTimeout(300);

    // Select first specific sprint (not "All")
    const sprintSel = page.locator('#f-sprint-sel');
    const sprintOptions = await sprintSel.locator('option').allInnerTexts();
    const firstSprint = sprintOptions.find(o => o.trim() && !/all/i.test(o));
    if (!firstSprint) { test.skip(); return; }
    await sprintSel.selectOption({ label: firstSprint });
    await page.waitForTimeout(400);

    // Switch to Delivery tab
    await page.click('text=Delivery');
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-dhd');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });

    const result = await page.evaluate(() => {
      const el = document.getElementById('capacity-cards');
      if (!el) return { html: '', text: '' };
      return { html: el.innerHTML, text: el.innerText };
    });

    // Must NOT show the empty state prompt
    expect(result.text).not.toMatch(/Filter by.*board/i);

    // If cards rendered, verify structure
    if (result.html.includes('cap-card')) {
      const cards = page.locator('.cap-card');
      expect(await cards.count()).toBeGreaterThan(0);
      const fraction = await cards.first().locator('.cap-fraction').innerText();
      expect(fraction).toMatch(/\d+(\.\d+)? \/ \d+ SP/);
    }
  });

  test('capacity cards appear after selecting active status + board', async ({ page }) => {
    // Active status implies one sprint per board — charts should render without a specific sprint
    const statusSel = page.locator('#f-status');
    await statusSel.selectOption('active');
    await page.waitForTimeout(200);

    const boardSel = page.locator('#f-board');
    const boardOptions = await boardSel.locator('option').allInnerTexts();
    const firstBoard = boardOptions.find(o => o.trim() && !/all/i.test(o));
    expect(firstBoard).toBeTruthy();
    await boardSel.selectOption({ label: firstBoard });
    await page.waitForTimeout(400);

    // Switch to Delivery tab
    await page.click('text=Delivery');
    await page.waitForFunction(() => {
      const pane = document.getElementById('pane-dhd');
      return pane && pane.classList.contains('active');
    }, { timeout: 8_000 });

    const result = await page.evaluate(() => {
      const el = document.getElementById('capacity-cards');
      if (!el) return { html: '', text: '' };
      return { html: el.innerHTML, text: el.innerText };
    });

    // Must NOT show the empty state prompt
    expect(result.text).not.toMatch(/Filter by.*board/i);
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

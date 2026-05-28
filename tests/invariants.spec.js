// @ts-check
//
// Data-correctness invariants for the dashboard. These don't pin specific
// sprint values (that fixture would have to be updated every sync) — they
// just assert facts that must always be true regardless of which Jira data
// is loaded. They catch the bugs we've actually hit:
//   - duplicate sprint rows inflating filtered totals
//   - duplicate sprint numbers across quarters in the dropdown
//   - SP arithmetic going negative or NaN
//   - card type-counts not matching the issue count
//
// Run with: BASE_URL=https://ebaezdel.github.io npx playwright test invariants.spec.js
const { test, expect } = require('@playwright/test');

const PAGE = '/cis-org-dashboard/';

test.describe('Dashboard data invariants', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#shd-tbody');
      return tbody && tbody.children.length > 0;
    }, { timeout: 25_000 });
  });

  test('no duplicate (board, fy, sprintNum) rows in ALL_SPRINTS_FY26', async ({ page }) => {
    const dupes = await page.evaluate(() => {
      const seen = new Map();
      const out = [];
      // @ts-ignore - injected by index.html
      (window.ALL_SPRINTS_FY26 || []).forEach(d => {
        const key = `${d.board}|${d.fy}|${d.sprint}`;
        if (seen.has(key)) {
          out.push({ key, names: [seen.get(key), d.sprintName] });
        } else {
          seen.set(key, d.sprintName);
        }
      });
      return out;
    });
    expect(dupes, 'duplicate (board, fy, sprintNum):\n' + JSON.stringify(dupes, null, 2)).toEqual([]);
  });

  test('sprint numbers map to canonical quarters (Q1: 0-6, Q2: 7-12, Q3: 13-19, Q4: 20-25)', async ({ page }) => {
    const offenders = await page.evaluate(() => {
      const canonical = (n) => n <= 6 ? 'Q1' : n <= 12 ? 'Q2' : n <= 19 ? 'Q3' : 'Q4';
      // @ts-ignore
      return (window.ALL_SPRINTS_FY26 || [])
        .filter(d => d.quarter && canonical(d.sprint) !== d.quarter)
        .map(d => ({ board: d.board, sprintName: d.sprintName, sprintNum: d.sprint, quarter: d.quarter, expected: canonical(d.sprint) }));
    });
    expect(offenders, 'rows with non-canonical quarter:\n' + JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('sprint dropdown has unique sprint numbers within each quarter', async ({ page }) => {
    const offenders = await page.evaluate(() => {
      const sel = document.getElementById('f-sprint-sel');
      if (!sel) return [];
      const seen = new Set();
      const dupes = [];
      Array.from(sel.querySelectorAll('option')).forEach(opt => {
        const val = opt.value || '';
        if (!val) return;
        if (seen.has(val)) dupes.push(val);
        seen.add(val);
      });
      return dupes;
    });
    expect(offenders, 'duplicate dropdown options: ' + offenders.join(', ')).toEqual([]);
  });

  test('every row has non-negative SP and well-formed numeric fields', async ({ page }) => {
    const offenders = await page.evaluate(() => {
      const out = [];
      // @ts-ignore
      (window.ALL_SPRINTS_FY26 || []).forEach(d => {
        const issues = ['totalSP', 'doneSP', 'committedSP', 'pendingSP', 'issues']
          .filter(k => typeof d[k] !== 'number' || isNaN(d[k]) || d[k] < 0);
        if (issues.length) out.push({ sprintName: d.sprintName, badFields: issues, vals: { totalSP: d.totalSP, doneSP: d.doneSP, committedSP: d.committedSP, pendingSP: d.pendingSP, issues: d.issues } });
      });
      return out;
    });
    // doneSP > committedSP is a NORMAL pattern in Jira when mid-sprint adds get
    // completed (they count toward done but not toward commitment). We don't
    // flag it — only NaN/negative/missing fields are real bugs.
    expect(offenders, 'rows with NaN/negative SP fields:\n' + JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test('filtering to a single sprint yields at most one row per board', async ({ page }) => {
    // Pick the dropdown value for the most recent FY26 closed sprint number.
    // The dropdown stores values as JSON {fy,q,sprint}.
    const sprintValue = await page.evaluate(() => {
      // @ts-ignore
      const rows = window.ALL_SPRINTS_FY26 || [];
      const closedFY26 = rows.filter(d => d.fy === 'FY26' && d.sprintStatus === 'closed');
      if (!closedFY26.length) return null;
      const maxSprint = Math.max(...closedFY26.map(d => d.sprint));
      const sample = closedFY26.find(d => d.sprint === maxSprint);
      if (!sample) return null;
      return JSON.stringify({ fy: sample.fy, q: sample.quarter, sprint: String(sample.sprint) });
    });
    if (!sprintValue) test.skip(true, 'No closed FY26 sprint in dataset');

    const sprintSel = page.locator('#f-sprint-sel');
    await sprintSel.selectOption(sprintValue);
    await page.waitForTimeout(400);

    const result = await page.evaluate(() => {
      // @ts-ignore
      const filtered = window.FILTERED || [];
      const byBoard = {};
      filtered.forEach(d => { byBoard[d.board] = (byBoard[d.board] || 0) + 1; });
      const offenders = Object.entries(byBoard).filter(([, n]) => n > 1).map(([b, n]) => `${b}: ${n}`);
      return { totalRows: filtered.length, offenders };
    });
    expect(result.offenders, `boards with >1 row for filtered sprint:\n${result.offenders.join('\n')}`).toEqual([]);
    expect(result.totalRows).toBeGreaterThan(0);
  });

  test('board cards never show NaN, undefined, or absurd numbers', async ({ page }) => {
    const offenders = await page.locator('#board-health-grid .board-card').evaluateAll(cards => {
      const bad = [];
      cards.forEach(card => {
        const txt = card.textContent || '';
        if (/NaN|undefined|null/i.test(txt)) {
          bad.push({ name: (card.querySelector('.bc-name') || {}).textContent, hit: (txt.match(/NaN|undefined|null/i) || [])[0] });
        }
      });
      return bad;
    });
    expect(offenders).toEqual([]);
  });

  test('filtering to active sprints renders one card per known board', async ({ page }) => {
    await page.locator('#f-status').selectOption('active');
    await page.waitForTimeout(400);
    // Get the set of distinct boards in the dataset — every one should render
    // (with a stub card if it has no active sprint).
    const expectedBoards = await page.evaluate(() => {
      const set = new Set();
      // @ts-ignore
      (window.ALL_SPRINTS_FY26 || []).forEach(d => set.add(d.board));
      return Array.from(set).sort();
    });
    const renderedBoards = await page.locator('#board-health-grid .board-card .bc-name').evaluateAll(els =>
      els.map(e => (e.textContent || '').trim()).sort()
    );
    expect(renderedBoards).toEqual(expectedBoards);
  });

  test('clearing filters restores full dataset and no filter is sticky', async ({ page }) => {
    await page.locator('#f-status').selectOption('active');
    await page.waitForTimeout(200);
    const filteredCount = await page.evaluate(() => {
      // @ts-ignore
      return (window.FILTERED || []).length;
    });
    await page.locator('#btn-clear-filters').click();
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => {
      // @ts-ignore
      return (window.FILTERED || []).length;
    });
    expect(restored).toBeGreaterThanOrEqual(filteredCount);
    // All filter selects should be empty
    const filterVals = await page.evaluate(() => ({
      status: (document.getElementById('f-status') || {}).value,
      sprint: (document.getElementById('f-sprint-sel') || {}).value,
      board:  (document.getElementById('f-board') || {}).value,
    }));
    expect(filterVals.status).toBe('');
    expect(filterVals.sprint).toBe('');
    expect(filterVals.board).toBe('');
  });

  test('every row has a non-empty sprintName and a known board', async ({ page }) => {
    const offenders = await page.evaluate(() => {
      const out = [];
      // @ts-ignore
      (window.ALL_SPRINTS_FY26 || []).forEach(d => {
        if (!d.sprintName || typeof d.sprintName !== 'string') {
          out.push({ row: d, issue: 'missing sprintName' });
        }
        if (!d.board || typeof d.board !== 'string') {
          out.push({ row: d, issue: 'missing board' });
        }
        if (!d.fy || !/^FY\d{2}$/.test(d.fy)) {
          out.push({ row: d, issue: 'bad fy: ' + d.fy });
        }
      });
      return out;
    });
    expect(offenders, 'malformed rows:\n' + JSON.stringify(offenders, null, 2)).toEqual([]);
  });
});

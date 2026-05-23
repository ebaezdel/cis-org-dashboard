#!/usr/bin/env node
'use strict';

/**
 * sync.js — fetch live Jira sprint data and patch index.html
 *
 * SP metrics (totalSP, doneSP, committedSP, spRes) come from the Jira Greenhopper
 * sprint report API — the same source as the velocity chart — so numbers match
 * exactly after a sprint closes. epicBreakdown, effortBreakdown, and ticketsPerDev
 * continue to use JQL for per-ticket detail.
 *
 * Env vars required:
 *   JIRA_EMAIL       — Atlassian account email
 *   JIRA_API_TOKEN   — token from https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Run locally:
 *   JIRA_EMAIL=you@example.com JIRA_API_TOKEN=xxx node scripts/sync.js
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const CLOUD_ID         = 'cf0dc8c2-47a8-4929-8d48-2e03205ce9da';
const JIRA_BASE        = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;
const AGILE_BASE       = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/agile/1.0`;
// Greenhopper is a legacy API only reachable on the direct tenant host (not the
// api.atlassian.com OAuth proxy).
const GREENHOPPER_BASE = `https://moveinc.atlassian.net/rest/greenhopper/1.0`;
const HTML_PATH        = path.join(__dirname, '..', 'index.html');

// boardId = numeric Jira board ID (from the /boards/{id}/reports/velocity URL).
// FIND, CON, LHAPI use kanban — no scrum board, fall back to JQL-only metrics.
const BOARDS = [
  { board: 'FC',    em: 'Saloni',  boardId: 1026 },
  { board: 'CSS',   em: 'Saloni',  boardId: 1021 },
  { board: 'CEGEO', em: 'Saloni',  boardId: 1205 },
  { board: 'QAS',   em: 'Saloni',  boardId: 9062 },
  { board: 'TSC',   em: 'Maria',   boardId: 888  },
  { board: 'MSV',   em: 'Maria',   boardId: 874  },
  { board: 'RPS',   em: 'Maria',   boardId: 127  },
  { board: 'FIND',  em: 'Maria',   boardId: null },
  { board: 'TCET',  em: 'Marissa', boardId: 6221 },
  { board: 'CON',   em: 'Marissa', boardId: null },
  { board: 'LHAPI', em: 'Marissa', boardId: null },
  { board: 'TLCC',  em: 'Yan',     boardId: 6220 },
  { board: 'QUA',   em: 'Yan',     boardId: 1184 },
];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function makeGet(baseUrl) {
  return function get(urlPath) {
    const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    return new Promise((resolve, reject) => {
      const req = https.get(
        `${baseUrl}${urlPath}`,
        { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (res.statusCode >= 400) {
              return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  };
}

const jiraGet        = makeGet(JIRA_BASE);
const agileGet       = makeGet(AGILE_BASE);
const greenphopper   = makeGet(GREENHOPPER_BASE);

// ─── Jira REST (JQL — for epic/effort/dev breakdown only) ────────────────────

async function fetchIssues(board, sprintClause) {
  const fields = [
    'summary', 'status', 'assignee', 'issuetype', 'labels',
    'customfield_10034', 'customfield_10016', 'customfield_10020', 'parent', 'issuelinks',
  ].join(',');
  const jql = encodeURIComponent(`project = ${board} AND sprint in ${sprintClause} ORDER BY created ASC`);

  let issues = [];
  let nextPageToken;

  while (true) {
    const qs = nextPageToken
      ? `/search/jql?jql=${jql}&fields=${fields}&maxResults=100&nextPageToken=${encodeURIComponent(nextPageToken)}`
      : `/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
    const data = await jiraGet(qs);
    issues = issues.concat(data.issues || []);
    if (!data.nextPageToken || !(data.issues || []).length) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

// Fetch issues for a specific named sprint (used for closed/future breakdown)
async function fetchIssuesBySprintName(board, sprintName) {
  const fields = [
    'summary', 'status', 'assignee', 'issuetype', 'labels',
    'customfield_10034', 'customfield_10016', 'customfield_10020', 'parent', 'issuelinks',
  ].join(',');
  const jql = encodeURIComponent(`project = ${board} AND sprint = "${sprintName}" ORDER BY created ASC`);

  let issues = [];
  let nextPageToken;

  while (true) {
    const qs = nextPageToken
      ? `/search/jql?jql=${jql}&fields=${fields}&maxResults=100&nextPageToken=${encodeURIComponent(nextPageToken)}`
      : `/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
    const data = await jiraGet(qs);
    issues = issues.concat(data.issues || []);
    if (!data.nextPageToken || !(data.issues || []).length) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

// Fetch issues by an explicit list of keys (lets us pull tickets that have since
// been moved out of the sprint — JQL "sprint = X" only returns currently-tagged ones).
async function fetchIssuesByKeys(keys) {
  if (!keys.length) return [];
  const fields = [
    'summary', 'status', 'assignee', 'issuetype', 'labels',
    'customfield_10034', 'customfield_10016', 'customfield_10020', 'parent', 'issuelinks',
  ].join(',');
  const issues = [];
  // chunk to avoid 414 URI Too Long
  for (let i = 0; i < keys.length; i += 80) {
    const slice = keys.slice(i, i + 80);
    const jql = encodeURIComponent(`key in (${slice.join(',')})`);
    let nextPageToken;
    while (true) {
      const qs = nextPageToken
        ? `/search/jql?jql=${jql}&fields=${fields}&maxResults=100&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : `/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
      const data = await jiraGet(qs);
      issues.push(...(data.issues || []));
      if (!data.nextPageToken || !(data.issues || []).length) break;
      nextPageToken = data.nextPageToken;
    }
  }
  return issues;
}

// ─── Agile API (sprint list) ──────────────────────────────────────────────────

// Only FY26+ sprints are rendered on the dashboard. Pre-FY26 sprints add
// hundreds of API calls per board (RPS alone has ~250 closed sprints back to
// FY18) for data we never display. Filter by name pattern.
const SPRINT_FY_RE = /\bFY(2[6-9]|[3-9]\d)\b/;
function isSupportedSprint(s) {
  return s && typeof s.name === 'string' && SPRINT_FY_RE.test(s.name);
}

// Returns [{id, name, state, startDate, endDate, goal}]
async function fetchSprintList(boardId, state) {
  let sprints = [], startAt = 0;
  while (true) {
    const data = await agileGet(`/board/${boardId}/sprint?state=${state}&startAt=${startAt}&maxResults=50`);
    sprints = sprints.concat(data.values || []);
    if (data.isLast || !(data.values || []).length) break;
    startAt += data.values.length;
  }
  return sprints.filter(isSupportedSprint);
}

// The /board/{id}/sprint list endpoint frequently omits `goal`. Hit the per-sprint
// endpoint for the authoritative goal text.
async function fetchSprintGoal(sprintId) {
  try {
    const s = await agileGet(`/sprint/${sprintId}`);
    return typeof s.goal === 'string' ? s.goal : '';
  } catch (e) {
    return '';
  }
}

// ─── Greenhopper sprint report (velocity-chart-accurate SP numbers) ───────────

// Returns the keys of every issue that touched this sprint plus the snapshot
// classification (completed at close / not completed / punted / added during).
// Used by closed-sprint snapshot path so epicBreakdown / ticketsPerDev /
// statuses reflect the moment the sprint closed, not the live JQL state.
async function fetchSprintSnapshot(boardId, sprintId) {
  const r = await greenphopper(`/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`);
  const c = r.contents || {};
  const completed    = (c.completedIssues || []).map(i => i.key);
  const notCompleted = (c.issuesNotCompletedInCurrentSprint || []).map(i => i.key);
  const punted       = (c.puntedIssues || []).map(i => i.key);
  const added        = c.issueKeysAddedDuringSprint && typeof c.issueKeysAddedDuringSprint === 'object'
    ? new Set(Object.keys(c.issueKeysAddedDuringSprint))
    : new Set();

  // Per-issue snapshot SP at sprint start (estimateStatistic = initial).
  const initialSP = {};
  // Per-issue snapshot status name and category at the time of close.
  const snapStatus = {};
  for (const arr of [c.completedIssues, c.issuesNotCompletedInCurrentSprint, c.puntedIssues]) {
    (arr || []).forEach(i => {
      const v = i.estimateStatistic?.statFieldValue?.value;
      if (typeof v === 'number') initialSP[i.key] = v;
      if (i.statusName) snapStatus[i.key] = { name: i.statusName, category: i.statusCategory || '' };
      else if (i.status?.name) snapStatus[i.key] = { name: i.status.name, category: i.status.statusCategory?.key || '' };
    });
  }

  // Issues that count toward the snapshot of this sprint (everything except
  // mid-sprint additions — those are excluded from velocity chart).
  const allKeys = [...completed, ...notCompleted, ...punted].filter(k => !added.has(k));

  return { contents: c, completed, notCompleted, punted, added, initialSP, snapStatus, allKeys };
}

// Apply the Greenhopper snapshot onto a Jira-issue list so closed-sprint
// breakdowns/statuses reflect sprint-close state, not today's live state.
function applySnapshotToIssues(issues, snap) {
  const completedSet = new Set(snap.completed);
  const puntedSet    = new Set(snap.punted);
  return issues
    // drop anything that was added mid-sprint — velocity chart ignores them
    .filter(i => !snap.added.has(i.key))
    .map(i => {
      const f = { ...i.fields };
      const ss = snap.snapStatus[i.key];
      if (ss) {
        const cat = completedSet.has(i.key) ? 'done'
                  : puntedSet.has(i.key)    ? 'new'
                  :                            (ss.category || 'indeterminate');
        f.status = { ...(f.status || {}), name: ss.name, statusCategory: { key: cat } };
      }
      // override SP with snapshot initial estimate so per-ticket SP matches velocity
      const initSP = snap.initialSP[i.key];
      if (typeof initSP === 'number') {
        f.customfield_10034 = initSP;
      }
      return { ...i, fields: f };
    });
}

// Returns metrics matching exactly what the Jira velocity chart shows.
// For active sprints: live current state. For closed: locked snapshot at close.
async function fetchSprintReport(boardId, sprintId) {
  const r = await greenphopper(`/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`);
  const c = r.contents || {};

  const completedIssues = c.completedIssues                    || [];
  const notCompleted    = c.issuesNotCompletedInCurrentSprint   || [];
  const punted          = c.puntedIssues                        || [];

  // Jira's "Commitment" excludes issues added after the sprint started.
  // Walk every issue that touched the sprint and sum estimateStatistic (which
  // carries the initial estimate at sprint-start time in the sprint report
  // payload), skipping anything in issueKeysAddedDuringSprint.
  const added = new Set(
    c.issueKeysAddedDuringSprint && typeof c.issueKeysAddedDuringSprint === 'object'
      ? Object.keys(c.issueKeysAddedDuringSprint)
      : []
  );
  const sumInitial = (arr) => (arr || []).reduce((s, i) => {
    if (added.has(i.key)) return s;
    const v = i.estimateStatistic?.statFieldValue?.value;
    return s + (typeof v === 'number' ? v : 0);
  }, 0);

  // committedSP = SP on the board at sprint start (velocity "Commitment")
  // doneSP      = SP of completed issues using current estimates (velocity "Completed")
  const committedSP = r1(sumInitial(completedIssues) + sumInitial(notCompleted) + sumInitial(punted));
  const doneSP      = r1(c.completedIssuesEstimateSum?.value          ?? 0);
  const pendingSP   = r1(c.issuesNotCompletedEstimateSum?.value        ?? 0);
  const totalSP     = r1(doneSP + pendingSP);
  // Issue count excludes mid-sprint adds (matches velocity chart denominator).
  const issues      = completedIssues.filter(i => !added.has(i.key)).length
                    + notCompleted.filter(i => !added.has(i.key)).length
                    + punted.filter(i => !added.has(i.key)).length;
  const spRes       = pct(doneSP, committedSP);

  return {
    issues,
    totalSP,
    doneSP,
    pendingSP,
    inProgressSP: 0,
    committedSP,
    spRes,
    velocity: spRes,
  };
}

// ─── Metric helpers (JQL fallback for kanban boards / future sprints) ─────────

function sp(issue) {
  const f = issue.fields;
  return (f.customfield_10034 ?? f.customfield_10016 ?? 0) || 0;
}

function isDone(issue) {
  return issue.fields?.status?.statusCategory?.key === 'done';
}

function isInProgress(issue) {
  return issue.fields?.status?.statusCategory?.key === 'indeterminate';
}

function r1(n) { return Math.round(n * 10) / 10; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function calcMetrics(issues) {
  const totalSP   = r1(issues.reduce((s, i) => s + sp(i), 0));
  const doneSP    = r1(issues.filter(isDone).reduce((s, i) => s + sp(i), 0));
  const inProgSP  = r1(issues.filter(isInProgress).reduce((s, i) => s + sp(i), 0));
  const pendingSP = r1(totalSP - doneSP);
  const spRes     = pct(doneSP, totalSP);
  return { issues: issues.length, totalSP, doneSP, pendingSP, inProgressSP: inProgSP, committedSP: totalSP, spRes, velocity: spRes };
}

// ─── Epic / effort / dev breakdown builders ───────────────────────────────────

function buildEpicBreakdown(issues) {
  const epicMap = {};
  const other   = { key: null, label: 'Other / Sub-tasks', issues: [], sp: 0, done: 0 };

  issues.forEach(issue => {
    const f            = issue.fields;
    const parentIsEpic = f.parent?.fields?.issuetype?.name === 'Epic';
    const epicKey      = parentIsEpic ? f.parent.key : null;
    const epicLabel    = parentIsEpic ? (f.parent.fields?.summary || epicKey) : null;
    const issueSP      = sp(issue);
    const ticket = {
      key:       issue.key,
      title:     (f.summary || '').slice(0, 50),
      status:    f.status?.name || '',
      sp:        issueSP || null,
      assignee:  f.assignee?.displayName || '',
      issueType: f.issuetype?.name || 'Story',
    };

    if (epicKey) {
      if (!epicMap[epicKey]) epicMap[epicKey] = { key: epicKey, label: epicLabel, issues: [], sp: 0, done: 0 };
      epicMap[epicKey].issues.push(ticket);
      epicMap[epicKey].sp   += issueSP;
      if (isDone(issue)) epicMap[epicKey].done += issueSP;
    } else {
      other.issues.push(ticket);
    }
  });

  const result = Object.values(epicMap)
    .sort((a, b) => b.sp - a.sp)
    .map(e => ({ ...e, sp: r1(e.sp), done: r1(e.done) }));

  if (other.issues.length) result.push(other);
  return result;
}

function buildTicketsPerDev(issues) {
  const devMap = {};
  issues.forEach(issue => {
    const name = issue.fields?.assignee?.displayName || 'Unassigned';
    if (!devMap[name]) devMap[name] = { tickets: 0, sp: 0 };
    devMap[name].tickets++;
    devMap[name].sp = r1(devMap[name].sp + sp(issue));
  });
  return Object.entries(devMap)
    .sort((a, b) => b[1].sp - a[1].sp)
    .map(([dev, v]) => ({ dev, tickets: v.tickets, sp: v.sp }));
}

function isCntntLinked(issue) {
  return (issue.fields?.issuelinks || []).some(link => {
    const key = (link.outwardIssue?.key || link.inwardIssue?.key || '');
    return key.startsWith('CNTNT-');
  });
}

function buildEffortBreakdown(issues) {
  const counts = {};
  issues.forEach(i => {
    if (!isCntntLinked(i)) return;
    const labels = i.fields?.labels || [];
    const type = labels.includes('ELT')             ? 'ELT (sponsor)'
               : labels.includes('Contractual')     ? 'Contractual / Legal'
               : labels.includes('ProductPriority') ? 'Product / Business priority change'
               : labels.includes('TechRequest')     ? 'Technical request'
               : labels.includes('NewFutureWork')   ? 'New future work'
               : 'Unclassified intake';
    counts[type] = (counts[type] || 0) + 1;
  });
  const total = Object.values(counts).reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, Math.round(v / total * 100)])
  );
}

// ─── JS literal serializers (single-quoted strings, no JSON) ─────────────────

function jsStr(s) {
  return "'" + String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '') + "'";
}

function serializeObj(obj) {
  return '{' + Object.entries(obj).map(([k, v]) => `${jsStr(k)}:${v}`).join(',') + '}';
}

function serializeTicket(t) {
  return `{key:${jsStr(t.key)},title:${jsStr(t.title)},status:${jsStr(t.status)},sp:${t.sp === null ? 'null' : t.sp},assignee:${jsStr(t.assignee)},issueType:${jsStr(t.issueType)}}`;
}

function serializeEpicBreakdown(arr) {
  return '[' + arr.map(e => {
    const tickets = '[' + (e.issues || []).map(serializeTicket).join(',') + ']';
    return `{key:${e.key ? jsStr(e.key) : 'null'},label:${jsStr(e.label)},issues:${(e.issues || []).length},sp:${e.sp},done:${e.done},tickets:${tickets}}`;
  }).join(',') + ']';
}

function serializeTicketsPerDev(arr) {
  return '[' + arr.map(e => `{dev:${jsStr(e.dev)},tickets:${e.tickets},sp:${e.sp}}`).join(',') + ']';
}

// ─── HTML patcher ─────────────────────────────────────────────────────────────

// deltaSP may appear between committedSP and spRes in some rows — capture it so
// it can be re-emitted unchanged in the replacement string.
const METRICS_RE = /, issues:\d+(?:\.\d+)?, totalSP:\d+(?:\.\d+)?, doneSP:\d+(?:\.\d+)?, pendingSP:\d+(?:\.\d+)?, inProgressSP:\d+(?:\.\d+)?, committedSP:\d+(?:\.\d+)?(, deltaSP:[^,]+)?, spRes:\d+, velocity:\d+/;

const PAYLOAD_RE = /, epicBreakdown:\[.*?\], effortBreakdown:\{[^}]*\}(?:, _hasStatusBreakdown:true)?(?:, ticketsPerDev:\[.*?\])?(?=\})/;

const SPRINTSTATUS_RE = /sprintStatus:'(?:active|future|closed)'/;

const SPRINTGOAL_RE = /sprintGoal:'(?:[^'\\]|\\.)*'/;

function getSprintNameForState(issue, targetState) {
  const sprints = issue.fields?.customfield_10020;
  if (!Array.isArray(sprints) || !sprints.length) return null;
  const match = sprints.find(s => s.state === targetState);
  return (match || sprints[0])?.name || null;
}

function groupBySprint(issues, targetState) {
  const map = {};
  issues.forEach(issue => {
    const name = getSprintNameForState(issue, targetState);
    if (!name || !SPRINT_FY_RE.test(name)) return;
    if (!map[name]) map[name] = [];
    map[name].push(issue);
  });
  return map;
}

function patchHTMLBySprintName(html, sprintName, sprintStatus, m, epicBreakdown, effortBreakdown, ticketsPerDev, sprintGoal, board, em, startDate, endDate) {
  const metricsRepl      = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}$1, spRes:${m.spRes}, velocity:${m.velocity}`;
  const payloadRepl      = `, epicBreakdown:${serializeEpicBreakdown(epicBreakdown)}, effortBreakdown:${serializeObj(effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(ticketsPerDev)}`;
  const sprintStatusRepl = `sprintStatus:'${sprintStatus}'`;

  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`sprintName:'${sprintName}'`)) return line;
    // Mark found as soon as we see the row by name. Don't gate on whether
    // replace() produced a diff — when the live data already matches what's on
    // disk (closed sprints whose snapshot hasn't shifted) all replacers return
    // the same string, which previously caused the "no row found" branch to
    // append a duplicate every sync.
    found = true;
    let updated = line.replace(METRICS_RE, metricsRepl);
    updated = updated.replace(PAYLOAD_RE, payloadRepl);
    updated = updated.replace(SPRINTSTATUS_RE, sprintStatusRepl);
    if (sprintGoal != null) updated = updated.replace(SPRINTGOAL_RE, `sprintGoal:${jsStr(sprintGoal)}`);
    return updated;
  });

  if (found) return result.join('\n');

  // Row didn't exist — build and append a fresh row before the array terminator.
  if (!board || !em) {
    process.stderr.write(`[WARN] No row found and insufficient metadata to create sprintName:'${sprintName}'\n`);
    return result.join('\n');
  }
  const newRow = buildNewSprintRow({
    sprintName, sprintStatus, board, em,
    startDate: startDate || '',
    endDate:   endDate   || '',
    sprintGoal: sprintGoal || '',
    metrics:   m,
    epicBreakdown, effortBreakdown, ticketsPerDev,
  });
  const inserted = insertRowIntoArray(result, newRow);
  if (inserted.changed) {
    process.stdout.write(`[INFO] Inserted new row for sprintName:'${sprintName}'\n`);
    return inserted.lines.join('\n');
  }
  process.stderr.write(`[WARN] Could not insert new row for sprintName:'${sprintName}' — ALL_SPRINTS_FY26 terminator not found\n`);
  return result.join('\n');
}

// Parse a sprint name like 'FC.FY26.Q4.S22' or 'TL-QAS.FY26.Q4S23' into
// {fy, quarter, sprintNum}. Returns blanks rather than null so the row still
// renders if the format is unusual.
function parseSprintMetadata(sprintName) {
  const m = sprintName.match(/FY(\d{2})/);
  const q = sprintName.match(/Q(\d)/);
  const s = sprintName.match(/S(\d+)/);
  return {
    fy:        m ? `FY${m[1]}` : '',
    quarter:   q ? `Q${q[1]}`  : '',
    sprintNum: s ? Number(s[1]) : 0,
  };
}

function buildNewSprintRow(opts) {
  const meta = parseSprintMetadata(opts.sprintName);
  const m    = opts.metrics;
  const startStr = opts.startDate ? opts.startDate.slice(0, 10) : '';
  const endStr   = opts.endDate   ? opts.endDate.slice(0, 10)   : '';
  return `  {em:${jsStr(opts.em)}, board:${jsStr(opts.board)}, sprintName:${jsStr(opts.sprintName)}, sprintGoal:${jsStr(opts.sprintGoal)}, sprintStatus:'${opts.sprintStatus}', startDate:${jsStr(startStr)}, endDate:${jsStr(endStr)}, fy:${jsStr(meta.fy)}, quarter:${jsStr(meta.quarter)}, sprint:${meta.sprintNum}, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}, spRes:${m.spRes}, velocity:${m.velocity}, unplannedPct:0, plannedPct:100, deltaSP:0, backlogSprints:0, epicBreakdown:${serializeEpicBreakdown(opts.epicBreakdown)}, effortBreakdown:${serializeObj(opts.effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(opts.ticketsPerDev)}},`;
}

// Locate the closing `];` of `var ALL_SPRINTS_FY26 = [` and insert the new row
// just before it. Returns {changed, lines}. Refuses to insert if a row with
// the same sprintName already exists — defensive guard against duplication.
function insertRowIntoArray(lines, newRow) {
  const nameMatch = newRow.match(/sprintName:'([^']+)'/);
  const sprintName = nameMatch ? nameMatch[1] : null;
  if (sprintName) {
    const needle = `sprintName:'${sprintName}'`;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        process.stderr.write(`[WARN] Skipped duplicate insert for sprintName:'${sprintName}' — already present\n`);
        return { changed: false, lines };
      }
    }
  }
  let inArray = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inArray && /var\s+ALL_SPRINTS_FY26\s*=\s*\[/.test(lines[i])) {
      inArray = true;
      continue;
    }
    if (inArray && /^\];?\s*$/.test(lines[i])) {
      const out = lines.slice();
      out.splice(i, 0, newRow);
      return { changed: true, lines: out };
    }
  }
  return { changed: false, lines };
}

// Walk the ALL_SPRINTS_FY26 array, drop any row whose sprintName has already
// been seen. Cleans up duplicates introduced by the prior bug. Idempotent.
function dedupeSprintRows(html) {
  const lines = html.split('\n');
  const seen = new Set();
  let inArray = false;
  let dropped = 0;
  const out = [];
  for (const line of lines) {
    if (!inArray && /var\s+ALL_SPRINTS_FY26\s*=\s*\[/.test(line)) {
      inArray = true;
      out.push(line);
      continue;
    }
    if (inArray && /^\];?\s*$/.test(line)) {
      inArray = false;
      out.push(line);
      continue;
    }
    if (inArray) {
      const m = line.match(/sprintName:'([^']+)'/);
      if (m) {
        if (seen.has(m[1])) { dropped++; continue; }
        seen.add(m[1]);
      }
    }
    out.push(line);
  }
  if (dropped) console.log(`[INFO] dedupeSprintRows dropped ${dropped} duplicate row(s)`);
  return out.join('\n');
}

function patchHTML(html, board, sprintStatus, m, epicBreakdown, effortBreakdown, ticketsPerDev) {
  const metricsRepl      = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}$1, spRes:${m.spRes}, velocity:${m.velocity}`;
  const payloadRepl      = `, epicBreakdown:${serializeEpicBreakdown(epicBreakdown)}, effortBreakdown:${serializeObj(effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(ticketsPerDev)}`;
  const sprintStatusRepl = `sprintStatus:'${sprintStatus}'`;

  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`board:'${board}'`) || !line.includes(`sprintStatus:'${sprintStatus}'`)) return line;
    let updated = line.replace(METRICS_RE, metricsRepl);
    updated = updated.replace(PAYLOAD_RE, payloadRepl);
    updated = updated.replace(SPRINTSTATUS_RE, sprintStatusRepl);
    if (updated !== line) found = true;
    return updated;
  });

  if (!found) process.stderr.write(`[WARN] No ${sprintStatus} sprint row patched for ${board}\n`);
  return result.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
    process.stderr.write('Error: JIRA_EMAIL and JIRA_API_TOKEN must be set.\n');
    process.exit(1);
  }

  console.log(`=== CIS Org Dashboard — Jira Sync  ${new Date().toISOString()} ===`);

  let html = fs.readFileSync(HTML_PATH, 'utf8');
  html = dedupeSprintRows(html);

  for (const { board, boardId, em } of BOARDS) {
    const hasBoard = boardId != null;

    if (!hasBoard) {
      // ── Kanban / no scrum board — JQL-only path (legacy behaviour) ──────────
      process.stdout.write(`  [${board.padEnd(6)}] (kanban) active... `);
      try {
        const issues          = await fetchIssues(board, 'openSprints()');
        const metrics         = calcMetrics(issues);
        const epicBreakdown   = buildEpicBreakdown(issues);
        const effortBreakdown = buildEffortBreakdown(issues);
        const ticketsPerDev   = buildTicketsPerDev(issues);
        html = patchHTML(html, board, 'active', metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
        console.log(`${String(issues.length).padStart(3)} issues — totalSP:${metrics.totalSP}  doneSP:${metrics.doneSP}  (${metrics.spRes}%)`);
      } catch (err) { console.log(`FAILED — ${err.message}`); }

      process.stdout.write(`  [${board.padEnd(6)}] (kanban) future... `);
      try {
        const issues = await fetchIssues(board, 'futureSprints()');
        if (!issues.length) { console.log('(no future sprint)'); }
        else {
          const byName = groupBySprint(issues, 'future');
          let count = 0;
          for (const [name, sprintIssues] of Object.entries(byName)) {
            const metrics         = calcMetrics(sprintIssues);
            const epicBreakdown   = buildEpicBreakdown(sprintIssues);
            const effortBreakdown = buildEffortBreakdown(sprintIssues);
            const ticketsPerDev   = buildTicketsPerDev(sprintIssues);
            html = patchHTMLBySprintName(html, name, 'future', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, '', board, em, '', '');
            count++;
          }
          console.log(`${count} future sprints synced`);
        }
      } catch (err) { console.log(`FAILED — ${err.message}`); }

      process.stdout.write(`  [${board.padEnd(6)}] (kanban) closed... `);
      try {
        const issues = await fetchIssues(board, 'closedSprints()');
        if (!issues.length) { console.log('(none)'); }
        else {
          const byName = groupBySprint(issues, 'closed');
          let count = 0;
          for (const [name, sprintIssues] of Object.entries(byName)) {
            const metrics         = calcMetrics(sprintIssues);
            const epicBreakdown   = buildEpicBreakdown(sprintIssues);
            const effortBreakdown = buildEffortBreakdown(sprintIssues);
            const ticketsPerDev   = buildTicketsPerDev(sprintIssues);
            html = patchHTMLBySprintName(html, name, 'closed', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, '', board, em, '', '');
            count++;
          }
          console.log(`${count} closed sprints synced`);
        }
      } catch (err) { console.log(`FAILED — ${err.message}`); }

      continue;
    }

    // ── Scrum board — Agile + Greenhopper sprint report path ─────────────────

    // Active sprint
    process.stdout.write(`  [${board.padEnd(6)}] active... `);
    try {
      const activeSprints = await fetchSprintList(boardId, 'active');
      if (!activeSprints.length) {
        console.log('(no active sprint)');
      } else {
        const sprint          = activeSprints[0];
        const metrics         = await fetchSprintReport(boardId, sprint.id);
        const issues          = await fetchIssuesBySprintName(board, sprint.name);
        const epicBreakdown   = buildEpicBreakdown(issues);
        const effortBreakdown = buildEffortBreakdown(issues);
        const ticketsPerDev   = buildTicketsPerDev(issues);
        const goal            = sprint.goal || await fetchSprintGoal(sprint.id);
        html = patchHTMLBySprintName(html, sprint.name, 'active', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, goal, board, em, sprint.startDate, sprint.endDate);
        console.log(`${String(metrics.issues).padStart(3)} issues — committedSP:${metrics.committedSP}  doneSP:${metrics.doneSP}  (${metrics.spRes}%)`);
      }
    } catch (err) { console.log(`FAILED — ${err.message}`); }

    // Future sprints
    process.stdout.write(`  [${board.padEnd(6)}] future... `);
    try {
      const futureSprints = await fetchSprintList(boardId, 'future');
      if (!futureSprints.length) {
        console.log('(no future sprints)');
      } else {
        let count = 0;
        for (const sprint of futureSprints) {
          const issues          = await fetchIssuesBySprintName(board, sprint.name);
          const metrics         = calcMetrics(issues);
          const epicBreakdown   = buildEpicBreakdown(issues);
          const effortBreakdown = buildEffortBreakdown(issues);
          const ticketsPerDev   = buildTicketsPerDev(issues);
          const goal            = sprint.goal || await fetchSprintGoal(sprint.id);
          html = patchHTMLBySprintName(html, sprint.name, 'future', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, goal, board, em, sprint.startDate, sprint.endDate);
          count++;
        }
        console.log(`${count} future sprints synced`);
      }
    } catch (err) { console.log(`FAILED — ${err.message}`); }

    // Closed sprints — full snapshot from Greenhopper (immutable, matches velocity chart)
    process.stdout.write(`  [${board.padEnd(6)}] closed... `);
    try {
      const closedSprints = await fetchSprintList(boardId, 'closed');
      if (!closedSprints.length) {
        console.log('(none)');
      } else {
        let count = 0;
        for (const sprint of closedSprints) {
          const snap            = await fetchSprintSnapshot(boardId, sprint.id);
          const metrics         = await fetchSprintReport(boardId, sprint.id);
          // Pull every issue that was in the sprint at close — by key, not by
          // current-sprint-membership, so reassignments after close don't
          // change what we render.
          const rawIssues       = await fetchIssuesByKeys(snap.allKeys);
          const issues          = applySnapshotToIssues(rawIssues, snap);
          const epicBreakdown   = buildEpicBreakdown(issues);
          const effortBreakdown = buildEffortBreakdown(issues);
          const ticketsPerDev   = buildTicketsPerDev(issues);
          const goal            = sprint.goal || await fetchSprintGoal(sprint.id);
          html = patchHTMLBySprintName(html, sprint.name, 'closed', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, goal, board, em, sprint.startDate, sprint.endDate);
          count++;
        }
        console.log(`${count} closed sprints synced`);
      }
    } catch (err) { console.log(`FAILED — ${err.message}`); }
  }

  const trigger = process.env.SYNC_TRIGGER === 'workflow_dispatch' ? 'manual' : 'schedule';
  html = html.replace(/id="data-banner"[^>]*/, `id="data-banner" data-synced-at="${new Date().toISOString()}" data-trigger="${trigger}"`);

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log('\nindex.html updated.');
}

main().catch(err => { console.error(err.message); process.exit(1); });

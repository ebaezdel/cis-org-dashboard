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
const GREENHOPPER_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/greenhopper/1.0`;
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

// ─── Agile API (sprint list) ──────────────────────────────────────────────────

// Returns [{id, name, state, startDate, endDate, goal}]
async function fetchSprintList(boardId, state) {
  let sprints = [], startAt = 0;
  while (true) {
    const data = await agileGet(`/board/${boardId}/sprint?state=${state}&startAt=${startAt}&maxResults=50`);
    sprints = sprints.concat(data.values || []);
    if (data.isLast || !(data.values || []).length) break;
    startAt += data.values.length;
  }
  return sprints;
}

// ─── Greenhopper sprint report (velocity-chart-accurate SP numbers) ───────────

// Returns metrics matching exactly what the Jira velocity chart shows.
// For active sprints: live current state. For closed: locked snapshot at close.
async function fetchSprintReport(boardId, sprintId) {
  const r = await greenphopper(`/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`);
  const c = r.contents || {};

  const completedIssues = c.completedIssues                    || [];
  const notCompleted    = c.issuesNotCompletedInCurrentSprint   || [];
  const punted          = c.puntedIssues                        || [];

  // committedSP = initial estimate of completed issues at sprint start (velocity "Commitment")
  // doneSP      = estimate of completed issues at sprint close (velocity "Completed")
  const committedSP = r1((c.completedIssuesInitialEstimateSum?.value  ?? 0) +
                         (c.issuesNotCompletedInitialEstimateSum?.value ?? 0));
  const doneSP      = r1(c.completedIssuesEstimateSum?.value          ?? 0);
  const pendingSP   = r1(c.issuesNotCompletedEstimateSum?.value        ?? 0);
  const totalSP     = r1(doneSP + pendingSP);
  const issues      = completedIssues.length + notCompleted.length + punted.length;
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
    if (!name) return;
    if (!map[name]) map[name] = [];
    map[name].push(issue);
  });
  return map;
}

function patchHTMLBySprintName(html, sprintName, sprintStatus, m, epicBreakdown, effortBreakdown, ticketsPerDev, sprintGoal) {
  const metricsRepl      = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}$1, spRes:${m.spRes}, velocity:${m.velocity}`;
  const payloadRepl      = `, epicBreakdown:${serializeEpicBreakdown(epicBreakdown)}, effortBreakdown:${serializeObj(effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(ticketsPerDev)}`;
  const sprintStatusRepl = `sprintStatus:'${sprintStatus}'`;

  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`sprintName:'${sprintName}'`)) return line;
    let updated = line.replace(METRICS_RE, metricsRepl);
    updated = updated.replace(PAYLOAD_RE, payloadRepl);
    updated = updated.replace(SPRINTSTATUS_RE, sprintStatusRepl);
    if (sprintGoal != null) updated = updated.replace(SPRINTGOAL_RE, `sprintGoal:${jsStr(sprintGoal)}`);
    if (updated !== line) found = true;
    return updated;
  });

  if (!found) process.stderr.write(`[WARN] No row found for sprintName:'${sprintName}'\n`);
  return result.join('\n');
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

  for (const { board, boardId } of BOARDS) {
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
            html = patchHTMLBySprintName(html, name, 'future', metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
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
            html = patchHTMLBySprintName(html, name, 'closed', metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
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
        html = patchHTMLBySprintName(html, sprint.name, 'active', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, sprint.goal || null);
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
          html = patchHTMLBySprintName(html, sprint.name, 'future', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, sprint.goal || null);
          count++;
        }
        console.log(`${count} future sprints synced`);
      }
    } catch (err) { console.log(`FAILED — ${err.message}`); }

    // Closed sprints
    process.stdout.write(`  [${board.padEnd(6)}] closed... `);
    try {
      const closedSprints = await fetchSprintList(boardId, 'closed');
      if (!closedSprints.length) {
        console.log('(none)');
      } else {
        let count = 0;
        for (const sprint of closedSprints) {
          const metrics         = await fetchSprintReport(boardId, sprint.id);
          const issues          = await fetchIssuesBySprintName(board, sprint.name);
          const epicBreakdown   = buildEpicBreakdown(issues);
          const effortBreakdown = buildEffortBreakdown(issues);
          const ticketsPerDev   = buildTicketsPerDev(issues);
          html = patchHTMLBySprintName(html, sprint.name, 'closed', metrics, epicBreakdown, effortBreakdown, ticketsPerDev, sprint.goal || null);
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

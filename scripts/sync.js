#!/usr/bin/env node
'use strict';

/**
 * sync.js — fetch live Jira sprint data and patch index.html
 *
 * Patches the full active-sprint row: SP metrics, epicBreakdown (with live
 * ticket statuses), effortBreakdown, and ticketsPerDev.
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

const CLOUD_ID  = 'cf0dc8c2-47a8-4929-8d48-2e03205ce9da';
const JIRA_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;
const HTML_PATH = path.join(__dirname, '..', 'index.html');

const BOARDS = [
  { board: 'FC',    em: 'Saloni'  },
  { board: 'CSS',   em: 'Saloni'  },
  { board: 'CEGEO', em: 'Saloni'  },
  { board: 'QAS',   em: 'Saloni'  },
  { board: 'TSC',   em: 'Maria'   },
  { board: 'MSV',   em: 'Maria'   },
  { board: 'RPS',   em: 'Maria'   },
  { board: 'FIND',  em: 'Maria'   },
  { board: 'TCET',  em: 'Marissa' },
  { board: 'CON',   em: 'Marissa' },
  { board: 'LHAPI', em: 'Marissa' },
  { board: 'TLCC',  em: 'Yan'     },
  { board: 'QUA',   em: 'Yan'     },
];

// ─── Jira REST ────────────────────────────────────────────────────────────────

function jiraGet(urlPath) {
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.get(
      `${JIRA_BASE}${urlPath}`,
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
}

async function fetchIssues(board, sprintClause) {
  const fields = [
    'summary', 'status', 'assignee', 'issuetype', 'labels',
    'customfield_10034', 'customfield_10016', 'customfield_10020', 'parent',
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

// ─── Metric helpers ───────────────────────────────────────────────────────────

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

function buildEffortBreakdown(issues) {
  const counts = {};
  issues.forEach(i => {
    const labels = i.fields?.labels || [];
    const type = labels.includes('Intake')    ? 'Intake'
               : labels.includes('KTLO')      ? 'KTLO'
               : labels.includes('AppSec')    ? 'AppSec'
               : labels.includes('TechDebt')  ? 'Tech Debt'
               : labels.includes('Bug')       ? 'Bug'
               : 'Feature';
    counts[type] = (counts[type] || 0) + 1;
  });
  const total = issues.length || 1;
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

const METRICS_RE = /, issues:\d+(?:\.\d+)?, totalSP:\d+(?:\.\d+)?, doneSP:\d+(?:\.\d+)?, pendingSP:\d+(?:\.\d+)?, inProgressSP:\d+(?:\.\d+)?, committedSP:\d+(?:\.\d+)?, spRes:\d+, velocity:\d+/;

// Matches the entire epicBreakdown+effortBreakdown+ticketsPerDev block on one line.
// Uses a non-greedy match inside brackets; works because each row is a single line.
const PAYLOAD_RE = /, epicBreakdown:\[.*\], effortBreakdown:\{[^}]*\}(?:, _hasStatusBreakdown:true)?, ticketsPerDev:\[.*\](?=\})/;

// Extract sprint name from customfield_10020 (array of sprint objects)
function getSprintName(issue) {
  const sprints = issue.fields?.customfield_10020;
  if (!Array.isArray(sprints) || !sprints.length) return null;
  // Prefer closed, then active, then future
  const order = { closed: 0, active: 1, future: 2 };
  const sorted = [...sprints].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
  return sorted[0]?.name || null;
}

// Group issues by sprint name
function groupBySprint(issues) {
  const map = {};
  issues.forEach(issue => {
    const name = getSprintName(issue);
    if (!name) return;
    if (!map[name]) map[name] = [];
    map[name].push(issue);
  });
  return map;
}

function patchHTMLBySprintName(html, sprintName, m, epicBreakdown, effortBreakdown, ticketsPerDev) {
  const metricsRepl = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}, spRes:${m.spRes}, velocity:${m.velocity}`;
  const payloadRepl = `, epicBreakdown:${serializeEpicBreakdown(epicBreakdown)}, effortBreakdown:${serializeObj(effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(ticketsPerDev)}`;

  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`sprintName:'${sprintName}'`)) return line;
    let updated = line.replace(METRICS_RE, metricsRepl);
    updated = updated.replace(PAYLOAD_RE, payloadRepl);
    if (updated !== line) found = true;
    return updated;
  });

  if (!found) process.stderr.write(`[WARN] No row found for sprintName:'${sprintName}'\n`);
  return result.join('\n');
}

function patchHTML(html, board, sprintStatus, m, epicBreakdown, effortBreakdown, ticketsPerDev) {
  const metricsRepl  = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}, spRes:${m.spRes}, velocity:${m.velocity}`;
  const payloadRepl  = `, epicBreakdown:${serializeEpicBreakdown(epicBreakdown)}, effortBreakdown:${serializeObj(effortBreakdown)}, _hasStatusBreakdown:true, ticketsPerDev:${serializeTicketsPerDev(ticketsPerDev)}`;

  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`board:'${board}'`) || !line.includes(`sprintStatus:'${sprintStatus}'`)) return line;
    let updated = line.replace(METRICS_RE, metricsRepl);
    updated = updated.replace(PAYLOAD_RE, payloadRepl);
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

  for (const { board } of BOARDS) {
    // Active sprint
    process.stdout.write(`  [${board.padEnd(6)}] active... `);
    try {
      const issues          = await fetchIssues(board, 'openSprints()');
      const metrics         = calcMetrics(issues);
      const epicBreakdown   = buildEpicBreakdown(issues);
      const effortBreakdown = buildEffortBreakdown(issues);
      const ticketsPerDev   = buildTicketsPerDev(issues);
      html = patchHTML(html, board, 'active', metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
      console.log(`${String(issues.length).padStart(3)} issues — totalSP:${metrics.totalSP}  doneSP:${metrics.doneSP}  (${metrics.spRes}%)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }

    // Future sprint
    process.stdout.write(`  [${board.padEnd(6)}] future... `);
    try {
      const issues          = await fetchIssues(board, 'futureSprints()');
      if (!issues.length) { console.log('(no future sprint)'); }
      else {
        const metrics         = calcMetrics(issues);
        const epicBreakdown   = buildEpicBreakdown(issues);
        const effortBreakdown = buildEffortBreakdown(issues);
        const ticketsPerDev   = buildTicketsPerDev(issues);
        html = patchHTML(html, board, 'future', metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
        console.log(`${String(issues.length).padStart(3)} issues — totalSP:${metrics.totalSP}  (future)`);
      }
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }

    // Closed sprints — only patch rows that exist in index.html and lack epicBreakdown data
    const closedRows = [...html.matchAll(new RegExp(`sprintName:'(${board}\\.[^']+)'[^}]+sprintStatus:'closed'[^}]+epicBreakdown:\\[\\]`, 'g'))]
      .map(m => m[1]);
    if (closedRows.length) {
      process.stdout.write(`  [${board.padEnd(6)}] closed (${closedRows.length} missing)... `);
      try {
        const issues = await fetchIssues(board, 'closedSprints()');
        if (!issues.length) { console.log('(no data)'); }
        else {
          const byName = groupBySprint(issues);
          let count = 0;
          for (const name of closedRows) {
            if (!byName[name]) continue;
            const sprintIssues    = byName[name];
            const metrics         = calcMetrics(sprintIssues);
            const epicBreakdown   = buildEpicBreakdown(sprintIssues);
            const effortBreakdown = buildEffortBreakdown(sprintIssues);
            const ticketsPerDev   = buildTicketsPerDev(sprintIssues);
            html = patchHTMLBySprintName(html, name, metrics, epicBreakdown, effortBreakdown, ticketsPerDev);
            count++;
          }
          console.log(`${count} rows updated`);
        }
      } catch (err) {
        console.log(`FAILED — ${err.message}`);
      }
    }
  }

  html = html.replace(/id="data-banner"[^>]*/, `id="data-banner" data-synced-at="${new Date().toISOString()}"`);

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log('\nindex.html updated.');
}

main().catch(err => { console.error(err.message); process.exit(1); });

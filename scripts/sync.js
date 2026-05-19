#!/usr/bin/env node
'use strict';

/**
 * sync.js — fetch live Jira sprint data and patch index.html
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

async function fetchActiveIssues(board) {
  const jql    = encodeURIComponent(`project = ${board} AND sprint in openSprints() ORDER BY created ASC`);
  const fields = 'customfield_10034,customfield_10016,status';
  let issues = [];
  let startAt = 0;

  while (true) {
    const data = await jiraGet(`/search?jql=${jql}&fields=${fields}&maxResults=100&startAt=${startAt}`);
    issues = issues.concat(data.issues || []);
    if (issues.length >= data.total) break;
    startAt += 100;
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
  return issue.fields?.status?.name === 'In Progress';
}

function r1(n) { return Math.round(n * 10) / 10; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function calcMetrics(issues) {
  const totalSP   = r1(issues.reduce((s, i) => s + sp(i), 0));
  const doneSP    = r1(issues.filter(isDone).reduce((s, i) => s + sp(i), 0));
  const inProgSP  = r1(issues.filter(isInProgress).reduce((s, i) => s + sp(i), 0));
  const pendingSP = r1(totalSP - doneSP);
  const spRes     = pct(doneSP, totalSP);
  return {
    issues:       issues.length,
    totalSP,
    doneSP,
    pendingSP,
    inProgressSP: inProgSP,
    committedSP:  totalSP,
    spRes,
    velocity:     spRes,
  };
}

// ─── HTML patcher ─────────────────────────────────────────────────────────────

// Active sprint rows are single lines; this regex targets the 8 mutable SP fields.
const METRICS_RE = /, issues:\d+(?:\.\d+)?, totalSP:\d+(?:\.\d+)?, doneSP:\d+(?:\.\d+)?, pendingSP:\d+(?:\.\d+)?, inProgressSP:\d+(?:\.\d+)?, committedSP:\d+(?:\.\d+)?, spRes:\d+, velocity:\d+/;

function patchHTML(html, board, m) {
  const replacement = `, issues:${m.issues}, totalSP:${m.totalSP}, doneSP:${m.doneSP}, pendingSP:${m.pendingSP}, inProgressSP:${m.inProgressSP}, committedSP:${m.committedSP}, spRes:${m.spRes}, velocity:${m.velocity}`;
  const lines = html.split('\n');
  let found = false;

  const result = lines.map(line => {
    if (!line.includes(`board:'${board}'`) || !line.includes(`sprintStatus:'active'`)) {
      return line;
    }
    const updated = line.replace(METRICS_RE, replacement);
    if (updated !== line) found = true;
    return updated;
  });

  if (!found) process.stderr.write(`[WARN] No active sprint row for ${board}\n`);
  return result.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
    process.stderr.write('Error: JIRA_EMAIL and JIRA_API_TOKEN must be set.\n');
    process.exit(1);
  }

  console.log(`=== Content Org Dashboard — Jira Sync  ${new Date().toISOString()} ===`);

  let html = fs.readFileSync(HTML_PATH, 'utf8');

  for (const { board } of BOARDS) {
    process.stdout.write(`  [${board.padEnd(6)}] fetching... `);
    try {
      const issues  = await fetchActiveIssues(board);
      const metrics = calcMetrics(issues);
      html = patchHTML(html, board, metrics);
      console.log(`${String(issues.length).padStart(3)} issues — totalSP:${metrics.totalSP}  doneSP:${metrics.doneSP}  (${metrics.spRes}%)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log('\nindex.html updated.');
}

main().catch(err => { console.error(err.message); process.exit(1); });

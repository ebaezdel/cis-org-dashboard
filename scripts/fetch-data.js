#!/usr/bin/env node
/**
 * fetch-data.js — pull live Jira data via Atlassian MCP and write to data/snapshot.json
 *
 * Run via Claude Code with MCP enabled:
 *   node scripts/fetch-data.js
 *
 * Requires: Atlassian MCP authenticated (run /mcp → atlassian → Okta SSO)
 * Output:   data/snapshot.json  (consumed by index.html)
 *           data/<em>.md        (Git-trackable snapshots per EM)
 *
 * Jira hierarchy:
 *   Objective   (INI, hierarchyLevel:3)
 *   Initiative  (INI, hierarchyLevel:2)
 *   Epic        (board project, hierarchyLevel:1)
 *   Story       (board project, hierarchyLevel:0)
 *
 * SP fields: customfield_10034 (classic), customfield_10016 (next-gen)
 * Sprint:    customfield_10020
 * Cloud ID:  cf0dc8c2-47a8-4929-8d48-2e03205ce9da (moveinc.atlassian.net)
 */

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

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

const SP_FIELDS  = 'customfield_10034,customfield_10016,customfield_10020';
const SPRINT_FLD = 'customfield_10020';
const OUT_DIR    = path.join(__dirname, '..', 'data');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sp(issue) {
  const f = issue.fields;
  return (f.customfield_10034 ?? f.customfield_10016 ?? 0) || 0;
}

function sprintInfo(issue) {
  const arr = issue.fields?.[SPRINT_FLD];
  if (!Array.isArray(arr) || !arr.length) return null;
  // pick active sprint, else most recent closed
  return arr.find(s => s.state === 'active') || arr[arr.length - 1];
}

function parseFyQ(sprintName) {
  const m = (sprintName || '').match(/FY(\d+)\.Q(\d)/i);
  return m ? { fy: 'FY' + m[1], quarter: 'Q' + m[2] } : { fy: 'FY26', quarter: 'Q4' };
}

function parseSprintNum(sprintName) {
  const m = (sprintName || '').match(/S(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

function pct(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── JQL builders ─────────────────────────────────────────────────────────────

function jqlActiveSprint(board) {
  return `project = ${board} AND sprint in openSprints() ORDER BY created ASC`;
}

function jqlClosedSprints(board, n = 3) {
  return `project = ${board} AND sprint in closedSprints() ORDER BY sprint DESC`;
}

function jqlINIObjectives() {
  return `project = INI AND issuetype in standardIssueTypes() AND "Epic Link" is EMPTY AND parent is EMPTY ORDER BY key ASC`;
}

function jqlINITree() {
  // Fetch all INI issues (Objectives + Initiatives) at once
  return `project = INI ORDER BY hierarchyLevel DESC, key ASC`;
}

function jqlEpicsForINI(iniKey) {
  return `"Epic Link" = ${iniKey} OR parent = ${iniKey} ORDER BY key ASC`;
}

function jqlBacklog(board) {
  return `project = ${board} AND sprint is EMPTY AND resolution = Unresolved AND issuetype in (Story, Task, Bug)`;
}

// ─── Transform helpers ────────────────────────────────────────────────────────

function buildSprintRow(em, board, sprint, issues) {
  const active     = issues.filter(i => i.fields.status?.name !== 'Done');
  const inProgress = issues.filter(i => i.fields.status?.name === 'In Progress');
  const done       = issues.filter(i => i.fields.status?.name === 'Done');
  const totalSP    = issues.reduce((s, i) => s + sp(i), 0);
  const doneSP     = done.reduce((s, i)   => s + sp(i), 0);
  const inProgSP   = inProgress.reduce((s, i) => s + sp(i), 0);
  const pendSP     = active.reduce((s, i) => s + sp(i), 0);

  const byDev = {};
  issues.forEach(i => {
    const dev = i.fields.assignee?.name || i.fields.assignee?.displayName || 'unassigned';
    if (!byDev[dev]) byDev[dev] = { tickets: 0, sp: 0 };
    byDev[dev].tickets++;
    byDev[dev].sp += sp(i);
  });

  const effort = {};
  issues.forEach(i => {
    const labels = i.fields.labels || [];
    const type   = labels.includes('KTLO') ? 'KTLO'
                 : labels.includes('AppSec') ? 'AppSec'
                 : labels.includes('TechDebt') ? 'Tech Debt'
                 : labels.includes('Bug') ? 'Bug'
                 : 'Feature';
    effort[type] = (effort[type] || 0) + 1;
  });
  const total = issues.length || 1;
  const effortBreakdown = Object.fromEntries(
    Object.entries(effort).map(([k, v]) => [k, Math.round((v / total) * 100)])
  );

  const sInfo  = sprint;
  const fyq    = parseFyQ(sInfo?.name || '');

  return {
    em,
    board,
    sprintName:   sInfo?.name || '',
    sprintGoal:   sInfo?.goal || '—',
    sprintStatus: sInfo?.state === 'active' ? 'active' : sInfo?.state === 'closed' ? 'closed' : 'none',
    fy:           fyq.fy,
    quarter:      fyq.quarter,
    sprint:       parseSprintNum(sInfo?.name || ''),
    issues:       issues.length,
    totalSP:      Math.round(totalSP * 10) / 10,
    doneSP:       Math.round(doneSP  * 10) / 10,
    pendingSP:    Math.round(pendSP   * 10) / 10,
    inProgressSP: Math.round(inProgSP * 10) / 10,
    committedSP:  Math.round(totalSP  * 10) / 10,
    deltaSP:      0,
    spRes:        pct(doneSP, totalSP),
    velocity:     pct(doneSP, totalSP),
    unplannedPct: 0,
    plannedPct:   100,
    effortBreakdown,
    ticketsPerDev: Object.entries(byDev)
      .sort((a, b) => b[1].tickets - a[1].tickets)
      .map(([dev, { tickets, sp }]) => ({ dev, tickets, sp: Math.round(sp * 10) / 10 })),
    backlogSprints: 0, // filled later
  };
}

// ─── INI helpers ──────────────────────────────────────────────────────────────

function buildININode(issue) {
  const f = issue.fields;
  return {
    key:         issue.key,
    summary:     f.summary,
    status:      f.status?.name || 'Unknown',
    priority:    f.priority?.name || 'Medium',
    assignee:    f.assignee?.displayName || 'Unassigned',
    spEstimate:  sp(issue),
    spDone:      f.status?.name === 'Done' ? sp(issue) : 0,
    hierarchyLevel: f.hierarchyLevel ?? (f.issuetype?.name === 'Epic' ? 1 : 0),
    issueType:   f.issuetype?.name || 'Story',
    parentKey:   f.parent?.key || f['Epic Link'] || null,
    url:         `https://moveinc.atlassian.net/browse/${issue.key}`,
    children:    [],
  };
}

function buildINITree(iniIssues) {
  const map = {};
  iniIssues.forEach(i => { map[i.key] = buildININode(i); });

  const roots = [];
  Object.values(map).forEach(node => {
    if (node.parentKey && map[node.parentKey]) {
      map[node.parentKey].children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// ─── Main fetch logic (called from Claude Code with MCP tools) ────────────────
// This script is designed to be run by Claude Code which has MCP tool access.
// When run standalone (node fetch-data.js), it prints the JQL queries to copy.
// When Claude Code runs it, replace the mcp* calls with actual tool invocations.

async function fetchAllData() {
  ensure(OUT_DIR);
  console.log('=== Content Org Dashboard — Data Fetch ===');
  console.log('Date:', new Date().toISOString());
  console.log('');

  // ── Sprint data ──────────────────────────────────────────────────────────────
  console.log('JQL queries to run for sprint data:');
  BOARDS.forEach(({ board }) => {
    console.log(`  [${board}] Active: ${jqlActiveSprint(board)}`);
    console.log(`  [${board}] Closed: ${jqlClosedSprints(board, 3)}`);
  });

  // ── INI data ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log('JQL for INI hierarchy:');
  console.log(' ', jqlINITree());

  // ── Backlog ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log('JQL for backlog health (per board):');
  BOARDS.forEach(({ board }) => {
    console.log(`  [${board}] ${jqlBacklog(board)}`);
  });

  console.log('');
  console.log('When run via Claude Code MCP, data is written to data/snapshot.json');
  console.log('Use /rdc-os:jira to trigger live fetch, or run this script inside Claude Code session.');
}

// ─── When invoked from Claude Code, use real MCP calls ────────────────────────
// The actual MCP-powered fetch is in the mcpFetch() function below.
// Claude Code will call this when executing with --mcp flag.

/**
 * mcpFetch — the actual live-data version.
 * To run: paste this into a Claude Code session with Atlassian MCP authenticated.
 * Output is written to data/snapshot.json.
 *
 * Usage from Claude Code prompt:
 *   Run scripts/fetch-data.js via Node in the content-org-dashboard directory
 */
async function mcpFetch(mcpTools) {
  const { searchJiraIssues, getJiraIssue } = mcpTools;
  ensure(OUT_DIR);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    sprints:     [],
    inis:        [],
    objectives:  [],
  };

  // Fetch INI hierarchy
  const iniResult = await searchJiraIssues({
    jql:        jqlINITree(),
    maxResults: 200,
    fields:     `summary,status,priority,assignee,issuetype,parent,hierarchyLevel,${SP_FIELDS}`,
  });
  snapshot.inis = iniResult.issues?.nodes || [];

  // Fetch sprint data per board
  for (const { board, em } of BOARDS) {
    // Active sprint
    const activeResult = await searchJiraIssues({
      jql:        jqlActiveSprint(board),
      maxResults: 100,
      fields:     `summary,status,assignee,labels,${SP_FIELDS}`,
    });
    const activeIssues = activeResult.issues?.nodes || [];

    // Get sprint object from first issue
    const activeSprint = activeIssues[0] ? sprintInfo(activeIssues[0]) : null;
    if (activeSprint || activeIssues.length) {
      snapshot.sprints.push(buildSprintRow(em, board, activeSprint, activeIssues));
    } else {
      snapshot.sprints.push({
        em, board, sprintName: '', sprintGoal: '—', sprintStatus: 'none',
        fy: 'FY26', quarter: 'Q4', sprint: 0,
        issues: 0, totalSP: 0, doneSP: 0, pendingSP: 0, inProgressSP: 0,
        committedSP: 0, deltaSP: 0, spRes: 0, velocity: 0,
        unplannedPct: 0, plannedPct: 100, effortBreakdown: {}, ticketsPerDev: [],
        backlogSprints: 0,
      });
    }

    // Last 3 closed sprints (paginated)
    const closedResult = await searchJiraIssues({
      jql:        jqlClosedSprints(board, 3),
      maxResults: 150,
      fields:     `summary,status,assignee,labels,${SP_FIELDS}`,
    });

    // Group by sprint
    const sprintGroups = {};
    (closedResult.issues?.nodes || []).forEach(issue => {
      const s = sprintInfo(issue);
      if (!s) return;
      if (!sprintGroups[s.id]) sprintGroups[s.id] = { sprint: s, issues: [] };
      sprintGroups[s.id].issues.push(issue);
    });

    const sortedClosed = Object.values(sprintGroups)
      .sort((a, b) => new Date(b.sprint.endDate || 0) - new Date(a.sprint.endDate || 0))
      .slice(0, 3);

    sortedClosed.forEach(({ sprint, issues }) => {
      snapshot.sprints.push(buildSprintRow(em, board, sprint, issues));
    });

    // Backlog count
    const blResult = await searchJiraIssues({
      jql:        jqlBacklog(board),
      maxResults: 1,
      fields:     'summary',
    });
    const blCount = blResult.total || 0;
    // avg sprint velocity (from active sprint totalSP as proxy)
    const avgVel  = activeIssues.reduce((s, i) => s + sp(i), 0) || 30;
    const blSprints = avgVel > 0 ? Math.round(blCount / (avgVel / 2)) : 0;

    // Patch backlogSprints into this board's rows
    snapshot.sprints
      .filter(r => r.board === board)
      .forEach(r => { r.backlogSprints = blSprints; });
  }

  // Write snapshot
  fs.writeFileSync(
    path.join(OUT_DIR, 'snapshot.json'),
    JSON.stringify(snapshot, null, 2)
  );
  console.log(`Written: data/snapshot.json (${snapshot.sprints.length} sprint rows, ${snapshot.inis.length} INI issues)`);

  // Write per-EM markdown files for git tracking
  const ems = [...new Set(BOARDS.map(b => b.em))];
  ems.forEach(em => {
    const rows = snapshot.sprints.filter(r => r.em === em && r.sprintStatus === 'active');
    let md = `# ${em} — Sprint Health Snapshot\n_Generated: ${snapshot.generatedAt}_\n\n`;
    rows.forEach(r => {
      md += `## ${r.board} — ${r.sprintName || 'No active sprint'}\n`;
      md += `- Status: ${r.sprintStatus}\n`;
      md += `- SP Committed: ${r.committedSP} | Done: ${r.doneSP} | Pending: ${r.pendingSP}\n`;
      md += `- Velocity: ${r.velocity}% | SP Resolution: ${r.spRes}%\n`;
      md += `- Backlog: ${r.backlogSprints} qualifying sprints\n\n`;
    });
    fs.writeFileSync(path.join(OUT_DIR, `${em.toLowerCase()}.md`), md);
    console.log(`Written: data/${em.toLowerCase()}.md`);
  });

  return snapshot;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (require.main === module) {
  fetchAllData().catch(console.error);
}

module.exports = { fetchAllData, mcpFetch, jqlActiveSprint, jqlClosedSprints, jqlINITree, jqlBacklog, BOARDS };

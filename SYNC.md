# Manual Jira Sync

## Quick Sync — Claude Code with Atlassian MCP

Paste the prompt below into a Claude Code session with the Atlassian MCP authenticated (`/mcp` → atlassian → Okta SSO).

---

Run the live Jira data sync for the content-org-dashboard:

1. Use `searchJiraIssuesUsingJql` (Atlassian MCP) to fetch active sprint issues for each board.
   Boards: FC, CSS, CEGEO, QAS, TSC, MSV, RPS, FIND, TCET, CON, LHAPI, TLCC, QUA
   JQL per board: `project = BOARD AND sprint in openSprints()`
   Fields: `summary,status,customfield_10034,customfield_10016`

2. For each board, calculate:
   - `issues`: total issue count
   - `totalSP`: sum of (customfield_10034 ?? customfield_10016 ?? 0)
   - `doneSP`: SP where status.statusCategory.key === 'done'
   - `pendingSP`: SP for issues that are not done
   - `inProgressSP`: SP where status.name === 'In Progress'
   - `committedSP`: same as totalSP
   - `spRes` and `velocity`: Math.round(doneSP / totalSP * 100), or 0

3. In `/Users/ezdrazbaez/content-org-dashboard/index.html`, find the line for each
   board's active sprint row (contains `board:'BOARDNAME'` and `sprintStatus:'active'`)
   and replace those eight numeric fields with the new values.

4. Save index.html.

---

## Automated Sync — GitHub Actions

The workflow `.github/workflows/daily-sync.yml` runs `node scripts/sync.js` automatically
at 7:00 AM CST Mon–Fri, and can also be triggered manually from the GitHub Actions tab.

**Required GitHub Secrets** (Settings → Secrets and variables → Actions):
- `JIRA_EMAIL` — your Atlassian account email
- `JIRA_API_TOKEN` — create at https://id.atlassian.com/manage-profile/security/api-tokens

**Manual trigger:** GitHub → Actions → "Daily Jira Sync" → "Run workflow"

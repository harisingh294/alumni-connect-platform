# Deploying Alumni Connect

The Phase 2 rules need a public link that keeps working until **31 March 2027**. The demo cannot be recorded on localhost. This guide deploys the app to Render with a persistent disk. Any host that runs Docker and offers a persistent volume works the same way, including Railway and Fly.io.

## What you need

- A GitHub repository with this folder pushed to it. Your faculty mentor needs read access, so add them as a collaborator.
- A Render account with a paid "Starter" web service (about USD 7 per month). Free instances have no persistent disk, so every deploy would erase your partners' data.
- A strong `PLATFORM_ADMIN_PASSWORD` of 12 or more characters, kept in a password manager. Never commit it.

## Steps

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and pick the repository. Render reads `render.yaml` and creates:
   - **The web service** runs from the `Dockerfile`.
   - **A 1 GB disk** is mounted at `/var/data`, where the SQLite database lives.
   - **`JWT_SECRET`** is generated randomly by Render.
3. When Render asks, set:
   - `PLATFORM_ADMIN_EMAIL` to the team's shared ops address.
   - `PLATFORM_ADMIN_PASSWORD` to the strong password.
4. Deploy. On first start, the logs should show:
   ```
   [bootstrap] Platform account created for <your email>
   [bootstrap] Reviewer sandbox loaded
   Alumni Connect Platform Server Running
   ```
5. Open the URL in a fresh incognito window and run the three "Try this" tasks from `02_MVP_Access`.
6. Optionally, add a custom domain under Render → Settings → Custom Domains.

## Running it day to day

| Task | How |
| :--- | :--- |
| Reset the reviewer sandbox before a live review | Platform console → Reviewer sandbox → **Rebuild sandbox now**, or `npm run seed:sandbox` in the Render shell |
| Back up the database | Render shell: `npm run backup`. This writes `/var/data/backups/…db` and keeps the last 14 copies. Download one copy weekly. |
| See usage evidence for a partner | Platform console → Usage evidence → **Download CSV** |
| Export the feedback log | Platform console → Feedback log → **Download for Google Sheets**, then in Sheets use File → Import |
| Health check | `GET /api/health` returns `{"status":"ok"}` |

## Safety rails already in the code

- **The full reset (`npm run seed`) refuses to run when `NODE_ENV=production`.** Only `npm run seed:sandbox` is allowed, and it touches the fictional institutions only.
- **One-click demo login is disabled in production.** Reviewers sign in with the sandbox password like any user.
- **Sandbox and real data are kept apart.** Sandbox accounts see only sandbox institutions, and real users never see them. Sandbox activity is excluded from revenue, usage evidence and the feedback log.
- **The platform account comes from environment variables.** No platform password is stored in the code.

## Environment variables

| Variable | Required | Meaning |
| :--- | :--- | :--- |
| `JWT_SECRET` | Yes | Signs login sessions. The server refuses to start without it. |
| `NODE_ENV` | Yes | Set to `production` on the host. |
| `DATA_DIR` | Yes | Folder on the persistent disk, for example `/var/data`. |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | Yes | Creates the platform-team login on first start. |
| `SANDBOX` | Recommended | `on` loads the reviewer sandbox when none exists. |
| `PLATFORM_ADMIN_RESET_PASSWORD` | No | `true` resets the platform password from the environment once. Remove it afterwards. |
| `ENABLE_DEMO_LOGIN` | No | Leave unset in production. |

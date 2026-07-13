# Nexus — Team Task Tracker

A Kanban-style task tracker with team hierarchy, role-based permissions, and a
performance dashboard. This version runs as a real Node.js server so it can
live on your company server, and it stores all data (teams, members, tasks) as
rows in a Google Sheet.

## What you get

- Real login (owner password + per-member username/password, hashed with bcrypt)
- Roles: Owner (you), Team Leaders, Members
- Members only ever see their own tasks
- Only the owner/team leaders can add, edit, delete tasks, and approve items in "Submitted for Review"
- Only the owner can add/remove team members
- A Dashboard tab showing on-time completion stats per member
- Multiple people can use it at the same time — the server serializes writes so nothing gets lost
- Data lives in a Google Sheet, so you get Sheets' built-in version history as your backup/recovery system, plus a manual "Export snapshot" button in the app

---

## 1. Set up Google Sheets access (one-time)

You need a **service account** — a robot Google account your server uses to
read/write the spreadsheet on your behalf, without needing anyone to log into
Google interactively.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or use an existing one).
2. In the left menu, go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → Service account**. Give it any name (e.g. "nexus-bot") and click through the defaults.
4. Open the service account you just created → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file — keep it private, do not commit it anywhere public.
5. Open that JSON file. You need two values from it:
   - `client_email` → goes in `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → goes in `GOOGLE_PRIVATE_KEY` (keep the quotes and `\n` characters exactly as they appear)

## 2. Create the Google Sheet

1. Create a new Google Sheet at [sheets.google.com](https://sheets.google.com).
2. Rename the default tab (bottom-left) to `Config`. Then add three more tabs named exactly: `Teams`, `Members`, `Tasks` (case-sensitive, spelled exactly like this).
3. Click **Share** (top-right) and share the sheet with the `client_email` from step 1, giving it **Editor** access.
4. Copy the Sheet ID from the URL — it's the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

You can leave all four tabs completely empty — the app writes the header rows
and data automatically the first time it runs.

## 3. Configure the server

```bash
cd nexus-server
cp .env.example .env
```

Open `.env` and fill in:
- `JWT_SECRET` — any long random string (used to sign login sessions)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` — from step 1
- `GOOGLE_SHEET_ID` — from step 2
- `PORT` — leave as 3000, or change if that port is taken on your server

## 4. Install and run

```bash
npm install
npm start
```

Then open `http://<your-server>:3000` in a browser. The **first person** to
open it will be prompted to set the owner password — that should be you.
After that, log in as owner and use "+ Member" in the sidebar to create
accounts for team leaders and members, assigning each to one of the four teams.

## 5. Running it permanently on your company server

`npm start` runs it in the foreground. For a real deployment, use a process
manager so it restarts automatically and keeps running after you log out, for example:

```bash
npm install -g pm2
pm2 start server.js --name nexus
pm2 save
pm2 startup
```

Put it behind your existing reverse proxy (nginx/Apache) with HTTPS if people
will access it beyond your local network, and restrict access to your company
network/VPN if this shouldn't be public.

## 5b. Deploying to Vercel instead (free, no credit card)

This project is already set up to deploy on Vercel as-is — no code changes needed.

1. Push this project to a GitHub repository (see the note at the end about `.gitignore`).
2. Go to [vercel.com](https://vercel.com) → sign up (no card required) → **Add New Project** → import your GitHub repo.
3. Vercel will detect `vercel.json` automatically. Leave the build settings as default.
4. Before deploying, go to **Environment Variables** and add the same four values from your `.env` file: `JWT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID`.
5. Click **Deploy**. You'll get a free URL like `nexus-yourname.vercel.app`.

**One thing worth knowing:** on Vercel, each request may run in a fresh, separate
instance of your code. The in-memory "lock" that keeps two people's saves from
colliding (in `lib/sheets.js`) only protects requests handled by the *same*
instance. In practice this is a low-probability edge case for a small team —
someone would need to save at almost exactly the same moment — but it isn't as
airtight as running this on a single always-on server (like your company
server, or Render/Railway). If two people saving at the exact same time is a
real concern for your team, prefer the traditional server deployment in
section 5 over Vercel.

## Notes on security

- Passwords are hashed with bcrypt before being stored — not plain text.
- This is a lightweight access-control system suitable for an internal, trusted
  team. It has not been through a formal security audit — if you'll store
  sensitive data, have someone review it first.
- Keep your `.env` file and the service account JSON key private — anyone with
  `GOOGLE_PRIVATE_KEY` has full read/write access to your sheet.

## Backups & recovery

- Google Sheets keeps automatic version history: open the sheet directly and
  go to **File → Version history → See version history** to restore any past
  state.
- The app's sidebar also has an "Export snapshot" button that downloads the
  current board as a `.json` file for an extra manual backup.

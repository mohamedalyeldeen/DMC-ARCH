# Click — Team Task Tracker

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
3. Go to **APIs & Services → Credentials → Create Credentials → Service account**. Give it any name (e.g. "click-bot") and click through the defaults.
4. Open the service account you just created → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file — keep it private, do not commit it anywhere public.
5. Open that JSON file. You need two values from it:
   - `client_email` → goes in `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → goes in `GOOGLE_PRIVATE_KEY` (keep the quotes and `\n` characters exactly as they appear)

## 2. Create the Google Sheet

1. Create a new Google Sheet at [sheets.google.com](https://sheets.google.com).
2. Rename the default tab (bottom-left) to `Config`. Then add tabs named exactly: `Teams`, `Members`, `Tasks`, `Notifications`, `Achievements` (case-sensitive, spelled exactly like this).
3. Click **Share** (top-right) and share the sheet with the `client_email` from step 1, giving it **Editor** access.
4. Copy the Sheet ID from the URL — it's the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

You can leave all tabs completely empty — the app writes the header rows
and data automatically the first time it runs.

## 3. Configure the server

```bash
cd click-server
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
pm2 start server.js --name click
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
5. Click **Deploy**. You'll get a free URL like `click-yourname.vercel.app`.

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

## Task assignment email notifications

Whenever the owner or a team leader assigns a task to someone (or reassigns an
existing task to a different person), that person gets an email if you've set
their **company email** in the "+ Member" / edit-member form and configured
the mailbox below.

**Setup:**
1. Add these to your `.env` (replace with a real mailbox in your company's Microsoft 365 tenant):
   ```
   SMTP_HOST=smtp.office365.com
   SMTP_PORT=587
   SMTP_USER=click-notifications@yourcompany.com
   SMTP_PASS=the-mailbox-password
   SMTP_FROM_NAME=Click
   ```
2. When adding/editing a team member, fill in their **Company email** (e.g.
   `Mohamed.M.Gad@dmc-curve.com`) so notifications have somewhere to go.
3. That's it — assigning or reassigning a task now sends them an email automatically.

**Important caveat about this method:** this uses "Basic Auth" (plain
username + password) to send through Outlook. Microsoft has announced it will
disable this by default for most company tenants by the **end of December
2026** (their timeline has shifted before, so treat this as an estimate, not
a guarantee). When that happens, email sending will start failing with an
authentication error, and someone will need to either have your IT admin
re-enable Basic Auth for this mailbox, or migrate this to Microsoft Graph API
with an OAuth app registration instead (a more involved but longer-lasting
setup — ask if you want that built later).

If your company's mailbox requires multi-factor authentication, you may need
an **app password** for `SMTP_PASS` instead of the normal login password —
ask whoever manages your Microsoft 365 admin account to generate one.


## Task scheduling (Start/End dates, overlap prevention, auto-sequencing)

Each task can now have a Start Date and End Date (separate from the existing
Due Date, which is still used for the on-time completion stats on the
Dashboard tab).

When assigning or editing a task, owners and team leaders have two ways to set its dates:

- **Manual dates** — pick a Start and End date directly. If it overlaps with
  another task already scheduled for that person, you'll get a validation
  error unless you check **"Allow Task Overlap."**
- **Auto-schedule** (new tasks only) — instead of picking dates, give a
  duration in days and choose where in that person's queue it goes ("At the
  beginning" or "After [existing task]"). The scheduling engine
  (`lib/scheduler.js`) automatically calculates its dates and shifts every
  later task in that person's queue forward by the same number of days, so
  nothing overlaps and every task keeps its original length.

Deleting a task automatically closes the gap it leaves behind, shifting that
person's later tasks backward to stay contiguous.

All of this date math lives in one file, `lib/scheduler.js`, so future
features (capacity view, Gantt chart, etc.) can reuse the same logic instead
of duplicating it.

**Note:** existing tasks created before this update won't have Start/End
dates — that's fine, they just won't show a date range on their card until
you edit them and set one.

## Phase 2: Self-assignment & task duplication

**Team leader self-assignment** — team leaders (and the owner) can now assign
a task to themselves, not just to the people who report to them. Their own
self-assigned tasks also show up in their Dashboard tab and team performance
table.

**Duplicate task** — click the ⧉ button on any ticket you can manage to copy
its title, description, and priority to a new task. You can duplicate it
back to the same person, or to one or more other engineers you're allowed to
assign to, in a single step. Duplicates always start with no dates set (so
they don't immediately conflict with the original) — set fresh Start/End
dates on each copy afterward, either manually or with auto-schedule.

**Update:** duplicating a task now copies its Start/End dates too (not
left blank). Duplicating to the *same* assignee will always overlap the
original by definition, so "Allow Task Overlap" is automatically checked
in that case — uncheck it if you want the safety check enforced anyway.
Duplicating to *other* engineers still checks for overlaps against their
existing schedule unless you check that box yourself.

## Phase 3: In-app notifications

Engineers now get an in-app notification (separate from email, which stays
optional) whenever they receive a new task, get reassigned a task, or one
of their tasks is updated. This uses a new **Notifications** tab in your
Google Sheet, created automatically the first time a notification fires —
no manual setup needed.

**What it looks like:**
- A 🔔 bell button in the top bar (next to the role badge) shows an unread count badge.
- Clicking it opens a panel listing every notification, newest first, with a timestamp.
- Clicking a notification marks it as read; there's also a "Mark all as read" button.
- The owner doesn't get notifications (they already see the whole board), only members and team leaders do.

No new environment variables needed — this uses the same Google Sheets connection as everything else.

## Phase 4: Capacity tab, Estimated vs Actual, and owner name

**Your name instead of "The board owner"** — click the new **"Name"** button
in the top bar (next to Password) to set your real name. It's used in
notifications and emails from then on, e.g. "New task assigned by Mohamed
Abdelrahman" instead of "The board owner." New deployments now also ask for
this during first-time setup.

**Capacity tab** — a new tab (owner and team leaders only) showing every
engineer they can see, with: how many open tasks they're carrying, how many
days of work that adds up to, a capacity % bar (based on a 14-day rolling
window), and when they're next free. Sortable by availability or by capacity %.

**Estimated vs Actual (in the Dashboard tab)** — compares planned duration
(Start → End date) against how long a task actually took (from when it was
moved to "In Progress" to when it was completed), across completed tasks.
Shows Estimated days, Actual days, the Difference, and a Completion
Efficiency %. Filterable by Engineer, Team, and a date range (based on
completion date). Team leaders and the owner get all three filters; regular
members just see their own numbers with a date range filter.

No new environment variables or manual Sheet setup needed for any of this.

## Phase 5: Undo, Gantt view, and a Friday/Saturday work week

### Undo (board actions only)

There's now an **Undo** button in the top bar next to your role badge. It
covers the actions where a mistake is most costly: creating, editing,
deleting, moving, and duplicating tasks. It only appears once you've done
something undoable, and it always shows what it's about to undo, e.g.
"↺ Undo: Deleted 'Fix login bug'".

**How it works:** every time you take one of those actions, the browser
tab remembers how to reverse it (up to the last 20 actions) and forgets the
oldest one once that's full. Clicking Undo replays the reverse of your most
recent action — deleting a task you just created, putting a deleted task
back exactly where it was (including its place in that person's schedule),
reverting an edit, moving a card back, or removing a duplicate.

**The one real limitation:** this history lives only in your browser tab,
for your current login. Reload the page, log out, or close the tab and it's
gone — there's no server-side undo log. It's also a best-effort replay
against whatever the board looks like *right now*, so if someone else edited
or moved the same task in the meantime, Undo can fail (you'll get a clear
error) or land slightly differently than a perfect rewind would. For
anything higher-stakes than that, Google Sheets' own version history (see
**Backups & recovery** above) is still the durable safety net.

### Gantt view

A new **Gantt** tab sits next to Board on the top bar, for anyone logged in
— it reuses the exact same task/team/member data as the board, so there's
nothing new to configure.

- **Group by engineer or by team** — toggle at the top of the view. "By
  team" adds a header row per team above that team's engineers.
- **Zoom: Day / Week / Month** — changes both the timeline's granularity
  and how much of it fits on screen at once.
- **Color by status** — grey (To Do), amber (In Progress), teal
  (Submitted), green (Done) — matching the board's own column colors.
- **Overdue tasks** get a red outline regardless of status color.
- **Weekends are shaded** on the timeline (see the Friday/Saturday section
  below) and a today-marker line runs down the whole chart.
- Tasks without a start/end date aren't shown on the timeline (there's
  nothing to plot) — a small note above the chart tells you how many are
  hidden for that reason.

Two things are intentionally *not* fully built yet, but the view is
structured so they're straightforward to add on top:

- **Drag-and-drop rescheduling** — every bar is already `draggable`, and
  every engineer's row is already a drop target. Right now, dropping a bar
  just computes a target date and logs it to the browser console instead of
  actually moving the task (see `wireGanttDragScaffold()` in `app.js`) —
  hook that computed date into the same task-edit call the task modal uses
  (so it gets the same overlap and weekend checks) to turn this on for real.
- **Task dependencies** — there's no `dependsOn` field on tasks yet, so
  `renderGanttDependencyLines()` in `app.js` is a deliberate no-op today.
  Once tasks can reference the task(s) they depend on, that function is
  where connector lines between bars would get drawn.

### Friday/Saturday work week

Click now assumes a **Friday/Saturday weekend** throughout the scheduling
engine — this matches the region the original deployment (dmc-curve.com)
operates in. Two concrete effects:

1. **Task durations skip weekends.** A task's "Duration (working days)" in
   auto-schedule mode no longer counts Fridays or Saturdays — a 5-day task
   starting Wednesday runs Wed, Thu, (skips Fri/Sat), Sun, Mon, Tue. When one
   task shifts another (inserting, deleting, or restoring a task in someone's
   queue), the shift is calculated in working days too, so a shift never
   re-introduces a Friday or Saturday as another task's start or end date.
2. **Nobody can be assigned to start or end a task on a Friday or Saturday.**
   This is enforced on the server (the real source of truth) for manually
   picked Start/End dates — you'll get a clear error if you try. The task
   form also checks this immediately as you pick a date, so you don't have
   to wait for a round-trip to find out. Auto-scheduled dates are computed
   by the scheduling engine itself and always land on a working day, so
   there's nothing to check there.

If your team's actual weekend is different (e.g. Saturday/Sunday), the
working-week rule lives in one place — `isNonWorkingDay()` in
`lib/scheduler.js` (and its client-side mirror, `isWeekendIso()` in
`public/app.js`) — change the day-of-week check there and both the
scheduling math and the Gantt view's weekend shading follow.

## Phase 6: Recognition — celebrations, achievements, personal stats, Click Score

A quiet, professional recognition layer sits on top of the existing board —
nothing about how tasks are created, assigned, or scheduled changes.

**One-time setup for existing deployments:** add a new tab to your Google
Sheet named exactly `Achievements` (see step 2 above — a brand new sheet
already includes it). Nothing else needs to change; the app writes its
header row automatically the first time it runs, the same as your other
tabs. The `Members` tab also gained three optional trailing columns
(`noOverdueStreak`, `streakLastCheckedDate`, `tasksFinishedEarly`) — you
don't need to add these yourself, the app fills them in the next time it
writes to that tab.

### The celebration

The moment an engineer completes **every task currently assigned to them**,
with all of them finished on or before their end date and none overdue, they
get a one-time celebration: a brief confetti animation, a congratulations
card with a randomly-chosen message (`🎉 Outstanding Work!`, `🚀 You're on
Fire!`, `🏆 Mission Accomplished!`, and a few others), and a **Continue**
button. It fades in and out rather than popping.

This is entirely server-driven and durable, not a per-session thing like the
Undo button: the moment a task is marked Done, the server checks whether
that just cleared the person's whole queue on time, and if so, records the
achievement as "unseen." Their own client picks it up on its next state
refresh (login, or the regular ~8s poll) and shows the modal once; clicking
Continue marks it seen for good. Reloading the page, logging out and back
in, or another day going by never brings back a celebration that's already
been shown — and clearing the queue again later earns a fresh one, since
each occurrence is tracked separately by which task closed it out.

### Achievements (extensible by design)

Milestones are recorded in the new `Achievements` tab and shown quietly in
each person's own **My Stats** panel — never as an interrupting popup,
except for the clean-sweep celebration above. Implemented today:

- **On-Time Master** — the clean-sweep celebration itself, recorded as a
  lasting milestone alongside being shown as the popup.
- **Perfect Week** / **Consistency** — 7 or 30 consecutive days with no
  overdue tasks. Since there's no scheduled job in this app to check that at
  midnight every day, the streak is updated opportunistically — at most once
  per calendar day — whenever that person's own state is read (on login, on
  poll, or right after a task completes). That's an honest approximation
  rather than a continuous audit: it catches up the next time anyone looks,
  which in practice means "correct as of the last time you or they opened
  the app," not "guaranteed correct to the minute."
- **Speed Runner** (finishing a task before its end date, not just on time)
  is tracked as a running personal stat rather than a separate popup-style
  achievement, specifically to avoid turning this into a stream of badges —
  see the note in `lib/achievements.js`.

Adding a new achievement type is adding one entry to the `DEFINITIONS` array
in `lib/achievements.js` — nothing else needs to change unless it also
deserves the animated celebration treatment (`celebration: true`) or needs
new input data plumbed into its `check(ctx)` function.

### Personal stats & Click Score

Every engineer (and team leader, since they can self-assign) has a **My
Stats** button in the top bar showing:

- Tasks completed this month, on-time completion rate, current no-overdue
  streak, tasks currently overdue, average days per completed task, and
  Estimated-vs-Actual efficiency.
- A **Click Score** out of 100, a star rating, and a plain-language tier
  ("Excellent Performer," "Strong Performer," etc.), computed from: 40%
  on-time completion, 25% estimated-vs-actual time, 20% no overdue tasks,
  10% consistency (the streak above), and 5% "Future Quality Rating" — a
  placeholder for a peer/manager quality review that doesn't exist yet in
  this app. That last 5% defaults to full marks rather than silently
  docking everyone's score for a metric nothing collects yet; see
  `FUTURE_QUALITY_DEFAULT` in `lib/achievements.js` for where to wire in a
  real value later.

All of this updates automatically as tasks move through the board — there's
no separate "recalculate" step.

### A bug this surfaced (fixed)

Building the stats above exposed a pre-existing scheduler issue: inserting a
new task at the front of an engineer's queue shifted *every* dated task
forward, including ones already marked Done — silently rewriting when a
completed task actually happened, which also quietly skewed the existing
Estimated-vs-Actual dashboard. Completed tasks' dates are now treated as a
historical record and are no longer moved by later scheduling changes (see
`insertWithShift` / `removeAndCompact` / `restoreRemovedTask` in
`lib/scheduler.js`).

## Phase 7: Team leader scoping, Capacity tab fix, and approval notifications

### Team leaders now only see their own team

A team leader's board, sidebar, Gantt, Dashboard, and Capacity tab are now
all scoped to their own team — their own roster and only tasks assigned
within it (including their own self-assigned tasks). Previously, a team
leader's `tasks` list quietly included the *entire* board across every
team (a leftover from an earlier phase, noted at the time as "team leaders
can still browse the whole board") while their Dashboard/Capacity views
were already correctly scoped — an inconsistency that amounted to a
cross-team visibility leak. All four (`teams`, `members`, `tasks`,
`dashboardTasks`) are now scoped the same way in `GET /api/state`. Nothing
about what a team leader is *allowed to do* changes — they could already
only act on their own reports — this is purely about what they can see.

### Capacity tab flicker fixed

The Capacity tab fetches its data separately from the rest of the board
(`GET /api/capacity`), and the client was wiping the whole panel back to a
bare "Loading…" and rebuilding it from scratch every time — including on
the routine ~8-second background poll while you just had that tab open, not
only the first time you opened it. That produced a visible flash/reset
every few seconds. It now only shows the loading state the first time;
after that, refreshes update the list quietly in place.

### New notifications for submit / approve / send-back

Three transitions that previously happened silently now notify the person
waiting on them:

- A team member moving a task **In Progress → Submitted** notifies their
  team leader that something needs review.
- A leader moving a task **Submitted → In Progress** (sending it back)
  notifies the assignee.
- A leader moving a task **Submitted → Done** (approving it) notifies the
  assignee.

These reuse the existing in-app notification system (the bell icon) — no
new UI, just new triggers alongside the existing "assigned"/"reassigned"
notifications.

## Phase 8: Structured task categorization (Zone / Project / Building / Task title)

The "Task title" free-text field in the assignment window is now a
structured set of fields instead, so the team leader picks from a
consistent taxonomy rather than typing a title from scratch:

- **Zone** — a fixed dropdown: October, New Cairo, North Coast.
- **Project** — cascades from Zone (e.g. October offers Club District,
  Lagoon, Mountain Park, Commercial Building, COP; New Cairo and North
  Coast have their own lists). Disabled until a zone is picked.
- **Building** — free text (no fixed list was given for this one).
- **Task title** — the original free-text field, now a fixed dropdown:
  Coordination, RFI, RFP, SD, Study, QS, Clean Copy, As Built.

All four are required except Building, which is optional. The zone→project
list lives in one place — `ZONE_PROJECTS` and `TASK_TYPES` in `server.js`
— and is served to the client via `GET /api/state` (`taxonomy` field) so
there's a single source of truth; add or rename a zone/project/task type
there and the dropdowns follow automatically.

**Backward compatibility:** the board, Gantt view, dashboard, notifications,
achievements, and search all still work off a single `title` string, so
nothing else in the app needed to change. The server composes that string
from the four fields (e.g. `RFI · October · Club District · Building 3`)
and stores it alongside the four raw fields — the raw fields are what the
task modal reads back when editing, and what the board card now displays
as a structured location line above the task type. Tasks created before
this change simply don't have zone/project/building/taskType set; the
board falls back to showing their original title as before, and editing
one just means picking fresh categorization for it going forward.

## Phase 9: Transparent logo, and read-only viewer accounts

### Logo background removed, two text-color variants

`public/dmc-logo.png` had a plain white background baked into the actual
pixels (not just hidden by CSS) — it was RGBA in name but fully opaque
everywhere. It's been re-processed with proper alpha matting so the white is
genuinely transparent.

The logo shows up in two places with very different backgrounds — the dark
sidebar and the light login/setup card — so it now exists as two files:
`dmc-logo-white.png` (white "DMC CONTRACTING" text, used on the dark
sidebar) and `dmc-logo-dark.png` (the original near-black text, used on the
light login card). White text on the light cream card would have a contrast
ratio of about 1.1 — essentially invisible — so that variant only appears
where it actually reads clearly. Both keep the gold roofline unchanged;
only the letterforms differ between the two files.

### Read-only viewer accounts

A new account type — **Viewer** — for people who need visibility into the
whole board (e.g. stakeholders, upper management) but should never be able
to change anything.

- **Create one**: owner → **+ Member** → check **"Viewer account (read-only
  — sees everything, can't assign, edit, move, or approve anything)"**.
  Checking it hides the Team/Team-leader/Reports-to fields since none of
  those apply — a viewer isn't scoped to one team, they see all of them.
- **What they see**: the entire board across every team, Gantt, Dashboard,
  and Capacity — the same full visibility as the owner.
- **What they can't do**: create, edit, delete, move, approve, or duplicate
  a task, and can't add/edit members. This is enforced server-side (not
  just hidden in the UI) — every mutating endpoint rejects a viewer with a
  403, confirmed by direct API testing, not just by the buttons being
  hidden in the browser.
- They show up in their own **Viewers** section in the sidebar, separate
  from the team blocks, since they don't belong to one.
- No **My Stats** button and no Click Score/achievements — those measure
  task completion, and a viewer isn't assigned any tasks.

I've built and fully tested the capability but haven't created any specific
viewer accounts — that needs real names/usernames/passwords, which is
information only you have. Creating one takes about 30 seconds through
the **+ Member** flow above.

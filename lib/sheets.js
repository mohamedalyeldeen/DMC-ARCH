const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const HEADERS = {
  Config: ['key', 'value'],
  Teams: ['id', 'name', 'color'],
  Members: ['id', 'name', 'username', 'passwordHash', 'teamId', 'color', 'isTeamLead', 'reportsTo', 'email', 'noOverdueStreak', 'streakLastCheckedDate', 'tasksFinishedEarly', 'isViewer', 'isSenior', 'managedMemberIds'],
  // createdById is the member id (or 'owner') of whoever originally created
  // the task — set once at creation, never touched again, unlike assignedBy
  // which updates on every reassignment. Used to notify the actual creator
  // separately from whoever currently gets credit as "assigned by".
  Tasks: ['id', 'title', 'description', 'assignee', 'priority', 'due', 'status', 'completedAt', 'history', 'createdAt', 'startDate', 'endDate', 'sequence', 'zone', 'project', 'building', 'taskType', 'numDrawings', 'revisionNo', 'sheetFormat', 'checklist', 'taskItem', 'assignedBy', 'createdById'],
  Notifications: ['id', 'userId', 'taskId', 'type', 'message', 'actorName', 'read', 'createdAt'],
  // Recognition/achievement log — see lib/achievements.js. `meta` is a JSON
  // string reserved for any per-achievement extra data future definitions
  // might need (not used by any current achievement type).
  Achievements: ['id', 'memberId', 'type', 'triggerKey', 'icon', 'title', 'message', 'celebration', 'seen', 'earnedAt', 'meta'],
  // Owner-entered monthly attendance per engineer, used to compute a
  // drawings-per-day productivity rate in the Log tab. One row per
  // (memberId, month) pair — upserted, never duplicated.
  WorkDays: ['id', 'memberId', 'month', 'days'],
  // Owner-entered total drawing count expected for a project, used to show
  // a completion % in the Log tab's Project Progress section. One row per
  // (zone, project) pair — upserted, never duplicated.
  ProjectTargets: ['id', 'zone', 'project', 'targetDrawings', 'startingDrawings'],
  // Group chat: one channel per team (the existing 4 groups). Any member
  // of a team can post/read their team's channel; owner and viewers can
  // read/switch between all four for oversight (viewers read-only).
  // A message is either a team message (teamId set, dmId empty) or a direct
  // message (dmId set, teamId empty) — never both, kept as separate columns
  // rather than repurposing teamId so existing rows stay valid unchanged.
  // dmId is a deterministic 'dm:<idA>::<idB>' key (ids sorted) so both
  // participants resolve to the same thread regardless of who opens it
  // first. mentions is a JSON array of member ids @mentioned in this
  // message (see resolveChatChannel in server.js for who's mentionable).
  Messages: ['id', 'teamId', 'dmId', 'senderId', 'senderName', 'text', 'mentions', 'createdAt'],
  // One row per (userId, teamId-or-dmId) a person has ever opened —
  // app-written, never owner-entered. Exactly one of teamId/dmId is set,
  // mirroring Messages above. lastReadAt is compared against each message's
  // createdAt to compute the unread badge on the chat bubble; upserted only
  // when there's actually something newer to catch up on (see
  // GET /api/messages in server.js), not on every poll.
  ChatReads: ['id', 'userId', 'teamId', 'dmId', 'lastReadAt'],
  // Owner-managed source of truth for Task Item checklists. One row per
  // checklist line: (taskType, item) groups the rows into one checklist;
  // `order` controls the line's position within that group. The set of
  // "items" available for a given Task Title is derived entirely from
  // whatever distinct `item` values exist here — adding a brand new item
  // name (or a whole new taskType) just by adding rows makes it show up in
  // the app automatically, no code change needed. No `id` column — these
  // rows are only ever owner-entered directly in the sheet, never written
  // by the app itself, so there's nothing that needs a stable row id.
  ChecklistTemplates: ['taskType', 'item', 'order', 'text'],
  // Per-task discussion, separate from the team group chat — for
  // conversation tied to one specific piece of work.
  // Owner-managed public holidays — every date here is treated as a
  // non-working day everywhere the Friday/Saturday weekend already is
  // (auto-scheduling, overlap checks, capacity, manual date validation).
  Holidays: ['date', 'name'],
  // Owner/team-leader-registered leave. Only type 'sick' pushes the
  // engineer's whole open task queue forward (by shiftedDays, a working-day
  // count) — regular leave/absence ('other') is tracked for the record but
  // never touches any deadline.
  Leaves: ['id', 'memberId', 'type', 'startDate', 'endDate', 'shiftedDays', 'registeredBy', 'createdAt'],
  Comments: ['id', 'taskId', 'authorId', 'authorName', 'text', 'createdAt'],
  // Fully manual scope-of-work tracker, deliberately independent of the
  // Tasks board — for pre-existing projects whose work started long before
  // this app did, so linking it to real tasks would just show empty/wrong
  // towers. `building` here is free text for now; once this gets linked to
  // real tasks later, the distinct values already typed here become the
  // Building dropdown options everywhere else, unifying naming for free.
  ProjectScope: ['zone', 'project', 'building', 'item', 'order', 'status'],
  // Staging area for the per-engineer monthly tracking workbook — see
  // lib/dailyReport.js. One row per task per day per engineer; `date` is a
  // 'YYYY-MM-DD' string. VALUE / TOT NO OF DWGS / Day Fraction / Day /
  // Weekend are deliberately NOT stored — they're derived from these.
  DailyReports: ['id', 'memberId', 'date', 'status', 'project', 'area', 'package', 'item', 'type', 'subtype', 'revNo', 'numDwgs', 'description', 'notes', 'normalHours', 'dwgsStatus']
};

// Tabs the app may create itself the first time it writes to them, instead
// of failing until someone adds the tab by hand. Deliberately an allowlist
// rather than "any missing tab": for a tab that already exists under a
// slightly different name, silently creating an empty twin would make the
// data look like it vanished — a loud "tab not found" is better there.
const AUTO_CREATE_TABS = new Set(['ChatReads', 'DailyReports']);

// Most tabs stay well under this; DailyReports grows by hundreds of rows a
// month (every engineer, every task, every day) so it gets much more room.
const ROW_CAPS = { DailyReports: 40000 };
const DEFAULT_ROW_CAP = 5000;
function rowCap(tab) { return ROW_CAPS[tab] || DEFAULT_ROW_CAP; }
function dataRange(tab) { return `${tab}!A2:Z${rowCap(tab)}`; }

let sheetsClient = null;
async function getClient() {
  if (sheetsClient) return sheetsClient;
  const authClient = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await authClient.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

// Serializes read-modify-write operations per tab so concurrent requests
// from multiple users never clobber each other.
const locks = {};
function withLock(tab, fn) {
  const prev = locks[tab] || Promise.resolve();
  const run = prev.then(fn, fn);
  locks[tab] = run.catch(() => {});
  return run;
}

function rowsToObjects(tab, rows) {
  const headers = HEADERS[tab];
  return rows
    .filter(r => r.some(cell => cell !== '' && cell !== undefined))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ''; });
      if (tab === 'Members') {
        obj.isTeamLead = (obj.isTeamLead === 'TRUE' || obj.isTeamLead === true);
        obj.isSenior = (obj.isSenior === 'TRUE' || obj.isSenior === true);
        obj.isViewer = (obj.isViewer === 'TRUE' || obj.isViewer === true);
        obj.noOverdueStreak = obj.noOverdueStreak ? parseInt(obj.noOverdueStreak, 10) : 0;
        obj.tasksFinishedEarly = obj.tasksFinishedEarly ? parseInt(obj.tasksFinishedEarly, 10) : 0;
        try { obj.managedMemberIds = obj.managedMemberIds ? JSON.parse(obj.managedMemberIds) : []; } catch (e) { obj.managedMemberIds = []; }
      }
      if (tab === 'Notifications') obj.read = (obj.read === 'TRUE' || obj.read === true);
      if (tab === 'Tasks') {
        try { obj.history = obj.history ? JSON.parse(obj.history) : []; } catch (e) { obj.history = []; }
        obj.sequence = obj.sequence ? parseInt(obj.sequence, 10) : 0;
        obj.numDrawings = obj.numDrawings ? parseInt(obj.numDrawings, 10) : 0;
        try { obj.checklist = obj.checklist ? JSON.parse(obj.checklist) : []; } catch (e) { obj.checklist = []; }
      }
      if (tab === 'WorkDays') obj.days = obj.days ? parseInt(obj.days, 10) : 0;
      if (tab === 'ProjectTargets') {
        obj.targetDrawings = obj.targetDrawings ? parseInt(obj.targetDrawings, 10) : 0;
        obj.startingDrawings = obj.startingDrawings ? parseInt(obj.startingDrawings, 10) : 0;
      }
      if (tab === 'Messages') {
        try { obj.mentions = obj.mentions ? JSON.parse(obj.mentions) : []; } catch (e) { obj.mentions = []; }
      }
      if (tab === 'DailyReports') {
        // Blank stays blank (not 0) — an empty NO OF DWGS / Normal Hours
        // means "not filled in", which the export must keep distinct from 0.
        obj.numDwgs = obj.numDwgs === '' ? '' : Number(obj.numDwgs);
        obj.normalHours = obj.normalHours === '' ? '' : Number(obj.normalHours);
      }
      if (tab === 'ChecklistTemplates') obj.order = obj.order ? parseInt(obj.order, 10) : 0;
      if (tab === 'Leaves') obj.shiftedDays = obj.shiftedDays ? parseInt(obj.shiftedDays, 10) : 0;
      if (tab === 'ProjectScope') obj.order = obj.order ? parseInt(obj.order, 10) : 0;
      if (tab === 'Achievements') {
        obj.celebration = (obj.celebration === 'TRUE' || obj.celebration === true);
        obj.seen = (obj.seen === 'TRUE' || obj.seen === true);
        try { obj.meta = obj.meta ? JSON.parse(obj.meta) : {}; } catch (e) { obj.meta = {}; }
      }
      return obj;
    });
}

function objectsToRows(tab, objs) {
  const headers = HEADERS[tab];
  return objs.map(o => headers.map(h => {
    if (tab === 'Members' && h === 'isTeamLead') return o.isTeamLead ? 'TRUE' : 'FALSE';
    if (tab === 'Members' && h === 'isSenior') return o.isSenior ? 'TRUE' : 'FALSE';
    if (tab === 'Members' && h === 'isViewer') return o.isViewer ? 'TRUE' : 'FALSE';
    if (tab === 'Members' && h === 'managedMemberIds') return JSON.stringify(o.managedMemberIds || []);
    if (tab === 'Notifications' && h === 'read') return o.read ? 'TRUE' : 'FALSE';
    if (tab === 'Tasks' && h === 'history') return JSON.stringify(o.history || []);
    if (tab === 'Tasks' && h === 'checklist') return JSON.stringify(o.checklist || []);
    if (tab === 'Messages' && h === 'mentions') return JSON.stringify(o.mentions || []);
    if (tab === 'Achievements' && h === 'celebration') return o.celebration ? 'TRUE' : 'FALSE';
    if (tab === 'Achievements' && h === 'seen') return o.seen ? 'TRUE' : 'FALSE';
    if (tab === 'Achievements' && h === 'meta') return JSON.stringify(o.meta || {});
    return (o[h] === undefined || o[h] === null) ? '' : String(o[h]);
  }));
}

async function readTab(tab) {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: dataRange(tab) });
  return rowsToObjects(tab, res.data.values || []);
}

function isMissingTabError(e) {
  return /Unable to parse range|Requested entity was not found|Invalid range/i.test((e && e.message) || '');
}

// Row counts we've already confirmed per tab, so growing a big tab costs one
// metadata call per server instance, not one per save.
const gridRows = {};

async function createTab(tab) {
  const sheets = await getClient();
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { rowCount: 2000, columnCount: 26 } } } }] }
    });
  } catch (e) {
    // Another instance created it a moment ago — that's the outcome we wanted.
    if (!/already exists/i.test(e.message || '')) throw e;
  }
  gridRows[tab] = 2000;
}

// A new tab starts at Google's default grid (1000 rows) and values.update
// refuses to write past the grid's last row, so a tab that grows by hundreds
// of rows a month (DailyReports) has to be extended before it fills up.
async function ensureGridRows(tab, needed) {
  if (gridRows[tab] && gridRows[tab] >= needed) return;
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))'
  });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === tab);
  if (!sheet) return; // missing tab — let the write itself surface the real error
  const have = sheet.properties.gridProperties.rowCount;
  if (have >= needed) { gridRows[tab] = have; return; }
  const add = Math.max(needed - have, 2000);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', length: add } }] }
  });
  gridRows[tab] = have + add;
}

// Reads several tabs in ONE Sheets API call instead of one call per tab —
// batchGet still counts as a single request against the "read requests per
// minute" quota no matter how many ranges it carries, so this is the lever
// for cutting quota usage on hot polling endpoints (see /api/state).
// Note: unlike readTab, a range naming a sheet that doesn't exist yet fails
// the WHOLE batch, not just that range — callers with an optional tab
// should catch and fall back to individual readTab calls.
async function readTabsBatch(tabs) {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: tabs.map(tab => dataRange(tab))
  });
  const result = {};
  (res.data.valueRanges || []).forEach((vr, i) => {
    result[tabs[i]] = rowsToObjects(tabs[i], vr.values || []);
  });
  return result;
}

async function writeRawRows(tab, objs) {
  const sheets = await getClient();
  const headers = HEADERS[tab];
  const rows = objectsToRows(tab, objs);

  // Only tabs that have grown near Google's default 1000-row grid pay for
  // the extra metadata call — everything else skips straight past this.
  if (rows.length + 1 > 900) await ensureGridRows(tab, rows.length + 1 + 1000);

  // Header first — cheap and low-risk either way.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });

  // Write the NEW data before touching anything old. If this call fails
  // for any reason (a quota/rate-limit error on the write itself, a
  // network blip, a timeout), the sheet's previous data is still sitting
  // there untouched — nothing gets wiped. The old clear-then-write order
  // had a window where a failure between the two steps left the tab
  // permanently empty with no way back short of Version History.
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }

  // Only once the new data is safely written do we clean up whatever's
  // left over below it (e.g. old rows from before a delete shrank the
  // dataset). If the write above threw, this line never runs, so nothing
  // is cleared.
  const clearFromRow = 2 + rows.length;
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${clearFromRow}:Z${rowCap(tab)}`
  });
}

// Reads a tab, lets updateFn mutate the array (return the new array),
// then writes it back — all under a lock so it's safe with multiple users.
async function updateTab(tab, updateFn) {
  return withLock(tab, async () => {
    let current;
    try {
      current = await readTab(tab);
    } catch (e) {
      if (!AUTO_CREATE_TABS.has(tab) || !isMissingTabError(e)) throw e;
      await createTab(tab);
      current = [];
    }
    const updated = await updateFn(current);
    await writeRawRows(tab, updated);
    return updated;
  });
}

async function getConfig(key) {
  const rows = await readTab('Config');
  const row = rows.find(r => r.key === key);
  return row ? row.value : null;
}

async function setConfig(key, value) {
  await updateTab('Config', rows => {
    const idx = rows.findIndex(r => r.key === key);
    if (idx >= 0) rows[idx].value = value; else rows.push({ key, value });
    return rows;
  });
}

module.exports = { readTab, readTabsBatch, updateTab, getConfig, setConfig, HEADERS };

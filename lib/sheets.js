const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const HEADERS = {
  Config: ['key', 'value'],
  Teams: ['id', 'name', 'color'],
  Members: ['id', 'name', 'username', 'passwordHash', 'teamId', 'color', 'isTeamLead', 'reportsTo', 'email', 'noOverdueStreak', 'streakLastCheckedDate', 'tasksFinishedEarly', 'isViewer'],
  Tasks: ['id', 'title', 'description', 'assignee', 'priority', 'due', 'status', 'completedAt', 'history', 'createdAt', 'startDate', 'endDate', 'sequence', 'zone', 'project', 'building', 'taskType', 'numDrawings', 'revisionNo', 'sheetFormat'],
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
  ProjectTargets: ['id', 'zone', 'project', 'targetDrawings']
};

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
        obj.isViewer = (obj.isViewer === 'TRUE' || obj.isViewer === true);
        obj.noOverdueStreak = obj.noOverdueStreak ? parseInt(obj.noOverdueStreak, 10) : 0;
        obj.tasksFinishedEarly = obj.tasksFinishedEarly ? parseInt(obj.tasksFinishedEarly, 10) : 0;
      }
      if (tab === 'Notifications') obj.read = (obj.read === 'TRUE' || obj.read === true);
      if (tab === 'Tasks') {
        try { obj.history = obj.history ? JSON.parse(obj.history) : []; } catch (e) { obj.history = []; }
        obj.sequence = obj.sequence ? parseInt(obj.sequence, 10) : 0;
        obj.numDrawings = obj.numDrawings ? parseInt(obj.numDrawings, 10) : 0;
      }
      if (tab === 'WorkDays') obj.days = obj.days ? parseInt(obj.days, 10) : 0;
      if (tab === 'ProjectTargets') obj.targetDrawings = obj.targetDrawings ? parseInt(obj.targetDrawings, 10) : 0;
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
    if (tab === 'Members' && h === 'isViewer') return o.isViewer ? 'TRUE' : 'FALSE';
    if (tab === 'Notifications' && h === 'read') return o.read ? 'TRUE' : 'FALSE';
    if (tab === 'Tasks' && h === 'history') return JSON.stringify(o.history || []);
    if (tab === 'Achievements' && h === 'celebration') return o.celebration ? 'TRUE' : 'FALSE';
    if (tab === 'Achievements' && h === 'seen') return o.seen ? 'TRUE' : 'FALSE';
    if (tab === 'Achievements' && h === 'meta') return JSON.stringify(o.meta || {});
    return (o[h] === undefined || o[h] === null) ? '' : String(o[h]);
  }));
}

async function readTab(tab) {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:Z5000` });
  return rowsToObjects(tab, res.data.values || []);
}

async function writeRawRows(tab, objs) {
  const sheets = await getClient();
  const headers = HEADERS[tab];
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A2:Z5000` });
  const rows = objectsToRows(tab, objs);
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });
}

// Reads a tab, lets updateFn mutate the array (return the new array),
// then writes it back — all under a lock so it's safe with multiple users.
async function updateTab(tab, updateFn) {
  return withLock(tab, async () => {
    const current = await readTab(tab);
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

module.exports = { readTab, updateTab, getConfig, setConfig, HEADERS };

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const HEADERS = {
  Config: ['key', 'value'],
  Teams: ['id', 'name', 'color'],
  Members: ['id', 'name', 'username', 'passwordHash', 'teamId', 'color', 'isTeamLead', 'reportsTo', 'email'],
  Tasks: ['id', 'title', 'description', 'assignee', 'priority', 'due', 'status', 'completedAt', 'history', 'createdAt', 'startDate', 'endDate', 'sequence']
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
      if (tab === 'Members') obj.isTeamLead = (obj.isTeamLead === 'TRUE' || obj.isTeamLead === true);
      if (tab === 'Tasks') {
        try { obj.history = obj.history ? JSON.parse(obj.history) : []; } catch (e) { obj.history = []; }
        obj.sequence = obj.sequence ? parseInt(obj.sequence, 10) : 0;
      }
      return obj;
    });
}

function objectsToRows(tab, objs) {
  const headers = HEADERS[tab];
  return objs.map(o => headers.map(h => {
    if (tab === 'Members' && h === 'isTeamLead') return o.isTeamLead ? 'TRUE' : 'FALSE';
    if (tab === 'Tasks' && h === 'history') return JSON.stringify(o.history || []);
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

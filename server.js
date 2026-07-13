require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readTab, updateTab, getConfig, setConfig } = require('./lib/sheets');
const { sign, requireAuth, requireLeader, requireOwner, isLeader } = require('./lib/auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#E2892B', '#3E7C74', '#7C6AA6', '#C4574B', '#4C7EA8', '#8A9A3B'];
const COLUMN_ORDER = ['todo', 'inprogress', 'submitted', 'done'];

function genId(prefix) { return prefix + crypto.randomBytes(4).toString('hex'); }
function today() { return new Date().toISOString().slice(0, 10); }

function sendErr(res, e) {
  const map = { NOT_FOUND: 404, FORBIDDEN: 403, USERNAME_TAKEN: 409, BAD_REQUEST: 400 };
  const status = map[e.message] || 500;
  const messages = {
    NOT_FOUND: 'That record no longer exists.',
    FORBIDDEN: "You don't have permission to do that.",
    USERNAME_TAKEN: 'That username is already taken.',
    BAD_REQUEST: 'Missing or invalid data.'
  };
  console.error(e);
  res.status(status).json({ error: messages[e.message] || 'Something went wrong.' });
}

// ---------- AUTH ----------
app.get('/api/auth/status', async (req, res) => {
  try {
    const hash = await getConfig('ownerPasswordHash');
    res.json({ setupNeeded: !hash });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    const hash = await getConfig('ownerPasswordHash');
    if (hash) return res.status(400).json({ error: 'Setup was already completed.' });
    const { password } = req.body;
    if (!password || password.length < 3) return res.status(400).json({ error: 'Choose a password with at least 3 characters.' });
    const h = await bcrypt.hash(password, 10);
    await setConfig('ownerPasswordHash', h);
    const token = sign({ role: 'owner' });
    res.json({ token, role: 'owner', name: 'You (Owner)' });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/auth/login-owner', async (req, res) => {
  try {
    const hash = await getConfig('ownerPasswordHash');
    if (!hash) return res.status(400).json({ error: 'Board has not been set up yet.' });
    const ok = await bcrypt.compare(req.body.password || '', hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect owner password.' });
    const token = sign({ role: 'owner' });
    res.json({ token, role: 'owner', name: 'You (Owner)' });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/auth/login-member', async (req, res) => {
  try {
    const { username, password } = req.body;
    const members = await readTab('Members');
    const m = members.find(x => (x.username || '').toLowerCase() === (username || '').trim().toLowerCase());
    if (!m) return res.status(401).json({ error: 'Incorrect username or password.' });
    const ok = await bcrypt.compare(password || '', m.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });
    const token = sign({ role: 'member', id: m.id, teamId: m.teamId, isTeamLead: m.isTeamLead, name: m.name });
    res.json({ token, role: m.isTeamLead ? 'teamlead' : 'member', name: m.name, teamId: m.teamId, isTeamLead: m.isTeamLead, id: m.id });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Choose a password with at least 3 characters.' });
    const hash = await bcrypt.hash(newPassword, 10);
    if (req.user.role === 'owner') {
      await setConfig('ownerPasswordHash', hash);
    } else {
      await updateTab('Members', rows => {
        const m = rows.find(r => r.id === req.user.id);
        if (!m) throw Object.assign(new Error('NOT_FOUND'), {});
        m.passwordHash = hash;
        return rows;
      });
    }
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// ---------- STATE ----------
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const [teams, membersRaw, tasksAll] = await Promise.all([readTab('Teams'), readTab('Members'), readTab('Tasks')]);
    const members = membersRaw.map(({ passwordHash, ...rest }) => rest);
    const leader = isLeader(req.user);
    const tasks = leader ? tasksAll : tasksAll.filter(t => t.assignee === req.user.id);
    const dashboardTasks = leader ? tasksAll : tasksAll.filter(t => t.assignee === req.user.id);
    res.json({ teams, members, tasks, dashboardTasks, you: req.user });
  } catch (e) { sendErr(res, e); }
});

// ---------- TEAMS ----------
app.put('/api/teams/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    let updated;
    await updateTab('Teams', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      if (req.body.name) t.name = req.body.name.trim().slice(0, 30);
      updated = t;
      return rows;
    });
    res.json(updated);
  } catch (e) { sendErr(res, e); }
});

// ---------- MEMBERS ----------
app.post('/api/members', requireAuth, requireOwner, async (req, res) => {
  try {
    const { name, username, password, teamId, isTeamLead } = req.body;
    if (!name || !username || !password || !teamId) throw new Error('BAD_REQUEST');
    const hash = await bcrypt.hash(password, 10);
    let newMember;
    await updateTab('Members', rows => {
      if (rows.find(r => r.username.toLowerCase() === username.trim().toLowerCase())) throw new Error('USERNAME_TAKEN');
      newMember = {
        id: genId('m'), name, username: username.trim(), passwordHash: hash,
        teamId, color: COLORS[rows.length % COLORS.length], isTeamLead: !!isTeamLead
      };
      rows.push(newMember);
      return rows;
    });
    const { passwordHash, ...safe } = newMember;
    res.json(safe);
  } catch (e) { sendErr(res, e); }
});

app.put('/api/members/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const { name, username, password, teamId, isTeamLead } = req.body;
    let updated;
    await updateTab('Members', async rows => {
      const m = rows.find(r => r.id === req.params.id);
      if (!m) throw new Error('NOT_FOUND');
      if (username && rows.find(r => r.username.toLowerCase() === username.trim().toLowerCase() && r.id !== m.id)) throw new Error('USERNAME_TAKEN');
      if (name) m.name = name;
      if (username) m.username = username.trim();
      if (password) m.passwordHash = await bcrypt.hash(password, 10);
      if (teamId) m.teamId = teamId;
      m.isTeamLead = !!isTeamLead;
      updated = m;
      return rows;
    });
    const { passwordHash, ...safe } = updated;
    res.json(safe);
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/members/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    await updateTab('Members', rows => rows.filter(r => r.id !== req.params.id));
    await updateTab('Tasks', rows => { rows.forEach(t => { if (t.assignee === req.params.id) t.assignee = ''; }); return rows; });
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// ---------- TASKS ----------
app.post('/api/tasks', requireAuth, requireLeader, async (req, res) => {
  try {
    const { title, description, assignee, priority, due } = req.body;
    if (!title) throw new Error('BAD_REQUEST');
    const newTask = {
      id: genId('t'), title, description: description || '', assignee: assignee || '',
      priority: priority || 'M', due: due || '', status: 'todo', completedAt: '',
      history: [{ status: 'todo', at: today() }], createdAt: today()
    };
    await updateTab('Tasks', rows => { rows.push(newTask); return rows; });
    res.json(newTask);
  } catch (e) { sendErr(res, e); }
});

app.put('/api/tasks/:id', requireAuth, requireLeader, async (req, res) => {
  try {
    const { title, description, assignee, priority, due } = req.body;
    let updated;
    await updateTab('Tasks', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      if (title) t.title = title;
      t.description = description || '';
      t.assignee = assignee || '';
      if (priority) t.priority = priority;
      t.due = due || '';
      updated = t;
      return rows;
    });
    res.json(updated);
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/tasks/:id', requireAuth, requireLeader, async (req, res) => {
  try {
    await updateTab('Tasks', rows => rows.filter(r => r.id !== req.params.id));
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/tasks/:id/move', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const toIdx = COLUMN_ORDER.indexOf(status);
    if (toIdx < 0) throw new Error('BAD_REQUEST');
    let result;
    await updateTab('Tasks', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      const fromIdx = COLUMN_ORDER.indexOf(t.status);
      const leader = isLeader(req.user);
      if (toIdx > fromIdx) {
        const canAdvance = leader || (req.user.id === t.assignee && fromIdx < 2);
        if (!canAdvance) throw new Error('FORBIDDEN');
      } else if (toIdx < fromIdx) {
        if (!leader) throw new Error('FORBIDDEN');
      } else {
        return rows;
      }
      t.status = status;
      t.completedAt = status === 'done' ? today() : (status === 'submitted' ? t.completedAt : '');
      t.history.push({ status, at: today() });
      result = t;
      return rows;
    });
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Nexus server running on port ${PORT}`));
}
module.exports = app;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readTab, updateTab, getConfig, setConfig } = require('./lib/sheets');
const { sign, requireAuth, requireLeader, requireOwner, isLeader } = require('./lib/auth');
const { sendMail, taskAssignedEmail } = require('./lib/mailer');
const scheduler = require('./lib/scheduler');
const achievements = require('./lib/achievements');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COLORS = ['#E2892B', '#3E7C74', '#7C6AA6', '#C4574B', '#4C7EA8', '#8A9A3B'];
const COLUMN_ORDER = ['todo', 'inprogress', 'submitted', 'done'];

// Task categorization taxonomy — replaces free-text task titles with a
// structured Zone → Project cascade, a free-text Building, and a fixed
// task-type dropdown. Validated server-side too (not just in the UI) so a
// bad request can't store an inconsistent zone/project pairing.
const ZONE_PROJECTS = {
  'October': ['Club District', 'Lagoon', 'Mountain Park', 'Commercial Building', 'COP'],
  'New Cairo': ['Old Lagoon', 'New Lagoon', 'Club District', 'Body', 'Heart Work', 'Aliva', 'MV1 Extension'],
  'North Coast': ['Evia', 'Skala', 'Crete', 'Rhodes', 'Levels']
};
const TASK_TYPES = ['Coordination', 'RFI', 'RFP', 'SD', 'Study', 'QS', 'Clean Copy', 'As Built'];

function validateTaskCategorization(zone, project, taskType) {
  if (!zone || !project || !taskType) throw new Error('BAD_REQUEST');
  if (!ZONE_PROJECTS[zone] || !ZONE_PROJECTS[zone].includes(project)) throw new Error('BAD_REQUEST');
  if (!TASK_TYPES.includes(taskType)) throw new Error('BAD_REQUEST');
}

// The display "title" everywhere else in the app (board cards, Gantt bars,
// notifications, achievements, dashboard, search) stays a single string —
// this composes it from the four structured fields so none of that other
// code needs to know about zone/project/building/taskType individually.
function composeTaskTitle({ zone, project, building, taskType }) {
  const parts = [taskType, zone, project];
  if (building) parts.push(building);
  return parts.filter(Boolean).join(' · ');
}

function genId(prefix) { return prefix + crypto.randomBytes(4).toString('hex'); }
function today() { return new Date().toISOString().slice(0, 10); }

// Owner can assign to anyone. A team lead can assign to their own reports,
// or to themselves (Phase 2: team leader self-assignment).
function canLeadAssignTo(user, assigneeId, membersCache) {
  if (user.role === 'owner') return true;
  if (assigneeId === user.id) return true;
  const target = membersCache.find(m => m.id === assigneeId);
  return !!(target && target.reportsTo === user.id);
}

function sendErr(res, e) {
  const map = { NOT_FOUND: 404, FORBIDDEN: 403, USERNAME_TAKEN: 409, BAD_REQUEST: 400, OVERLAP: 409, WEEKEND_DATE: 400 };
  const status = map[e.message] || 500;
  const messages = {
    NOT_FOUND: 'That record no longer exists.',
    FORBIDDEN: "You don't have permission to do that.",
    USERNAME_TAKEN: 'That username is already taken.',
    BAD_REQUEST: 'Missing or invalid data.',
    OVERLAP: 'This overlaps with another task already scheduled for this person. Check "Allow Task Overlap" to schedule it anyway.',
    WEEKEND_DATE: 'Friday and Saturday are non-working days — tasks can\'t start or end on one of those.'
  };
  console.error(e);
  res.status(status).json({ error: messages[e.message] || 'Something went wrong.' });
}

// Friday/Saturday are non-working days: nobody gets assigned a task that
// starts or ends on one of them. Only checked against manually-picked dates
// — auto-scheduled dates are computed by lib/scheduler.js and always land
// on a working day by construction.
function assertWorkingDates(...dates) {
  dates.filter(Boolean).forEach(d => {
    if (scheduler.isNonWorkingDay(d)) throw new Error('WEEKEND_DATE');
  });
}

async function notifyAssignment(task, actor) {
  try {
    const members = await readTab('Members');
    const member = members.find(m => m.id === task.assignee);
    if (!member || !member.email) return;
    const assignedBy = actorLabel(actor);
    const { subject, text, html } = taskAssignedEmail({
      memberName: member.name, taskTitle: task.title, description: task.description,
      priority: task.priority, due: task.due, assignedBy
    });
    await sendMail({ to: member.email, subject, text, html });
  } catch (e) {
    console.error('notifyAssignment failed:', e.message);
  }
}

// In-app notification (separate from, and in addition to, the optional email above).
async function addNotification(userId, taskId, type, message, actorName) {
  if (!userId) return;
  try {
    await updateTab('Notifications', rows => {
      rows.push({
        id: genId('n'), userId, taskId, type, message, actorName: actorName || '', read: false,
        createdAt: new Date().toISOString()
      });
      return rows;
    });
  } catch (e) {
    console.error('addNotification failed:', e.message);
  }
}

// Persists newly-earned achievements (from lib/achievements.evaluateAchievements)
// as rows in the Achievements tab. `celebration`-type ones start unseen so
// the owning member's client shows the modal once, then marks it seen.
async function persistAchievements(memberId, earned) {
  if (!earned.length) return [];
  const saved = [];
  await updateTab('Achievements', rows => {
    earned.forEach(a => {
      const row = {
        id: genId('ach'), memberId, type: a.type, triggerKey: a.triggerKey,
        icon: a.icon, title: a.title, message: a.message, celebration: a.celebration,
        seen: !a.celebration, // non-celebration milestones don't need a "seen" gate
        earnedAt: new Date().toISOString(), meta: {}
      };
      rows.push(row);
      saved.push(row);
    });
    return rows;
  });
  return saved;
}

// Re-evaluates achievements for one member after something about their
// tasks changed (a task completed) or just on a normal state read (for the
// once-a-day streak touch). Skips the Members-tab write entirely once
// today's streak check has already run for this member, so polling /api/state
// every few seconds doesn't turn into a sheet write every few seconds.
// Returns { newAchievements, member } — `member` is always the freshest
// row available (only re-read from the sheet if it was actually touched).
async function evaluateMemberAchievements(memberId, allTasks, justCompletedTask, membersCache) {
  const memberTasks = allTasks.filter(t => t.assignee === memberId);
  const todayStr = today();
  let member = (membersCache || []).find(m => m.id === memberId);
  const alreadyToday = member && member.streakLastCheckedDate === todayStr;

  // Only a completion event needs to run even when the streak was already
  // touched today (a task can complete more than once a day).
  if (alreadyToday && !justCompletedTask) {
    return { newAchievements: [], member };
  }

  await updateTab('Members', rows => {
    const m = rows.find(r => r.id === memberId);
    if (!m) return rows;
    const streak = achievements.touchOverdueStreak(m, memberTasks, todayStr);
    m.noOverdueStreak = streak.noOverdueStreak;
    m.streakLastCheckedDate = streak.streakLastCheckedDate;
    if (justCompletedTask && achievements.isFinishedEarly(justCompletedTask)) {
      m.tasksFinishedEarly = (m.tasksFinishedEarly || 0) + 1;
    }
    member = m;
    return rows;
  });
  if (!member) return { newAchievements: [], member: null };

  const existing = await readTab('Achievements');
  const existingKeys = new Set(existing.filter(a => a.memberId === memberId).map(a => `${a.type}:${a.triggerKey}`));
  const ctx = { memberTasks, justCompletedTask, streak: { noOverdueStreak: member.noOverdueStreak }, todayStr };
  const earned = achievements.evaluateAchievements(ctx, existingKeys);
  const newAchievements = earned.length ? await persistAchievements(memberId, earned) : [];
  return { newAchievements, member };
}

app.post('/api/auth/set-owner-name', requireAuth, requireOwner, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    await setConfig('ownerName', name);
    const token = sign({ role: 'owner', name });
    res.json({ token, role: 'owner', name });
  } catch (e) { sendErr(res, e); }
});

function actorLabel(actor) {
  return actor.name || (actor.role === 'owner' ? 'The board owner' : 'A team leader');
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
    const { password, ownerName } = req.body;
    if (!password || password.length < 3) return res.status(400).json({ error: 'Choose a password with at least 3 characters.' });
    const h = await bcrypt.hash(password, 10);
    await setConfig('ownerPasswordHash', h);
    await setConfig('ownerName', (ownerName || 'Board Owner').trim());
    const existingTeams = await readTab('Teams');
    if (existingTeams.length === 0) {
      await updateTab('Teams', () => ([
        { id: 'team1', name: 'Team Alpha', color: '#E2892B' },
        { id: 'team2', name: 'Team Beta', color: '#3E7C74' },
        { id: 'team3', name: 'Team Gamma', color: '#7C6AA6' },
        { id: 'team4', name: 'Team Delta', color: '#4C7EA8' }
      ]));
    }
    const finalName = (ownerName || 'Board Owner').trim();
    const token = sign({ role: 'owner', name: finalName });
    res.json({ token, role: 'owner', name: finalName });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/auth/login-owner', async (req, res) => {
  try {
    const hash = await getConfig('ownerPasswordHash');
    if (!hash) return res.status(400).json({ error: 'Board has not been set up yet.' });
    const ok = await bcrypt.compare(req.body.password || '', hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect owner password.' });
    const ownerName = (await getConfig('ownerName')) || 'Board Owner';
    const token = sign({ role: 'owner', name: ownerName });
    res.json({ token, role: 'owner', name: ownerName });
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
// Capacity is a planning view for whoever assigns work — owner + team leads.
app.get('/api/capacity', requireAuth, requireLeader, async (req, res) => {
  try {
    const [membersRaw, tasksAll] = await Promise.all([readTab('Members'), readTab('Tasks')]);
    let visibleMembers = membersRaw;
    if (req.user.role !== 'owner') {
      visibleMembers = membersRaw.filter(m => m.reportsTo === req.user.id || m.id === req.user.id);
    }
    const capacity = visibleMembers.map(m => {
      const c = scheduler.engineerCapacity(tasksAll, m.id);
      return { id: m.id, name: m.name, teamId: m.teamId, ...c };
    });
    res.json({ capacity });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const [teamsAll, membersRaw, tasksAll] = await Promise.all([readTab('Teams'), readTab('Members'), readTab('Tasks')]);
    let notificationsAll = [];
    try {
      notificationsAll = await readTab('Notifications');
    } catch (e) {
      console.error('Notifications tab unavailable (has it been created in the Sheet yet?):', e.message);
    }
    const leader = isLeader(req.user);
    let tasks, dashboardTasks, teams, visibleMembersRaw;
    if (req.user.role === 'owner') {
      tasks = tasksAll;
      dashboardTasks = tasksAll;
      teams = teamsAll;
      visibleMembersRaw = membersRaw;
    } else if (req.user.isTeamLead) {
      // A team leader only sees their own team: their team's roster, and
      // only tasks assigned within it (including their own self-assigned
      // tasks). This used to show the entire board — that was a visibility
      // leak across teams, not an intentional feature.
      const myTeamId = req.user.teamId;
      const myReportIds = new Set(membersRaw.filter(m => m.reportsTo === req.user.id).map(m => m.id));
      myReportIds.add(req.user.id); // Phase 2: team leaders can self-assign, include their own tasks too
      tasks = tasksAll.filter(t => myReportIds.has(t.assignee));
      dashboardTasks = tasks;
      teams = teamsAll.filter(t => t.id === myTeamId);
      visibleMembersRaw = membersRaw.filter(m => m.teamId === myTeamId || myReportIds.has(m.id));
    } else {
      tasks = tasksAll.filter(t => t.assignee === req.user.id);
      dashboardTasks = tasks;
      teams = teamsAll.filter(t => t.id === req.user.teamId);
      visibleMembersRaw = membersRaw.filter(m => m.teamId === req.user.teamId);
    }
    const members = visibleMembersRaw.map(({ passwordHash, ...rest }) => rest);
    const myUserId = req.user.role === 'owner' ? null : req.user.id;
    const notifications = myUserId
      ? notificationsAll.filter(n => n.userId === myUserId).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 50)
      : [];
    const unreadCount = notifications.filter(n => !n.read).length;

    // Personal recognition data — additive, and only for an actual engineer
    // account (owner isn't assigned tasks, so there's nothing to score).
    let me = null;
    if (req.user.role !== 'owner') {
      try {
        const { member } = await evaluateMemberAchievements(req.user.id, tasksAll, null, membersRaw);
        const memberForStats = member || membersRaw.find(m => m.id === req.user.id) || {};
        const stats = achievements.computeMemberStats(tasksAll.filter(t => t.assignee === req.user.id), memberForStats, today());
        const clickScore = achievements.computeClickScore(stats);
        const achievementsAll = await readTab('Achievements').catch(() => []);
        const mine = achievementsAll.filter(a => a.memberId === req.user.id).sort((a, b) => (b.earnedAt || '').localeCompare(a.earnedAt || ''));
        const pendingCelebration = mine.find(a => a.celebration && !a.seen) || null;
        me = { stats, clickScore, achievements: mine.slice(0, 20), pendingCelebration };
      } catch (e) {
        console.error('personal achievement data failed (has the Achievements tab been created in the Sheet yet?):', e.message);
      }
    }

    res.json({ teams, members, tasks, dashboardTasks, notifications, unreadCount, you: req.user, me, taxonomy: { zoneProjects: ZONE_PROJECTS, taskTypes: TASK_TYPES } });
  } catch (e) { sendErr(res, e); }
});

// Marks one of the current user's own achievements as seen — called right
// after the celebration modal is shown/dismissed so it never appears again.
app.post('/api/achievements/:id/seen', requireAuth, async (req, res) => {
  try {
    let result;
    await updateTab('Achievements', rows => {
      const a = rows.find(r => r.id === req.params.id && r.memberId === req.user.id);
      if (!a) throw new Error('NOT_FOUND');
      a.seen = true;
      result = a;
      return rows;
    });
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'owner') return res.json({ ok: true }); // owner has no notifications
    try {
      await updateTab('Notifications', rows => {
        const n = rows.find(r => r.id === req.params.id && r.userId === req.user.id);
        if (n) n.read = true;
        return rows;
      });
    } catch (e) {
      console.error('Notifications tab unavailable:', e.message);
    }
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'owner') return res.json({ ok: true });
    try {
      await updateTab('Notifications', rows => {
        rows.forEach(n => { if (n.userId === req.user.id) n.read = true; });
        return rows;
      });
    } catch (e) {
      console.error('Notifications tab unavailable:', e.message);
    }
    res.json({ ok: true });
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
    const { name, username, password, teamId, isTeamLead, reportsTo, email } = req.body;
    if (!name || !username || !password || !teamId) throw new Error('BAD_REQUEST');
    const hash = await bcrypt.hash(password, 10);
    let newMember;
    await updateTab('Members', rows => {
      if (rows.find(r => r.username.toLowerCase() === username.trim().toLowerCase())) throw new Error('USERNAME_TAKEN');
      newMember = {
        id: genId('m'), name, username: username.trim(), passwordHash: hash,
        teamId, color: COLORS[rows.length % COLORS.length], isTeamLead: !!isTeamLead,
        reportsTo: isTeamLead ? '' : (reportsTo || ''), email: (email || '').trim()
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
    const { name, username, password, teamId, isTeamLead, reportsTo, email } = req.body;
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
      m.reportsTo = m.isTeamLead ? '' : (reportsTo || '');
      if (email !== undefined) m.email = (email || '').trim();
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
    const { zone, project, building, taskType, description, assignee, priority, allowOverlap, mode, durationDays, insertAfterTaskId } = req.body;
    const bodyStart = req.body.startDate;
    const bodyEnd = req.body.endDate;
    validateTaskCategorization(zone, project, taskType);
    const title = composeTaskTitle({ zone, project, building, taskType });
    if (req.user.role !== 'owner') {
      if (!assignee) throw new Error('FORBIDDEN');
      const members = await readTab('Members');
      if (!canLeadAssignTo(req.user, assignee, members)) throw new Error('FORBIDDEN');
    }
    let newTask;
    await updateTab('Tasks', rows => {
      let startDate = '', endDate = '', sequence = 0;
      if (assignee) {
        if (mode === 'auto') {
          const dur = Math.max(1, parseInt(durationDays, 10) || 1);
          const computed = scheduler.insertWithShift(rows, assignee, { afterTaskId: insertAfterTaskId || null, durationDays: dur });
          startDate = computed.startDate;
          endDate = computed.endDate;
          sequence = computed.sequence;
        } else if (bodyStart) {
          startDate = bodyStart;
          endDate = bodyEnd || bodyStart;
          assertWorkingDates(startDate, endDate);
          if (!allowOverlap && scheduler.detectOverlap(rows, assignee, startDate, endDate)) {
            throw new Error('OVERLAP');
          }
          sequence = scheduler.nextSequence(rows, assignee);
        }
      }
      newTask = {
        id: genId('t'), title, description: description || '', assignee: assignee || '',
        priority: priority || 'M', due: endDate || '', status: 'todo', completedAt: '',
        startDate, endDate, sequence,
        zone, project, building: building || '', taskType,
        history: [{ status: 'todo', at: today() }], createdAt: today()
      };
      rows.push(newTask);
      return rows;
    });
    if (newTask.assignee) {
      await notifyAssignment(newTask, req.user);
      await addNotification(newTask.assignee, newTask.id, 'assigned', `New task assigned: "${newTask.title}"`, actorLabel(req.user));
    }
    res.json(newTask);
  } catch (e) { sendErr(res, e); }
});

app.put('/api/tasks/:id', requireAuth, requireLeader, async (req, res) => {
  try {
    const { zone, project, building, taskType, description, assignee, priority, allowOverlap } = req.body;
    const bodyStart = req.body.startDate;
    const bodyEnd = req.body.endDate;
    let membersCache = null;
    if (req.user.role !== 'owner') membersCache = await readTab('Members');
    let updated;
    let wasReassigned = false;
    let wasUpdated = false;
    await updateTab('Tasks', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      if (req.user.role !== 'owner') {
        if (!canLeadAssignTo(req.user, t.assignee, membersCache)) throw new Error('FORBIDDEN');
        if (assignee) {
          if (!canLeadAssignTo(req.user, assignee, membersCache)) throw new Error('FORBIDDEN');
        }
      }
      const prevAssignee = t.assignee;
      const prevSnapshot = { id: t.id, sequence: t.sequence, startDate: t.startDate, endDate: t.endDate };
      const before = { title: t.title, description: t.description, priority: t.priority, startDate: t.startDate, endDate: t.endDate };
      const newAssignee = assignee !== undefined ? (assignee || '') : t.assignee;
      let newStart = t.startDate;
      let newEnd = t.endDate;
      if (bodyStart !== undefined) {
        newStart = bodyStart;
        newEnd = bodyEnd || bodyStart;
      } else if (bodyEnd !== undefined) {
        newEnd = bodyEnd;
      }

      if (newAssignee && newStart) {
        assertWorkingDates(newStart, newEnd);
        if (!allowOverlap && scheduler.detectOverlap(rows, newAssignee, newStart, newEnd, t.id)) {
          throw new Error('OVERLAP');
        }
      }

      if (newAssignee !== prevAssignee) {
        if (prevAssignee) scheduler.removeAndCompact(rows, prevAssignee, prevSnapshot);
      }

      if (zone !== undefined || project !== undefined || building !== undefined || taskType !== undefined) {
        const nextZone = zone !== undefined ? zone : t.zone;
        const nextProject = project !== undefined ? project : t.project;
        const nextBuilding = building !== undefined ? building : t.building;
        const nextTaskType = taskType !== undefined ? taskType : t.taskType;
        validateTaskCategorization(nextZone, nextProject, nextTaskType);
        t.zone = nextZone; t.project = nextProject; t.building = nextBuilding || ''; t.taskType = nextTaskType;
        t.title = composeTaskTitle({ zone: nextZone, project: nextProject, building: nextBuilding, taskType: nextTaskType });
      }
      t.description = description || '';
      t.assignee = newAssignee;
      t.startDate = newStart || '';
      t.endDate = newEnd || '';
      if (newEnd) t.due = newEnd; // keep legacy due date untouched if this task still has no dates
      if (priority) t.priority = priority;

      if (newAssignee !== prevAssignee) {
        t.sequence = newAssignee ? scheduler.nextSequence(rows, newAssignee) : 0;
      }

      updated = t;
      wasReassigned = !!(newAssignee && newAssignee !== prevAssignee);
      wasUpdated = !wasReassigned && !!newAssignee && (
        before.title !== t.title || before.description !== t.description ||
        before.priority !== t.priority || before.startDate !== t.startDate || before.endDate !== t.endDate
      );
      return rows;
    });
    if (wasReassigned) {
      await notifyAssignment(updated, req.user);
      await addNotification(updated.assignee, updated.id, 'reassigned', `Task reassigned to you: "${updated.title}"`, actorLabel(req.user));
    } else if (wasUpdated) {
      await addNotification(updated.assignee, updated.id, 'updated', `Task updated: "${updated.title}"`, actorLabel(req.user));
    }
    res.json(updated);
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/tasks/:id', requireAuth, requireLeader, async (req, res) => {
  try {
    let membersCache = null;
    if (req.user.role !== 'owner') membersCache = await readTab('Members');
    await updateTab('Tasks', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      if (req.user.role !== 'owner') {
        if (!canLeadAssignTo(req.user, t.assignee, membersCache)) throw new Error('FORBIDDEN');
      }
      const remaining = rows.filter(r => r.id !== req.params.id);
      if (t.assignee) scheduler.removeAndCompact(remaining, t.assignee, t);
      return remaining;
    });
    res.json({ ok: true });
  } catch (e) { sendErr(res, e); }
});

// Used by the client-side Undo stack to reverse a delete: re-inserts the
// exact task snapshot the client had cached (same id, dates, sequence,
// status, history) and re-opens the gap in that engineer's queue the same
// way removeAndCompact closed it. This only lines up cleanly if nothing else
// touched that engineer's queue between the delete and the undo — see the
// Undo section in the README for that caveat.
app.post('/api/tasks/restore', requireAuth, requireLeader, async (req, res) => {
  try {
    const snapshot = req.body.snapshot;
    if (!snapshot || !snapshot.id || !snapshot.title) throw new Error('BAD_REQUEST');
    let membersCache = null;
    if (req.user.role !== 'owner') membersCache = await readTab('Members');
    let restored;
    await updateTab('Tasks', rows => {
      if (rows.find(r => r.id === snapshot.id)) throw new Error('BAD_REQUEST');
      if (req.user.role !== 'owner' && snapshot.assignee && !canLeadAssignTo(req.user, snapshot.assignee, membersCache)) {
        throw new Error('FORBIDDEN');
      }
      const restoredTask = {
        id: snapshot.id, title: snapshot.title, description: snapshot.description || '',
        assignee: snapshot.assignee || '', priority: snapshot.priority || 'M', due: snapshot.due || '',
        status: snapshot.status || 'todo', completedAt: snapshot.completedAt || '',
        startDate: snapshot.startDate || '', endDate: snapshot.endDate || '',
        sequence: snapshot.sequence || 0, history: snapshot.history || [], createdAt: snapshot.createdAt || today(),
        zone: snapshot.zone || '', project: snapshot.project || '', building: snapshot.building || '', taskType: snapshot.taskType || ''
      };
      if (restoredTask.assignee) {
        scheduler.restoreRemovedTask(rows, restoredTask.assignee, restoredTask);
      } else {
        rows.push(restoredTask);
      }
      restored = restoredTask;
      return rows;
    });
    res.json(restored);
  } catch (e) { sendErr(res, e); }
});

// Duplicates a task's title/description/priority to one assignee or several.
// Dates are intentionally left blank on duplicates (copying the original's
// dates would just trigger an overlap against the original itself) — the
// leader sets fresh dates on each copy afterward.
app.post('/api/tasks/:id/duplicate', requireAuth, requireLeader, async (req, res) => {
  try {
    const assignees = Array.isArray(req.body.assignees) ? req.body.assignees.filter(Boolean) : [];
    const allowOverlap = !!req.body.allowOverlap;
    let membersCache = null;
    if (req.user.role !== 'owner') membersCache = await readTab('Members');

    let created = [];
    await updateTab('Tasks', rows => {
      const original = rows.find(r => r.id === req.params.id);
      if (!original) throw new Error('NOT_FOUND');
      if (req.user.role !== 'owner' && !canLeadAssignTo(req.user, original.assignee, membersCache)) throw new Error('FORBIDDEN');

      const targets = assignees.length > 0 ? assignees : [original.assignee];
      targets.forEach(assigneeId => {
        if (assigneeId && req.user.role !== 'owner' && !canLeadAssignTo(req.user, assigneeId, membersCache)) {
          throw new Error('FORBIDDEN');
        }
        const startDate = original.startDate || '';
        const endDate = original.endDate || '';
        if (assigneeId && startDate && !allowOverlap && scheduler.detectOverlap(rows, assigneeId, startDate, endDate)) {
          throw new Error('OVERLAP');
        }
        const dup = {
          id: genId('t'), title: original.title, description: original.description,
          assignee: assigneeId || '', priority: original.priority, due: endDate,
          status: 'todo', completedAt: '', startDate, endDate,
          sequence: assigneeId ? scheduler.nextSequence(rows, assigneeId) : 0,
          history: [{ status: 'todo', at: today() }], createdAt: today(),
          zone: original.zone || '', project: original.project || '', building: original.building || '', taskType: original.taskType || ''
        };
        rows.push(dup);
        created.push(dup);
      });
      return rows;
    });

    for (const t of created) {
      if (t.assignee) {
        await notifyAssignment(t, req.user);
        await addNotification(t.assignee, t.id, 'assigned', `New task assigned: "${t.title}"`, actorLabel(req.user));
      }
    }
    res.json(created);
  } catch (e) { sendErr(res, e); }
});

// Notifies the relevant person for the transitions that matter most to
// someone waiting on a decision: a team member submitting work for review
// notifies their team leader (so it doesn't just sit there unnoticed), and
// a leader approving or sending work back notifies the assignee either way
// — right now they only find out by reloading the board.
async function notifyMoveTransition(fromStatus, toStatus, task, actor) {
  if (!task.assignee) return;
  try {
    const members = await readTab('Members');
    const assigneeMember = members.find(m => m.id === task.assignee);
    if (fromStatus === 'inprogress' && toStatus === 'submitted') {
      const leadId = assigneeMember && assigneeMember.reportsTo;
      if (leadId && leadId !== actor.id) {
        await addNotification(leadId, task.id, 'submitted', `${(assigneeMember && assigneeMember.name) || 'A team member'} submitted "${task.title}" for review`, actorLabel(actor));
      }
    } else if (fromStatus === 'submitted' && toStatus === 'inprogress') {
      if (task.assignee !== actor.id) {
        await addNotification(task.assignee, task.id, 'sent_back', `"${task.title}" was sent back to In Progress`, actorLabel(actor));
      }
    } else if (fromStatus === 'submitted' && toStatus === 'done') {
      if (task.assignee !== actor.id) {
        await addNotification(task.assignee, task.id, 'approved', `"${task.title}" was approved and marked Done`, actorLabel(actor));
      }
    }
  } catch (e) {
    console.error('notifyMoveTransition failed:', e.message);
  }
}

app.post('/api/tasks/:id/move', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const toIdx = COLUMN_ORDER.indexOf(status);
    if (toIdx < 0) throw new Error('BAD_REQUEST');
    let membersCache = null;
    if (req.user.role === 'member' && req.user.isTeamLead) membersCache = await readTab('Members');
    let result;
    let becameDone = false;
    let fromStatus = null;
    const updatedRows = await updateTab('Tasks', rows => {
      const t = rows.find(r => r.id === req.params.id);
      if (!t) throw new Error('NOT_FOUND');
      const fromIdx = COLUMN_ORDER.indexOf(t.status);
      fromStatus = t.status;
      let isLeaderForThis = req.user.role === 'owner';
      if (!isLeaderForThis && req.user.isTeamLead) {
        isLeaderForThis = canLeadAssignTo(req.user, t.assignee, membersCache);
      }
      if (toIdx > fromIdx) {
        const canAdvance = isLeaderForThis || (req.user.id === t.assignee && fromIdx < 2);
        if (!canAdvance) throw new Error('FORBIDDEN');
      } else if (toIdx < fromIdx) {
        if (!isLeaderForThis) throw new Error('FORBIDDEN');
      } else {
        return rows;
      }
      t.status = status;
      t.completedAt = status === 'done' ? today() : (status === 'submitted' ? t.completedAt : '');
      t.history.push({ status, at: today() });
      result = t;
      becameDone = status === 'done';
      return rows;
    });
    if (result && fromStatus !== status) {
      notifyMoveTransition(fromStatus, status, result, req.user).catch(e => console.error('move notification failed:', e.message));
    }
    // Recognition check: only worth doing the moment a task actually
    // becomes done, since that's the only transition that can newly
    // satisfy "every assigned task is complete."
    if (becameDone && result && result.assignee) {
      evaluateMemberAchievements(result.assignee, updatedRows, result, null).catch(e => console.error('achievement check failed:', e.message));
    }
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Click server running on port ${PORT}`));
}
module.exports = app;

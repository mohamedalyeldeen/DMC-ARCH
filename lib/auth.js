const jwt = require('jsonwebtoken');

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Your session expired, please log in again.' });
  }
}

function isLeader(user) {
  return user.role === 'owner' || !!user.isTeamLead;
}

function requireLeader(req, res, next) {
  if (isLeader(req.user)) return next();
  res.status(403).json({ error: 'Only the owner or a team leader can do that.' });
}

function requireOwner(req, res, next) {
  if (req.user.role === 'owner') return next();
  res.status(403).json({ error: 'Only the board owner can do that.' });
}

// A "senior" can create/edit task assignments (for themself or a plain team
// member) but can never delete anything — see canAssignTo() in server.js
// for the finer-grained per-assignee rule. isAssigner covers anyone allowed
// to create/edit an assignment at all: owner, team leader, or senior.
function isAssigner(user) {
  return user.role === 'owner' || !!user.isTeamLead || !!user.isSenior;
}

function requireAssigner(req, res, next) {
  if (isAssigner(req.user)) return next();
  res.status(403).json({ error: 'Only a team leader, senior, or the owner can do that.' });
}

// Read-visibility tier used for team-wide views (Capacity, Log/Productivity
// filters, the assignee picker): owner and viewers see everything, and team
// leaders/seniors see their own team so they have someone to assign to.
function isTeamWide(user) {
  return user.role === 'owner' || !!user.isViewer || !!user.isTeamLead || !!user.isSenior;
}

module.exports = { sign, requireAuth, requireLeader, requireOwner, requireAssigner, isLeader, isAssigner, isTeamWide };

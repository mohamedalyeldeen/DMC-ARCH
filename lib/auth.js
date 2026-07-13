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

module.exports = { sign, requireAuth, requireLeader, requireOwner, isLeader };

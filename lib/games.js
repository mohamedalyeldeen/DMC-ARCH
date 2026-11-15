// The Technical Games — a quiz the owner runs for the department.
//
// The owner writes the questions (multiple choice, or a written "paragraph"
// answer) and sets the game's rules — number of questions and time per
// question — opens the game, and each engineer plays it once, any time
// while it's open, against the clock. Multiple choice is
// graded by the server; paragraph answers are graded by hand by the owner.
// Highest score wins, ties broken by total time.
//
// Timing is enforced WITHOUT writing to the Google Sheet on every answer
// (a write is 3 API calls and the quota is only 60/min): the server hands
// the player a signed "state" token carrying the question number, the time
// that question was issued, and the answers so far. The player sends it
// back with each answer; the server checks the elapsed time against the
// token's timestamp, appends the answer, and signs the next token. Only the
// start and the finish touch the sheet. The correct answers never leave the
// server until the game is closed.
const crypto = require('crypto');

// Each game carries its own settings (the owner edits them while it's a
// draft); these are the defaults, and the hard bounds the settings must
// stay within. ABS_MAX_QUESTIONS is also what keeps the questions JSON under
// the 50,000-character limit of a single Google Sheets cell.
const DEFAULT_SETTINGS = { seconds: 30, textSeconds: 30, minQuestions: 10, maxQuestions: 20 };
const ABS_MAX_QUESTIONS = 40;
const MIN_SECONDS = 5;
const MAX_SECONDS = 600;
const MAX_QUESTIONS_JSON = 45000;
const GRACE_MS = 3000; // network latency allowance on top of each question's time
const TYPES = ['mc', 'text'];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

function fail(msg) {
  const err = new Error('BAD_REQUEST');
  err.userMessage = msg;
  return err;
}

function str(v, max, label) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw fail(`${label} is too long (max ${max} characters).`);
  return s;
}

function intIn(v, lo, hi, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw fail(`${label} must be a whole number between ${lo} and ${hi}.`);
  return n;
}

// Validates the owner's settings; missing fields fall back to the defaults.
function normalizeSettings(raw) {
  raw = raw || {};
  const pick = k => (raw[k] === undefined || raw[k] === '' || raw[k] === null ? DEFAULT_SETTINGS[k] : raw[k]);
  const s = {
    seconds: intIn(pick('seconds'), MIN_SECONDS, MAX_SECONDS, 'Seconds per question'),
    textSeconds: intIn(pick('textSeconds'), MIN_SECONDS, MAX_SECONDS, 'Seconds per paragraph question'),
    minQuestions: intIn(pick('minQuestions'), 1, ABS_MAX_QUESTIONS, 'Minimum questions'),
    maxQuestions: intIn(pick('maxQuestions'), 1, ABS_MAX_QUESTIONS, 'Maximum questions')
  };
  if (s.minQuestions > s.maxQuestions) throw fail('The minimum number of questions can\'t be more than the maximum.');
  return s;
}
// Games saved before settings existed have none stored.
function settingsOf(game) {
  return Object.assign({}, DEFAULT_SETTINGS, (game && game.settings) || {});
}
function questionSeconds(q, settings) {
  return q.type === 'text' ? settings.textSeconds : settings.seconds;
}

// Validates the owner's question list. Whatever isn't a recognised field is
// dropped, so the stored JSON can't grow arbitrary data.
function normalizeQuestions(raw, genId, settings) {
  const maxQ = settings.maxQuestions;
  if (!Array.isArray(raw)) throw fail('Questions must be a list.');
  if (raw.length > maxQ) throw fail(`This game allows at most ${maxQ} questions (see its settings).`);
  const seen = new Set();
  const out = raw.map((q, i) => {
    const n = i + 1;
    q = q || {};
    const type = TYPES.includes(q.type) ? q.type : null;
    if (!type) throw fail(`Question ${n}: pick a type (multiple choice or paragraph).`);
    const text = str(q.text, 400, `Question ${n}`);
    if (!text) throw fail(`Question ${n}: the question text is empty.`);
    let id = /^q[a-z0-9]{3,12}$/.test(q.id || '') && !seen.has(q.id) ? q.id : genId('q');
    seen.add(id);
    if (type === 'text') {
      return { id, type, text, answer: str(q.answer, 300, `Question ${n} model answer`) };
    }
    const options = (Array.isArray(q.options) ? q.options : []).map(o => str(o, 150, `Question ${n} option`));
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) throw fail(`Question ${n}: needs ${MIN_OPTIONS}–${MAX_OPTIONS} options.`);
    if (options.some(o => !o)) throw fail(`Question ${n}: an option is empty.`);
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) throw fail(`Question ${n}: two options are the same.`);
    const correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw fail(`Question ${n}: mark the correct option.`);
    return { id, type, text, options, correct };
  });
  if (JSON.stringify(out).length > MAX_QUESTIONS_JSON) throw fail('The questions are too long in total — shorten some of them or remove a few.');
  return out;
}

function assertCanOpen(questions, settings) {
  const { minQuestions: lo, maxQuestions: hi } = settings;
  if (questions.length < lo || questions.length > hi) {
    throw fail(`A game needs ${lo}–${hi} questions before it can be opened (this one has ${questions.length}).`);
  }
}

// What a player is allowed to see of a question — never the answer.
function publicQuestion(q) {
  return q.type === 'mc' ? { id: q.id, type: q.type, text: q.text, options: q.options } : { id: q.id, type: q.type, text: q.text };
}

// ---- signed play state ----
function stateKey() {
  if (!process.env.JWT_SECRET) throw new Error('Server is missing JWT_SECRET.');
  return crypto.createHash('sha256').update('click-games|' + process.env.JWT_SECRET).digest();
}
function mac(body) { return crypto.createHmac('sha256', stateKey()).update(body).digest('base64url'); }
function signState(state) {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  return body + '.' + mac(body);
}
// Returns the state, or null if the token was altered / malformed.
function verifyState(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) { return null; }
}

// Records one answer against the clock. `elapsedMs` is how long ago the
// question was issued (by the server's clock). Past the limit (+grace) the
// answer is discarded and the question counts as missed.
function recordAnswer(q, elapsedMs, body, settings) {
  const limit = questionSeconds(q, settings) * 1000;
  const missed = elapsedMs > limit + GRACE_MS;
  const ms = Math.max(0, Math.min(Math.round(elapsedMs), limit));
  if (missed) return { q: q.id, c: null, t: '', ms: limit, missed: true };
  if (q.type === 'mc') {
    const c = Number(body && body.choice);
    return { q: q.id, c: Number.isInteger(c) && c >= 0 && c < q.options.length ? c : null, t: '', ms, missed: false };
  }
  return { q: q.id, c: null, t: String((body && body.text) || '').trim().slice(0, 600), ms, missed: false };
}

// Multiple-choice points are final immediately; paragraph points come from
// the owner's grades ({ [questionId]: 0 | 1 }) later.
function mcScore(questions, answers) {
  const byId = {};
  answers.forEach(a => { byId[a.q] = a; });
  return questions.reduce((s, q) => s + (q.type === 'mc' && byId[q.id] && byId[q.id].c === q.correct ? 1 : 0), 0);
}
function totalMs(answers) { return answers.reduce((s, a) => s + (a.ms || 0), 0); }

// Paragraph answers the owner still has to mark (an empty one is a zero).
function pendingCount(questions, play) {
  const grades = play.grades || {};
  const byId = {};
  (play.answers || []).forEach(a => { byId[a.q] = a; });
  return questions.filter(q => q.type === 'text' && byId[q.id] && byId[q.id].t && grades[q.id] === undefined).length;
}
function playScore(play) {
  const g = play.grades || {};
  return (play.mcScore || 0) + Object.keys(g).reduce((s, k) => s + (Number(g[k]) || 0), 0);
}

// Finished plays only, best first: score, then faster total time, then who
// finished first.
function leaderboard(questions, plays) {
  return plays
    .filter(p => p.finishedAt)
    .map(p => ({ playId: p.id, userId: p.userId, userName: p.userName, score: playScore(p), pending: pendingCount(questions, p), totalMs: p.totalMs || 0, finishedAt: p.finishedAt }))
    .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs || (a.finishedAt < b.finishedAt ? -1 : 1))
    .map((r, i) => Object.assign(r, { rank: i + 1 }));
}

module.exports = {
  DEFAULT_SETTINGS, ABS_MAX_QUESTIONS, MIN_SECONDS, MAX_SECONDS, GRACE_MS,
  normalizeSettings, settingsOf, questionSeconds, normalizeQuestions, assertCanOpen, publicQuestion, signState, verifyState, recordAnswer,
  mcScore, totalMs, pendingCount, playScore, leaderboard, fail
};

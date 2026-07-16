// Recognition & achievement engine — pure functions over task/member data.
// Nothing in here talks to Google Sheets or Express directly, so it's easy
// to unit-test and easy to extend: adding a new achievement is adding one
// entry to DEFINITIONS, not touching the server routes that call this file.
//
// Design choice: only ONE achievement type ("Clean Sweep" / On-Time Master)
// shows the animated celebration modal. The rest are recorded quietly and
// surfaced only in the person's own stats panel — the brief was explicit
// that this should motivate without turning into a distracting, gamified
// stream of popups.

// ---------- Celebration copy ----------
// Randomly chosen each time the celebration fires, so it doesn't feel like
// the same canned message every time. Keep this list professional; it's
// meant to read like genuine recognition, not a game achievement toast.
const CELEBRATION_VARIANTS = [
  { icon: '🎉', title: 'Outstanding Work!' },
  { icon: '🚀', title: "You're on Fire!" },
  { icon: '👏', title: 'Another Perfect Finish!' },
  { icon: '⭐', title: 'Excellent Performance!' },
  { icon: '🏆', title: 'Mission Accomplished!' },
  { icon: '💯', title: 'Perfect Execution!' }
];

function pickCelebrationVariant() {
  return CELEBRATION_VARIANTS[Math.floor(Math.random() * CELEBRATION_VARIANTS.length)];
}

// ---------- Shared task predicates ----------
// A task's `due` field always mirrors its End Date once one is set (see
// server.js) and is the only deadline field guaranteed to exist for every
// task, including ones created before Start/End dates existed — so it's the
// one canonical "deadline" used everywhere here, matching how the existing
// Dashboard already computes on-time rate.
function isOnTime(t) { return !t.due || (!!t.completedAt && t.completedAt <= t.due); }
function isFinishedEarly(t) { return !!(t.due && t.completedAt && t.completedAt < t.due); }
function isCurrentlyOverdue(t, todayStr) { return t.status !== 'done' && !!t.due && t.due < todayStr; }

// ---------- Streak bookkeeping ----------
// Perfect Week / Consistency need to know "how many consecutive days has
// this person had zero overdue tasks", but there's no scheduled job in this
// architecture to check that at midnight every day. Instead, this is
// updated opportunistically — at most once per calendar day — whenever the
// person's own state is evaluated (on login/poll, and after a task moves).
// That's an honest approximation: it catches up the next time anyone looks,
// rather than an exact continuous daily audit, but needs no new
// infrastructure and is accurate as long as the app is opened most days.
//
// Mutates and returns the {noOverdueStreak, streakLastCheckedDate} pair —
// caller is responsible for persisting it back onto the Member record.
function touchOverdueStreak(member, memberTasks, todayStr) {
  const last = member.streakLastCheckedDate || '';
  if (last === todayStr) {
    return { noOverdueStreak: member.noOverdueStreak || 0, streakLastCheckedDate: last, changed: false };
  }
  const hasOverdueNow = memberTasks.some(t => isCurrentlyOverdue(t, todayStr));
  const noOverdueStreak = hasOverdueNow ? 0 : (member.noOverdueStreak || 0) + 1;
  return { noOverdueStreak, streakLastCheckedDate: todayStr, changed: true };
}

// ---------- Personal performance statistics ----------
function computeMemberStats(memberTasks, member, todayStr) {
  const completed = memberTasks.filter(t => t.status === 'done' && t.completedAt);
  const monthPrefix = todayStr.slice(0, 7); // YYYY-MM
  const completedThisMonth = completed.filter(t => t.completedAt.slice(0, 7) === monthPrefix).length;
  const onTimeCount = completed.filter(isOnTime).length;
  const onTimeRate = completed.length > 0 ? Math.round((onTimeCount / completed.length) * 100) : 100;
  const overdueCount = memberTasks.filter(t => isCurrentlyOverdue(t, todayStr)).length;

  const withDuration = completed.filter(t => t.startDate && daysBetween(t.startDate, t.completedAt) >= 0);
  const avgCompletionDays = withDuration.length > 0
    ? Math.round((withDuration.reduce((sum, t) => sum + (daysBetween(t.startDate, t.completedAt) + 1), 0) / withDuration.length) * 10) / 10
    : null;

  const evaEligible = completed.filter(t => t.startDate && t.endDate && daysBetween(t.startDate, t.completedAt) >= 0);
  const estimatedDays = evaEligible.reduce((sum, t) => sum + (daysBetween(t.startDate, t.endDate) + 1), 0);
  const actualDays = evaEligible.reduce((sum, t) => sum + (daysBetween(t.startDate, t.completedAt) + 1), 0);
  const efficiencyPct = actualDays > 0 ? Math.round((estimatedDays / actualDays) * 100) : 100;

  return {
    completedThisMonth,
    onTimeRate,
    currentStreak: member.noOverdueStreak || 0,
    overdueCount,
    avgCompletionDays,
    tasksFinishedEarly: member.tasksFinishedEarly || 0,
    eva: { estimatedDays, actualDays, diff: actualDays - estimatedDays, efficiencyPct: Math.min(100, efficiencyPct) }
  };
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso + 'T00:00:00Z'), b = new Date(bIso + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// ---------- Click Score ----------
// Weighted composite, per the agreed weighting:
//   40% On-Time Completion · 25% Estimated vs Actual · 20% No Overdue Tasks
//   10% Consistency (streak) · 5% Future Quality Rating
//
// "Future Quality Rating" has no data source yet (no peer/manager quality
// review exists in this app) — it defaults to full marks rather than
// silently docking everyone 5% for a metric that doesn't exist yet. Once a
// real quality-rating input exists, swap FUTURE_QUALITY_DEFAULT for the
// actual value here; nothing else about the weighting needs to change.
const FUTURE_QUALITY_DEFAULT = 100;
const WEIGHTS = { onTime: 0.40, eva: 0.25, noOverdue: 0.20, consistency: 0.10, futureQuality: 0.05 };
const CONSISTENCY_TARGET_DAYS = 30; // streak length that maps to a full 100 on this component

const RATING_TIERS = [
  { min: 90, label: 'Excellent Performer' },
  { min: 75, label: 'Strong Performer' },
  { min: 60, label: 'Solid Performer' },
  { min: 40, label: 'Building Momentum' },
  { min: 0, label: 'Getting Started' }
];

function computeClickScore(stats) {
  const onTime = stats.onTimeRate;
  const eva = stats.eva.efficiencyPct;
  const noOverdue = Math.max(0, 100 - stats.overdueCount * 25);
  const consistency = Math.min(100, Math.round((stats.currentStreak / CONSISTENCY_TARGET_DAYS) * 100));
  const futureQuality = FUTURE_QUALITY_DEFAULT;

  const score = Math.round(
    onTime * WEIGHTS.onTime +
    eva * WEIGHTS.eva +
    noOverdue * WEIGHTS.noOverdue +
    consistency * WEIGHTS.consistency +
    futureQuality * WEIGHTS.futureQuality
  );
  const rating = RATING_TIERS.find(t => score >= t.min).label;
  const stars = Math.max(0, Math.min(5, Math.round(score / 20)));

  return { score, stars, rating, breakdown: { onTime, eva, noOverdue, consistency, futureQuality } };
}

// ---------- Achievement definitions (extensible) ----------
// Each definition is checked independently and gets its own dedupe rule via
// `triggerKey` — a string identifying *this specific occurrence*, so the
// same milestone can be earned again later (e.g. clearing the queue a
// second time) without re-firing for the same underlying event on every
// subsequent check. `check` returns a truthy value (or an object with
// extra `meta`) when earned, or a falsy value otherwise.
//
// To add a new achievement: add one entry here. No other file needs to
// change unless it also needs its own popup treatment (see `celebration`
// below) or its own input data (extend `ctx` in evaluateAchievements()).
const DEFINITIONS = [
  {
    key: 'clean_sweep',
    label: 'On-Time Master',
    icon: '🏆',
    description: 'Completed every currently assigned task, all on or before their end date.',
    celebration: true, // this is the one that gets the animated modal
    check(ctx) {
      const { memberTasks, justCompletedTask } = ctx;
      if (!justCompletedTask || memberTasks.length === 0) return false;
      if (!memberTasks.every(t => t.status === 'done' && isOnTime(t))) return false;
      // Dedupe key: the task whose completion closed out the queue. As long
      // as a *different* task closes it out next time, this fires again.
      return { triggerKey: justCompletedTask.id };
    }
  },
  {
    key: 'perfect_week',
    label: 'Perfect Week',
    icon: '📅',
    description: 'Seven consecutive days with no overdue tasks.',
    celebration: false,
    check(ctx) {
      if (ctx.streak.noOverdueStreak !== 7) return false;
      return { triggerKey: `streak7-${ctx.todayStr}` };
    }
  },
  {
    key: 'consistency',
    label: 'Consistency',
    icon: '🔥',
    description: 'Thirty consecutive days with no overdue tasks.',
    celebration: false,
    check(ctx) {
      if (ctx.streak.noOverdueStreak !== 30) return false;
      return { triggerKey: `streak30-${ctx.todayStr}` };
    }
  }
  // Future ideas from the brief (Speed Runner) are tracked as a running
  // personal stat instead of a discrete achievement — see
  // `tasksFinishedEarly` in computeMemberStats — to avoid spawning a new
  // badge every single time someone finishes a task early, which would tip
  // this from "recognition" into "noisy game feed".
];

// Runs every definition against the current context, returns the ones
// newly earned (i.e. not already present in `existingTriggerKeys`, a Set of
// "type:triggerKey" strings already recorded for this member). Pure — does
// not touch storage; the caller persists whatever comes back.
function evaluateAchievements(ctx, existingTriggerKeys) {
  const earned = [];
  for (const def of DEFINITIONS) {
    const result = def.check(ctx);
    if (!result) continue;
    const triggerKey = typeof result === 'object' ? result.triggerKey : String(result);
    const dedupeId = `${def.key}:${triggerKey}`;
    if (existingTriggerKeys.has(dedupeId)) continue;
    const variant = def.celebration ? pickCelebrationVariant() : { icon: def.icon, title: def.label };
    earned.push({
      type: def.key,
      triggerKey,
      icon: variant.icon,
      title: variant.title,
      message: def.description,
      celebration: def.celebration
    });
  }
  return earned;
}

module.exports = {
  isOnTime, isFinishedEarly, isCurrentlyOverdue,
  touchOverdueStreak, computeMemberStats, computeClickScore,
  evaluateAchievements, DEFINITIONS, CELEBRATION_VARIANTS
};

// The scheduling engine is the single source of truth for all task-date math:
// overlap checks, sequencing, shifting tasks when one is inserted or removed,
// and figuring out when an engineer is next free. Every route that touches
// task dates should go through here rather than reimplementing date math.
//
// WORKING WEEK: Friday and Saturday are non-working days. Nobody is ever
// scheduled to start or end a task on one of those two days, and they don't
// count toward a task's "duration in days" — a 3-day task starting Thursday
// runs Thu, then skips Fri/Sat, then finishes Sun/Mon. All the shifting logic
// below (insert/remove/restore) moves things by *working* days for the same
// reason, so a task that's pushed back by another task's length never lands
// on a Friday or Saturday either.
//
// TIMEZONE SAFETY: every date here is a plain YYYY-MM-DD string with no
// timezone attached. parseDate/addDays parse and re-serialize them entirely
// in UTC on purpose — parsing as local midnight and reading back out via
// toISOString() (UTC) shifts by a day in any timezone ahead of UTC, and can
// make "add one day" return the *same* day, which turns the while-loops in
// addWorkingDays/shiftByWorkingDays below into infinite loops that would
// hang the whole server process. Keep every date computation going through
// parseDate/addDays (and their UTC getters/setters) rather than reaching for
// `new Date(...)` directly.

function todayStr() { return new Date().toISOString().slice(0, 10); }

function parseDate(d) { return new Date(d + 'T00:00:00Z'); }

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inclusive calendar day count between two ISO date strings, e.g. 1 Aug -> 3
// Aug = 3 days. This is plain calendar time (used for reporting on elapsed
// time, e.g. Estimated vs Actual) — see workingDaysInclusive for the
// weekend-aware version used by the scheduling/shifting logic itself.
function diffDaysInclusive(startStr, endStr) {
  const s = parseDate(startStr), e = parseDate(endStr);
  return Math.round((e - s) / 86400000) + 1;
}

// ISO date strings (YYYY-MM-DD) sort correctly with plain string comparison.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ---------- WORKING WEEK (Friday & Saturday off) ----------

// getDay(): 0=Sun, 1=Mon, ... 5=Fri, 6=Sat. Using the UTC getter here (to
// match parseDate's UTC anchoring above) is what keeps this correct
// regardless of the server's own local timezone.
function isNonWorkingDay(dateStr) {
  const dow = parseDate(dateStr).getUTCDay();
  return dow === 5 || dow === 6;
}

// Rolls a date forward to the next working day (returns the same date if
// it's already a working day).
function nextWorkingDay(dateStr) {
  let d = dateStr;
  while (isNonWorkingDay(d)) d = addDays(d, 1);
  return d;
}

// Working-day count between two ISO dates inclusive, skipping Fri/Sat.
function workingDaysInclusive(startStr, endStr) {
  let d = startStr, count = 0;
  while (d <= endStr) {
    if (!isNonWorkingDay(d)) count++;
    d = addDays(d, 1);
  }
  return count;
}

// Adds N working days to a start date and returns the resulting date, e.g.
// addWorkingDays('2026-07-16', 3) treats the start date itself as working
// day 1 and returns the date of working day 3, skipping any Fri/Sat in
// between. Snaps the start date forward first if it happens to land on a
// non-working day.
function addWorkingDays(startDate, workDays) {
  let d = nextWorkingDay(startDate);
  let count = 1;
  while (count < workDays) {
    d = addDays(d, 1);
    if (!isNonWorkingDay(d)) count++;
  }
  return d;
}

// Shifts a date forward (or backward, if workDays is negative) by a number
// of working days, always landing on a working day. Used to move a whole
// queue of already-valid (non-weekend) dates by a task's working-day length
// without ever re-introducing a Friday/Saturday as a start or end date.
function shiftByWorkingDays(dateStr, workDays) {
  if (!workDays) return dateStr;
  let d = dateStr;
  let remaining = Math.abs(workDays);
  const step = workDays > 0 ? 1 : -1;
  while (remaining > 0) {
    d = addDays(d, step);
    if (!isNonWorkingDay(d)) remaining--;
  }
  return d;
}

// All of an engineer's dated tasks, in queue order. Same object references as
// in the `tasks` array passed in, so mutating the result mutates `tasks` too.
function engineerTasks(tasks, assigneeId, excludeId) {
  return tasks
    .filter(t => t.assignee === assigneeId && (!excludeId || t.id !== excludeId) && t.startDate && t.endDate)
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

function detectOverlap(tasks, assigneeId, startDate, endDate, excludeId) {
  if (!assigneeId || !startDate || !endDate) return false;
  return engineerTasks(tasks, assigneeId, excludeId)
    .some(t => rangesOverlap(startDate, endDate, t.startDate, t.endDate));
}

function nextSequence(tasks, assigneeId) {
  const list = engineerTasks(tasks, assigneeId);
  return list.length ? Math.max(...list.map(t => t.sequence || 0)) + 1 : 1;
}

// Inserts a new task of `durationDays` WORKING days into an engineer's
// queue, either at the very front (afterTaskId = null/undefined) or right
// after a given existing task. Every task from that point on shifts forward
// by the same working-day length (keeping its own duration, order, and its
// non-weekend start/end dates), so nothing overlaps and nothing lands on a
// Friday or Saturday. Mutates the shifted tasks in place (they're the same
// objects as in `tasks`) and returns the new task's computed
// {startDate, endDate, sequence}.
function insertWithShift(tasks, assigneeId, { afterTaskId, durationDays }) {
  const list = engineerTasks(tasks, assigneeId);
  let insertIndex = 0;
  let newStart;

  if (afterTaskId) {
    insertIndex = list.findIndex(t => t.id === afterTaskId);
    if (insertIndex === -1) throw new Error('BAD_REQUEST');
    newStart = nextWorkingDay(addDays(list[insertIndex].endDate, 1));
    insertIndex += 1;
  } else {
    newStart = list.length ? list[0].startDate : nextWorkingDay(todayStr());
  }

  const newEnd = addWorkingDays(newStart, durationDays);
  const newSequence = insertIndex + 1;

  // Completed tasks are a historical record, not part of the open queue —
  // shifting them because a new task got inserted would silently rewrite
  // when a "done" task actually happened (and corrupt anything that reports
  // on it later, like the Estimated-vs-Actual dashboard or personal stats).
  // Sequence still gets renumbered for everyone (harmless, and keeps the
  // numbering contiguous), but only open tasks' dates actually move.
  list.slice(insertIndex).forEach(t => {
    if (t.status === 'done') return;
    t.startDate = shiftByWorkingDays(t.startDate, durationDays);
    t.endDate = shiftByWorkingDays(t.endDate, durationDays);
  });

  list.forEach((t, i) => { t.sequence = i < insertIndex ? i + 1 : i + 2; });

  return { startDate: newStart, endDate: newEnd, sequence: newSequence };
}

// After a task is removed (or moved off) an engineer's queue, close the gap
// by shifting every later task backward by the removed task's working-day
// length, and renumber sequence so it stays a clean 1..N per engineer.
function removeAndCompact(tasks, assigneeId, removedTask) {
  if (!removedTask.startDate || !removedTask.endDate) return;
  const workDuration = workingDaysInclusive(removedTask.startDate, removedTask.endDate);
  const list = engineerTasks(tasks, assigneeId, removedTask.id)
    .filter(t => (t.sequence || 0) > (removedTask.sequence || 0));
  list.forEach(t => {
    if (t.status !== 'done') {
      t.startDate = shiftByWorkingDays(t.startDate, -workDuration);
      t.endDate = shiftByWorkingDays(t.endDate, -workDuration);
    }
    t.sequence = (t.sequence || 0) - 1;
  });
}

// The mirror image of removeAndCompact — used by the "undo delete" flow.
// Re-opens the gap a deleted task used to occupy (shifting every task at or
// after its old sequence forward again by its working-day length) and then
// re-inserts the original task object exactly as it was, sequence and dates
// included. This only lines up cleanly if that engineer's queue hasn't
// changed since the delete — see the Undo notes in the README.
function restoreRemovedTask(tasks, assigneeId, removedTask) {
  if (removedTask.startDate && removedTask.endDate) {
    const workDuration = workingDaysInclusive(removedTask.startDate, removedTask.endDate);
    const list = engineerTasks(tasks, assigneeId)
      .filter(t => (t.sequence || 0) >= (removedTask.sequence || 0));
    list.forEach(t => {
      if (t.status !== 'done') {
        t.startDate = shiftByWorkingDays(t.startDate, workDuration);
        t.endDate = shiftByWorkingDays(t.endDate, workDuration);
      }
      t.sequence = (t.sequence || 0) + 1;
    });
  }
  tasks.push(removedTask);
}

// The day after an engineer's last scheduled task ends (today if they have
// none), rolled forward off a Friday/Saturday if it lands on one.
function nextAvailableDate(tasks, assigneeId) {
  const list = engineerTasks(tasks, assigneeId);
  if (list.length === 0) return nextWorkingDay(todayStr());
  return nextWorkingDay(addDays(list[list.length - 1].endDate, 1));
}

const CAPACITY_WINDOW_DAYS = 14;

// Only an engineer's still-open (not done) dated tasks count toward their
// current workload/capacity — completed work no longer occupies their future.
function openEngineerTasks(tasks, assigneeId) {
  return engineerTasks(tasks, assigneeId).filter(t => t.status !== 'done');
}

// Current workload snapshot for one engineer: how many days of open work
// they're carrying, how many open tasks, when they're next free, and a
// capacity percentage relative to a rolling window (default 14 days).
// "Days of open work" and the capacity window are calendar-based (they're
// meant to read as "the next N calendar days"); "next available" is snapped
// off weekends since that's an actual date someone could start on.
function engineerCapacity(tasks, assigneeId, windowDays) {
  windowDays = windowDays || CAPACITY_WINDOW_DAYS;
  const openTasks = openEngineerTasks(tasks, assigneeId);
  const occupiedDays = openTasks.reduce((sum, t) => sum + diffDaysInclusive(t.startDate, t.endDate), 0);
  const nextAvailable = openTasks.length
    ? nextWorkingDay(addDays(openTasks[openTasks.length - 1].endDate, 1))
    : nextWorkingDay(todayStr());
  const capacityPct = Math.min(100, Math.round((occupiedDays / windowDays) * 100));
  return { totalAssigned: openTasks.length, occupiedDays, nextAvailable, capacityPct };
}

module.exports = {
  todayStr, addDays, diffDaysInclusive, rangesOverlap,
  isNonWorkingDay, nextWorkingDay, workingDaysInclusive, addWorkingDays, shiftByWorkingDays,
  engineerTasks, detectOverlap, nextSequence,
  insertWithShift, removeAndCompact, restoreRemovedTask, nextAvailableDate,
  openEngineerTasks, engineerCapacity, CAPACITY_WINDOW_DAYS
};

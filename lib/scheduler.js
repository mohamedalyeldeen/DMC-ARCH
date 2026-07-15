// The scheduling engine is the single source of truth for all task-date math:
// overlap checks, sequencing, shifting tasks when one is inserted or removed,
// and figuring out when an engineer is next free. Every route that touches
// task dates should go through here rather than reimplementing date math.

function todayStr() { return new Date().toISOString().slice(0, 10); }

function parseDate(d) { return new Date(d + 'T00:00:00'); }

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inclusive day count between two ISO date strings, e.g. 1 Aug -> 3 Aug = 3 days.
function diffDaysInclusive(startStr, endStr) {
  const s = parseDate(startStr), e = parseDate(endStr);
  return Math.round((e - s) / 86400000) + 1;
}

// ISO date strings (YYYY-MM-DD) sort correctly with plain string comparison.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// All of an engineer's dated tasks, in queue order. Same object references as
// in the `tasks` array passed in, so mutating the result mutates `tasks` too.
function engineerTasks(tasks, assigneeId, excludeId) {
  return tasks
    .filter(t => t.assignee === assigneeId && t.id !== excludeId && t.startDate && t.endDate)
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

// Inserts a new task of `durationDays` into an engineer's queue, either at
// the very front (afterTaskId = null/undefined) or right after a given
// existing task. Every task from that point on shifts forward by
// `durationDays` (keeping its own duration and order), so nothing overlaps.
// Mutates the shifted tasks in place (they're the same objects as in
// `tasks`) and returns the new task's computed {startDate, endDate, sequence}.
function insertWithShift(tasks, assigneeId, { afterTaskId, durationDays }) {
  const list = engineerTasks(tasks, assigneeId);
  let insertIndex = 0;
  let newStart;

  if (afterTaskId) {
    insertIndex = list.findIndex(t => t.id === afterTaskId);
    if (insertIndex === -1) throw new Error('BAD_REQUEST');
    newStart = addDays(list[insertIndex].endDate, 1);
    insertIndex += 1;
  } else {
    newStart = list.length ? list[0].startDate : todayStr();
  }

  const newEnd = addDays(newStart, durationDays - 1);
  const newSequence = insertIndex + 1;

  list.slice(insertIndex).forEach(t => {
    t.startDate = addDays(t.startDate, durationDays);
    t.endDate = addDays(t.endDate, durationDays);
  });

  list.forEach((t, i) => { t.sequence = i < insertIndex ? i + 1 : i + 2; });

  return { startDate: newStart, endDate: newEnd, sequence: newSequence };
}

// After a task is removed (or moved off) an engineer's queue, close the gap
// by shifting every later task backward by the removed task's duration, and
// renumber sequence so it stays a clean 1..N per engineer.
function removeAndCompact(tasks, assigneeId, removedTask) {
  if (!removedTask.startDate || !removedTask.endDate) return;
  const duration = diffDaysInclusive(removedTask.startDate, removedTask.endDate);
  const list = engineerTasks(tasks, assigneeId, removedTask.id)
    .filter(t => (t.sequence || 0) > (removedTask.sequence || 0));
  list.forEach(t => {
    t.startDate = addDays(t.startDate, -duration);
    t.endDate = addDays(t.endDate, -duration);
    t.sequence = (t.sequence || 0) - 1;
  });
}

// The day after an engineer's last scheduled task ends (today if they have none).
function nextAvailableDate(tasks, assigneeId) {
  const list = engineerTasks(tasks, assigneeId);
  if (list.length === 0) return todayStr();
  return addDays(list[list.length - 1].endDate, 1);
}

module.exports = {
  todayStr, addDays, diffDaysInclusive, rangesOverlap,
  engineerTasks, detectOverlap, nextSequence,
  insertWithShift, removeAndCompact, nextAvailableDate
};

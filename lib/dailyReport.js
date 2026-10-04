// Daily Report — the staging area for the per-engineer monthly tracking
// workbook people maintain by hand today (one .xlsm per engineer, a
// "Database" table with one row per task per day). Engineers enter a
// month's rows here once; Click exports them in that workbook's exact
// column order so they can be pasted into the original.
//
// Every list below is copied verbatim from that workbook's "Lists" sheet —
// including its odd whitespace ("Building ", "MV-North Coast ", and
// "CLEAN \nCOPY" with a real line break). That's deliberate: the original's
// VALUE lookup and its per-project totals match on exact text, so a
// "cleaned up" spelling here would paste in as a row those formulas can't
// see. To add a project or item, add it here (the dropdowns follow).

const STATUSES = ['Weekend', 'Absent', 'At work', 'Training', 'Mission', 'Sick', 'Vacation', 'Permission'];
const DWGS_STATUSES = ['Submitted', 'on progress'];
const PACKAGES = ['Building ', 'Infra', 'Landscape'];
const PROJECTS = [
  'ICity-New Cairo', 'MV 1.1', 'Aliva', 'Hyde Park Mountain View', 'Lana Park', 'Life sports club', 'COP',
  'October Park - Extension', 'ICity - October', 'Sodic - June - North coast', 'MV-North Coast ', 'LVLS',
  'ORA - ZED East Compound - Landscape works', 'Sodic - The Estates', 'HHD - New Heliopolis - Landscape Work',
  "Sa'aada-Lagoon landscape", 'New Administrative Capital- CBD- Landscape Work',
  'Swan Lake Residence - Sports Club Landscape', 'Engineering Building', 'kingsway'
];
const ITEMS = [
  'Block work', 'Elevation', 'Stair finish', 'Stair concrete dimensions', 'Flooring', 'Ceiling', 'Wall finish',
  'Toilet details', 'AC study', 'Shingle', 'Roofing system', 'Slab on grade', 'Ramps concrete dimesions',
  'Basement signage plan'
];
const TYPES = [
  'Shop Drawings', 'CLEAN \nCOPY', 'AS BUILT', 'DESIGN CHECK', 'RFP', 'Q.S', 'RFI', 'Modeling', 'Coordination', 'Review'
];
const REV_NOS = ['REV.0', "REV'S 50%", "REV'S 100%", 'REV.s'];

// (type, subtype) -> weight per revision stage, same order as REV_NOS.
const VALUE_TABLE = [
  ['Shop Drawings', 'CAD', [1, 0.5, 1, 0]],
  ['Shop Drawings', 'BIM', [2.5, 0.8, 2.5, 0]],
  ['Modeling', 'BIM', [0, 0, 0, 0]],
  ['AS BUILT', 'CAD', [1, 0.5, 1, 0]],
  ['AS BUILT', 'BIM', [2.5, 0.8, 2.5, 0]],
  ['DESIGN CHECK', 'CAD', [1, 0.5, 1, 0]],
  ['DESIGN CHECK', 'BIM', [2.5, 0.8, 2.5, 0]],
  ['RFP', 'CAD', [1, 0.5, 1, 0]],
  ['RFP', 'BIM', [2.5, 0.8, 2.5, 0]],
  ['Q.S', 'CAD', [1, 0.5, 1, 0]],
  ['Q.S', 'BIM', [2.5, 0.8, 2.5, 0]],
  ['RFI', 'INFO', [0, 0, 0, 0]],
  ['RFI', 'TIME/COST', [0, 0, 0, 0]],
  ['CLEAN \nCOPY', 'CAD', [1, 0.5, 1, 0]],
  ['CLEAN \nCOPY', 'BIM', [2.5, 0.8, 2.5, 0]]
];

const SUBTYPES = ['CAD', 'BIM', 'INFO', 'TIME/COST'];

// Subtypes each type allows — derived from the value table so the two can
// never disagree. Types with no rows (Coordination, Review) take none.
const SUBTYPES_BY_TYPE = {};
VALUE_TABLE.forEach(([type, subtype]) => {
  (SUBTYPES_BY_TYPE[type] = SUBTYPES_BY_TYPE[type] || []).push(subtype);
});

function lookupValue(type, subtype, revNo) {
  const row = VALUE_TABLE.find(r => r[0] === type && r[1] === subtype);
  const col = REV_NOS.indexOf(revNo);
  return row && col >= 0 ? row[2][col] : '';
}

const MAX_ROWS_PER_SAVE = 600;

function fail(message) {
  const err = new Error('BAD_REQUEST');
  err.userMessage = message;
  return err;
}

function cleanText(v, max) {
  return (v === undefined || v === null ? '' : String(v)).replace(/\r/g, '').slice(0, max);
}

function pickFrom(list, v, label, n) {
  if (v === '' || v === undefined || v === null) return '';
  if (!list.includes(v)) throw fail(`Row ${n}: "${v}" isn't a valid ${label}.`);
  return v;
}

// Validates and normalises one submitted row. Dropdown-backed fields that
// feed the VALUE/TOT calculations (status, type, subtype, rev, dwgs status)
// are strict; project/area/package/item/description/notes stay free text —
// new projects turn up faster than this file gets edited, and none of those
// affect a calculation.
function normalizeRow(r, month, n) {
  const date = cleanText(r.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) {
    throw fail(`Row ${n}: the date must be inside ${month}.`);
  }
  const status = r.status ? pickFrom(STATUSES, r.status, 'status', n) : 'At work';
  const type = pickFrom(TYPES, r.type, 'TYPE', n);
  const subtype = pickFrom(SUBTYPES, r.subtype, 'subtype', n);
  if (subtype && type && !(SUBTYPES_BY_TYPE[type] || []).includes(subtype)) {
    throw fail(`Row ${n}: "${subtype}" isn't available for ${type.replace(/\s+/g, ' ')}.`);
  }
  const revNo = pickFrom(REV_NOS, r.revNo, 'REV NO.', n);
  const dwgsStatus = pickFrom(DWGS_STATUSES, r.dwgsStatus, 'DWGS status', n);

  let numDwgs = '';
  if (r.numDwgs !== '' && r.numDwgs !== undefined && r.numDwgs !== null) {
    numDwgs = Number(r.numDwgs);
    if (!isFinite(numDwgs) || numDwgs < 0 || numDwgs > 10000) throw fail(`Row ${n}: NO OF DWGS must be a number from 0 up.`);
  }
  let normalHours = '';
  if (r.normalHours !== '' && r.normalHours !== undefined && r.normalHours !== null) {
    normalHours = Number(r.normalHours);
    if (!isFinite(normalHours) || normalHours < 0 || normalHours > 24) throw fail(`Row ${n}: Normal Hours must be between 0 and 24.`);
  }
  return {
    date, status,
    project: cleanText(r.project, 200), area: cleanText(r.area, 200), package: cleanText(r.package, 200),
    item: cleanText(r.item, 200), type, subtype, revNo, numDwgs,
    description: cleanText(r.description, 1000), notes: cleanText(r.notes, 500),
    normalHours, dwgsStatus
  };
}

module.exports = {
  STATUSES, DWGS_STATUSES, PACKAGES, PROJECTS, ITEMS, TYPES, SUBTYPES, SUBTYPES_BY_TYPE, REV_NOS, VALUE_TABLE,
  lookupValue, normalizeRow, MAX_ROWS_PER_SAVE
};

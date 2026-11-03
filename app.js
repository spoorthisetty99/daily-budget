'use strict';

/* ================= Storage ================= */

const STORE_KEY = 'daily-budget-v1';

const DEFAULT_STATE = {
  settings: {
    income: 0,
    rollover: true,          // underspend today → higher budget tomorrow
    reminderTime: '21:00',   // nightly "how did you do" notification
    notify: false,
    startDate: null,         // first day tracking started (YYYY-MM-DD)
    fixed: [],               // fixed monthly costs: { id, name, amount }
    myName: '',              // your name as banks show it; payments to it are transfers between your own accounts
    accounts: [],            // savings accounts: { id, name, balance, asOf }
    investments: [],         // { id, type, name, invested, current?, date, rate?, maturity?, note? }
  },
  txns: [],                  // { id, date: 'YYYY-MM-DD', time, name, category, method, amount }
  lastSummary: null,         // date key of the last night-summary sent
  seenSms: [],               // fingerprints of auto-imported messages, so a re-opened link isn't counted twice
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw) return { ...DEFAULT_STATE, ...raw, settings: { ...DEFAULT_STATE.settings, ...raw.settings } };
  } catch { /* fall through to defaults */ }
  return structuredClone(DEFAULT_STATE);
}

let state = load();

/**
 * Saves locally, and queues `ops` for the PC server (server.py) when there is one.
 * Ops: {type:'add', txn} · {type:'delete', id} · {type:'update', id, changes} · {type:'settings', settings} · {type:'seen', fp} · {type:'replace', state}
 */
function save(...ops) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (ops.length && recordOps) queueOps(ops);
}

/* ================= Sync with the PC server ================= */

const OUTBOX_KEY = 'daily-budget-outbox';
let serverMode = false;   // true when served by server.py (has /api/state)
let recordOps = true;     // off while bulk-building state (demo data)
let outbox = [];
try { outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { /* empty */ }
const saveOutbox = () => localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
const shareable = (s) => ({ settings: s.settings, txns: s.txns, seenSms: s.seenSms });

// The app key (BUDGET_KEY on the server) guards your data once the app is on the internet.
const APPKEY_KEY = 'daily-budget-key';
let appKey = '';
try { appKey = localStorage.getItem(APPKEY_KEY) || ''; } catch { /* private mode */ }
let needKey = false;
const api = (path, opts = {}) =>
  fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...(appKey ? { 'X-Budget-Key': appKey } : {}) } });

function queueOps(ops) {
  outbox.push(...ops);
  saveOutbox();
  queueMicrotask(flush); // batches everything saved in the same tick
}

/** Takes the server's state; keeps this device's own bookkeeping. Returns true if anything changed. */
function adopt(remote) {
  const next = {
    ...DEFAULT_STATE,
    ...remote,
    settings: { ...DEFAULT_STATE.settings, ...remote.settings },
    lastSummary: state.lastSummary,
  };
  const changed = JSON.stringify(shareable(next)) !== JSON.stringify(shareable(state));
  state = next;
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  return changed;
}

let flushing = false;
async function flush() {
  if (!serverMode || flushing || !outbox.length) return;
  flushing = true;
  const ops = outbox.splice(0);
  try {
    const res = await api('api/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    });
    if (res.status === 401) { needKey = true; render(); }
    if (!res.ok) throw new Error(res.status);
    if (adopt(await res.json()) && !isEditing()) render();
  } catch {
    outbox.unshift(...ops);
    if (!needKey) toast('Saved on this phone. It will sync when the server is reachable.');
  } finally {
    saveOutbox();
    flushing = false;
  }
}

// Don't redraw under someone typing (the setup screen doesn't count: synced data replaces it).
const isEditing = () =>
  sheet.open ||
  (view.contains(document.activeElement) &&
    /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) &&
    !document.activeElement.closest('#onboard-form, #key-form'));

/** Finds the server; on first contact moves this device's data up if the server has none. */
async function connect() {
  let res;
  try {
    res = await api('api/state', { cache: 'no-store' });
  } catch {
    return; // server unreachable right now: keep working locally, outbox waits
  }
  if (res.status === 401) {
    needKey = true; // the server has a key and we don't have the right one
    return render();
  }
  needKey = false;
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
    outbox = []; // plain static hosting: nothing to sync with
    saveOutbox();
    return;
  }
  const remote = await res.json();
  serverMode = true;
  if (!remote.settings?.income && state.settings.income) {
    outbox.unshift({ type: 'replace', state: shareable(state) });
  } else if (!outbox.length) {
    adopt(remote);
  }
  await flush();
  if (!isEditing()) render();
}

/** Picks up spends the shortcut added in the background. */
async function refresh() {
  if (!serverMode) return connect();
  await flush();
  if (outbox.length) return;
  try {
    const res = await api('api/state', { cache: 'no-store' });
    if (res.status === 401) { needKey = true; serverMode = false; return render(); }
    if (res.ok && adopt(await res.json()) && !isEditing()) render();
  } catch { /* offline */ }
}

/* ================= Dates & money ================= */

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const daysInMonth = (k) => { const d = parseKey(k); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
const monthStart = (k) => k.slice(0, 8) + '01';
const monthEnd = (k) => k.slice(0, 8) + pad(daysInMonth(k));
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);

const inr = (n) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
const shortDate = (k) => parseKey(k).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/* ================= Budget engine ================= */

// Fixed monthly costs (rent, SIP, EMI…) are set aside first; the rest is split across the days.
const fixedTotal = () => (state.settings.fixed || []).reduce((s, f) => s + Number(f.amount || 0), 0);
const spendable = () => Math.max(0, state.settings.income - fixedTotal());
const baseDaily = (k) => spendable() / daysInMonth(k);

// The list also holds big one-off spends (kind 'big': card bills, a laptop…) and money received
// (kind 'credit'). Neither touches the daily budget; daily spends have no kind.
const isDaily = (t) => !t.kind;
const daily = () => state.txns.filter(isDaily);

// "Fixed" spends (rent, SIP…) were already set aside, so they don't eat the daily budget either.
const counts = (t) => isDaily(t) && t.category !== 'Fixed';

const spentOn = (k) => state.txns.filter((t) => t.date === k && counts(t)).reduce((s, t) => s + t.amount, 0);

const spentBetween = (from, toExclusive) =>
  state.txns.filter((t) => t.date >= from && t.date < toExclusive && counts(t)).reduce((s, t) => s + t.amount, 0);

/**
 * Today's allowance.
 * Without rollover it's simply income ÷ days in the month.
 * With rollover, whatever is left of this month's money (since tracking started)
 * is spread evenly over the days left — so a good day raises tomorrow's budget
 * and a bad day lowers it.
 */
function budgetFor(k) {
  const base = baseDaily(k);
  if (!state.settings.rollover) return base;
  const start = [monthStart(k), state.settings.startDate || k].sort().pop();
  if (k <= start) return base;
  const trackedDays = daysBetween(start, monthEnd(k)) + 1;
  const daysLeft = daysBetween(k, monthEnd(k)) + 1;
  const left = base * trackedDays - spentBetween(start, k);
  return Math.max(0, left / daysLeft);
}

function stateColor(remaining, budget) {
  if (budget <= 0 || remaining <= 0) return 'var(--red)';
  const r = remaining / budget;
  if (r > 0.5) return 'var(--green)';
  if (r > 0.2) return 'var(--yellow)';
  return 'var(--red)';
}

/* ================= Categories ================= */

const ICONS = {
  cup: '<path d="M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8Z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2"/><path d="M9 3v2M12 3v2"/>',
  bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  scooter: '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7M15 6h2l1 8M6 14.5 9 9h5"/>',
  car: '<path d="M4 16V12l2-5h12l2 5v4"/><path d="M3 16h18"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 5v14M16 5v14"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z"/>',
  shirt: '<path d="M8 4 4 7l2 4 2-1v10h8V10l2 1 2-4-4-3a4 4 0 0 1-8 0Z"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>',
  in: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
  out: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
  bank: '<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  growth: '<path d="M4 18 10 12l4 4 6-8"/><path d="M15 8h5v5"/>',
};

const CATEGORIES = {
  'Food & drink':  'cup',
  'Groceries':     'bag',
  'Shopping':      'shirt',
  'Transport':     'car',
  'Bills':         'bolt',
  'Subscriptions': 'repeat',
  'Entertainment': 'film',
  'Health':        'heart',
  'Fixed':         'home', // rent, SIP, EMI: set aside up front, not counted against the day
  'Other':         'dot',
};

// Big one-off spends: kept out of the daily budget. A card bill only pays off purchases already logged.
const BIG_CATEGORIES = ['Card bill', 'Gadgets', 'Travel', 'Home', 'Medical', 'Education', 'Gifts', 'Other'];
const CREDIT_SOURCES = ['Salary', 'Bonus', 'Refund', 'Interest', 'Transfer in', 'Gift', 'Other'];
const INVEST_TYPES = ['Stocks', 'Mutual fund', 'FD', 'Bonds', 'PF', 'NPS', 'Gold', 'Crypto', 'Real estate', 'Other'];
const DATED_TYPES = ['FD', 'Bonds', 'PF', 'NPS']; // ask for an interest rate and maturity date

const icon = (cat, name = '', kind = '') => {
  const key = kind === 'credit' ? 'in' : cat === 'Card bill' ? 'card' : kind === 'big' ? 'out'
    : /zepto|swiggy instamart/i.test(name) ? 'scooter' : CATEGORIES[cat] || 'dot';
  return svgIcon(key);
};
const svgIcon = (key) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;

// Merchant keyword → category, used for quick-add and SMS auto-detection.
const MERCHANTS = [
  [/zepto|blinkit|bigbasket|instamart|dmart|jiomart|grocer|kirana|more retail/i, 'Groceries'],
  [/swiggy|zomato|starbucks|coffee|cafe|chai|tea|dominos|pizza|kfc|mcdonald|restaurant|bakery/i, 'Food & drink'],
  [/netflix|spotify|prime|hotstar|youtube|apple|icloud|google one|jio ?cinema|sonyliv|zee5|gym|cult/i, 'Subscriptions'],
  [/uber|ola|rapido|metro|irctc|petrol|fuel|indian oil|hpcl|bpcl|shell|fastag|redbus/i, 'Transport'],
  [/electric|bescom|tata power|airtel|jio|vi |vodafone|broadband|recharge|gas|water|rent/i, 'Bills'],
  [/amazon|flipkart|myntra|ajio|nykaa|meesho|decathlon|zara|h&m/i, 'Shopping'],
  [/bookmyshow|pvr|inox|steam|playstation/i, 'Entertainment'],
  [/pharma|apollo|medplus|1mg|pharmeasy|hospital|clinic|doctor/i, 'Health'],
];

/** A spend named like one of your fixed costs ("Rent", "Axis SIP"…) is that fixed cost being paid. */
const isFixedName = (name, fixed = state.settings.fixed || []) => {
  const n = String(name).toLowerCase().trim();
  return n.length >= 3 && fixed.some((f) => {
    const fn = String(f.name).toLowerCase().trim();
    return fn.length >= 3 && (n.includes(fn) || fn.includes(n));
  });
};

// "Credit card bill", "CC payment", CRED… (in a spend's name or anywhere in a bank alert).
const CARD_BILL = /credit ?card (bill|payment|dues)|card ?bill|\bcc (bill|payment)|\bcred\b|towards (your )?([a-z]+ )*credit card/i;

const guessCategory = (name) =>
  isFixedName(name) ? 'Fixed' : (MERCHANTS.find(([re]) => re.test(name)) || [, 'Other'])[1];

const QUICK_ADD = [
  { name: 'Coffee', category: 'Food & drink', amount: 250 },
  { name: 'Blinkit', category: 'Groceries', amount: 600 },
  { name: 'Zepto', category: 'Groceries', amount: 400 },
  { name: 'Swiggy', category: 'Food & drink', amount: 450 },
  { name: 'Uber', category: 'Transport', amount: 300 },
  { name: 'Chai', category: 'Food & drink', amount: 30 },
];

/* ================= SMS / UPI parser ================= */

/**
 * Pulls amount + merchant from typical Indian bank / UPI alerts, e.g.
 *  "Rs.250.00 debited from A/c XX1234 on 02-11-26 to VPA starbucks@hdfcbank (UPI Ref 1234)"
 *  "You have paid ₹600 to BLINKIT via UPI"
 *  "INR 1,250.00 spent on your Card XX12 at ZEPTO on 2026-11-02"
 */
function parseSms(text) {
  text = String(text).replace(/\s+/g, ' ').trim(); // emails arrive with line breaks
  // 'out' for a debit, 'in' for a credit ("debited … credited to VPA x" is still a debit).
  const dir = /debited/i.test(text) ? 'out' : /credited|received|deposited|refund/i.test(text) ? 'in'
    : /debited|paid|spent|sent|withdrawn|purchase|txn|payment of/i.test(text) ? 'out' : null;
  // A card bill's "payment received" comes from the card, not from a savings account.
  if (!dir || (dir === 'in' && CARD_BILL.test(text))) return null;
  // Skip "Avl Bal Rs 12,000" / "credit limit INR 50,000" — take the first amount that isn't a balance.
  const amounts = [...text.matchAll(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
    .filter((m) => !/(bal(ance)?|limit|avl\.?|available)\s*(is|:)?\s*$/i.test(text.slice(Math.max(0, m.index - 20), m.index)));
  if (!amounts.length) return null;
  const amount = parseFloat(amounts[0][1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  // The UPI reference is the same in the SMS and the email for one payment, so it catches cross-channel duplicates.
  const ref = text.match(/(?:\bref(?:erence)?(?:\s*no)?\.?|\brrn|\bupi(?:\/p2[am])?)[\s:\/#.-]*(\d{12})\b/i)?.[1];
  // The account's last digits: "A/C *3344", "A/c no. XX7788", "Account Number: XX7788", "account ending in 3344"
  const acct = text.match(/\b(?:a\/c|acct|account)(?:\s*(?:no|number)\.?)?\s*:?\s*(?:ending\s+(?:with\s+|in\s+)?|[x*]+)(\d{3,6})\b/i)?.[1];
  const base = { ...(ref ? { ref } : {}), ...(acct ? { acct } : {}), dir, amount, date: dateInText(text) };
  const tidy = (s) => s.replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 22);
  if (dir === 'in') {
    const from = text.match(/\b(?:from|by)\s+(?:vpa\s+)?(?:(?:neft|imps|rtgs|upi)[-\/ ]+)?([A-Za-z][\w&' .\-]{1,40}?)(?=\s+(?:on|via|ref|upi|for|to|avl|a\/c)\b|[.,(]|@|$)/i)
      || text.match(UPI_NAME) || text.match(INFO) || text.match(VPA);
    const name = tidy(from ? from[1] : '') || 'Money received';
    const source = (CREDIT_KINDS.find(([re]) => re.test(text)) || [, 'Other'])[1];
    return { kind: 'credit', ...base, name: titleCase(name), method: '', category: source };
  }
  let name = '';
  const vpa = text.match(VPA);
  const to = text.match(/\b(?:to|at|towards)\s+(?:vpa\s+)?([A-Za-z][\w&' .\-]{1,40}?)(?=\s+(?:on|via|ref|upi|using|from|for|avl|a\/c|\.|$)|[.,(]|@)/i);
  const upi = text.match(UPI_NAME);
  const info = text.match(INFO);
  if (to) name = to[1];
  else if (upi) name = upi[1];
  else if (info) name = info[1];
  else if (vpa) name = vpa[1];
  name = tidy(name) || 'UPI payment';
  const method = /card/i.test(text) ? 'Card' : /atm|withdrawn/i.test(text) ? 'Cash' : 'UPI';
  // Paying a credit card is a big spend, not a daily one: its purchases were already counted.
  const bill = CARD_BILL.test(text);
  if (bill && /credit|card|upi payment/i.test(name)) name = 'Credit card bill'; // not "Your Hdfc Bank Credit"
  const category = bill ? 'Card bill' : guessCategory(name);
  return { ...(bill ? { kind: 'big' } : {}), ...base, name: titleCase(name), method, category };
}

const VPA = /(?:vpa|upi id)\s*:?\s*([\w.\-]+)@[\w.]+/i;
// Axis & co: "UPI/P2A/512345678901/PRIYA SHARMA"
const UPI_NAME = /\bupi\/p2[am]\/\d+\/([A-Za-z][A-Za-z&' .]{1,40}?)(?=\s*\/|\s+not\b|\s+avl|[.,]|$)/i;
const INFO = /\binfo:?\s*(?:upi|pos|imps|neft|ach|ecom)?[-\/ ]*([A-Za-z][\w&' .]{1,30}?)(?=[.,]|\s+avl|\s+on\b|$)/i;
const CREDIT_KINDS = [[/salary|payroll|\bsal\b/i, 'Salary'], [/refund|reversal|cashback/i, 'Refund'], [/interest|\bint\.? ?pd/i, 'Interest'], [/bonus/i, 'Bonus']];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The date a bank alert mentions ("on 01-11-26", "02-Nov-26", "2026-11-01", "1 Nov 2026"),
 * so old alerts pasted in later land on the right day. Falls back to today.
 */
function dateInText(text) {
  const today = todayKey();
  const yr = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const tryKey = (y, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const k = `${y}-${pad(m)}-${pad(d)}`;
    return k <= today && daysBetween(k, today) <= 92 ? k : null;
  };
  let m;
  if ((m = text.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/))) return tryKey(+m[1], +m[2], +m[3]) || today;
  if ((m = text.match(/\b(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ,]+(\d{2,4})\b/))) {
    const mon = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (mon) return tryKey(yr(m[3]), mon, +m[1]) || today;
  }
  if ((m = text.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/))) return tryKey(yr(m[3]), +m[2], +m[1]) || today;
  return today;
}

/**
 * Splits a big paste into individual alerts: blank-line separated blocks (emails),
 * and within a block, one alert per line when several lines each hold a debit.
 */
function splitMessages(text) {
  const out = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const each = lines.filter((l) => parseSms(l));
    if (each.length > 1) out.push(...each);
    else if (block.trim()) out.push(block.trim());
  }
  return out;
}

/** Adds one alert unless it was already imported (by shortcut or paste). Returns the spend, { dup: spend } or null. */
function importMessage(text) {
  const fp = fingerprint(text);
  if (state.seenSms.includes(fp)) return { dup: parseSms(text) };
  const p = parseSms(text);
  if (!p) return null;
  remember(fp);
  moveBalance(p, fp);
  const same = p.ref && state.txns.find((t) => t.ref === p.ref);
  if (same) {
    // One UPI ref leaving one account and arriving in another: money moved between your own accounts.
    if (same.kind === 'transfer' || (same.kind === 'credit') !== (p.dir === 'in')) {
      const changes = { kind: 'transfer', category: 'Own account', method: '' };
      Object.assign(same, changes);
      save({ type: 'update', id: same.id, changes });
      return { transfer: p };
    }
    return { dup: same };
  }
  if (isSelf(p.name)) {
    addTxn({ ...p, kind: 'transfer', category: 'Own account', method: '' });
    return { transfer: p };
  }
  addTxn(p);
  return p;
}

function remember(key) {
  state.seenSms = [...state.seenSms, key].slice(-500);
  save({ type: 'seen', fp: key });
}

/**
 * Moves the savings account whose last digits are in the alert, once per payment (its SMS and email
 * share a UPI ref). Alerts dated before the day you typed the balance are already in it.
 */
function moveBalance(p, fp) {
  const d = p.acct;
  const accounts = state.settings.accounts || [];
  const acct = d && accounts.find((a) => (a.digits || '').length >= 3 && (d.endsWith(a.digits) || a.digits.endsWith(d)));
  const key = `bal:${p.ref || fp}:${p.dir}`;
  if (!acct || p.date < (acct.asOf || '') || state.seenSms.includes(key)) return null;
  acct.balance = Math.round((Number(acct.balance) + (p.dir === 'in' ? p.amount : -p.amount)) * 100) / 100;
  save({ type: 'settings', settings: { accounts } });
  remember(key);
  return acct;
}

/**
 * A payee matching your own name is money moved between your accounts, not a spend.
 * Banks cut names short ("PRIYA SHARMA"), so a two-word start of your name counts too.
 */
function isSelf(name, mine = state.settings.myName) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const a = norm(name), b = norm(mine);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && (short === long || (short.includes(' ') && long.startsWith(short)));
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/* ================= Mutations ================= */

function addTxn({ name, category, amount, method = 'UPI', date = todayKey(), note = '', ref, kind = '' }) {
  amount = Number(amount);
  if (!name || !(amount > 0)) return false;
  const ops = [];
  // Backfilled spends from before setup still count towards this month.
  if (!kind && state.settings.startDate && date < state.settings.startDate) {
    state.settings.startDate = date;
    ops.push({ type: 'settings', settings: { startDate: date } });
  }
  const now = new Date();
  const txn = {
    id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
    date,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    name: name.trim(),
    category: category || (kind ? 'Other' : guessCategory(name)),
    method: kind === 'credit' || kind === 'transfer' ? '' : method,
    amount,
    ...(kind ? { kind } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(ref ? { ref } : {}),
  };
  state.txns.push(txn);
  save(...ops, { type: 'add', txn });
  return true;
}

function deleteTxn(id) {
  state.txns = state.txns.filter((t) => t.id !== id);
  save({ type: 'delete', id });
}

function updateTxn(id, data) {
  const t = state.txns.find((x) => x.id === id);
  const amount = Number(data.amount);
  if (!t || !data.name?.trim() || !(amount > 0)) return false;
  const kind = data.kind || ''; // '' (not left out) so the server forgets an old kind too
  const changes = {
    amount,
    name: data.name.trim(),
    category: data.category,
    method: kind === 'credit' || kind === 'transfer' ? '' : data.method,
    date: data.date || t.date,
    note: (data.note || '').trim(),
    kind,
  };
  Object.assign(t, changes);
  const ops = [];
  if (!kind && state.settings.startDate && changes.date < state.settings.startDate) {
    state.settings.startDate = changes.date;
    ops.push({ type: 'settings', settings: { startDate: changes.date } });
  }
  save(...ops, { type: 'update', id, changes });
  return true;
}

/* ================= Rendering ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tab = 'today';

function render() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // Money and Invest have their own add buttons.
  $('#fab').style.display = ['settings', 'money', 'invest'].includes(tab) ? 'none' : '';
  if (needKey) return renderKeyPrompt();
  if (!state.settings.income) return renderOnboarding();
  ({ today: renderToday, month: renderMonth, money: renderMoney, invest: renderInvest, insights: renderInsights, settings: renderSettings })[tab]();
}

function txnHtml(t, { withDate } = {}) {
  const bits = [t.category + (t.category === 'Fixed' ? ' (set aside)' : ''), t.method, withDate && shortDate(t.date)].filter(Boolean);
  return `
    <div class="txn editable" data-edit="${t.id}" role="button" tabindex="0" aria-label="Edit ${esc(t.name)}">
      <div class="ico">${icon(t.category, t.name, t.kind)}</div>
      <div class="meta">
        <div class="name">${esc(t.name)}</div>
        <div class="cat">${esc(bits.join(' · '))}</div>
        ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}
      </div>
      <div class="amt${t.kind === 'credit' ? ' in' : ''}">${t.kind === 'credit' ? '+' : '−'}${inr(t.amount)}</div>
      <button class="del" data-del="${t.id}" aria-label="Delete">×</button>
    </div>`;
}

/** Everything in your savings accounts, on Today; a tap opens the Money tab. */
function bankTotalRow() {
  const accounts = state.settings.accounts || [];
  return `
    <button class="bank-total" data-goto="money">
      <span class="ico">${svgIcon('bank')}</span>
      <span class="meta">
        <span class="label">In your banks</span>
        <span class="sub">${accounts.length ? esc(accounts.map((a) => a.name).join(' · ')) : 'Add your accounts and balances'}</span>
      </span>
      <span class="amt">${accounts.length ? inr(sumOf(accounts, (a) => a.balance)) : 'Add ›'}</span>
    </button>`;
}

function renderToday() {
  const k = todayKey();
  const budget = budgetFor(k);
  const spent = spentOn(k);
  const remaining = budget - spent;
  const color = stateColor(remaining, budget);
  const pct = budget > 0 ? Math.max(0, Math.min(100, (remaining / budget) * 100)) : 0;
  const day = parseKey(k).getDate();
  const txns = daily().filter((t) => t.date === k).reverse();
  const tomorrow = previewTomorrow(k);

  view.innerHTML = `
    <section class="card" style="--state:${color}">
      <div class="budget-head">
        <span class="label">Today's budget</span>
        <span class="pill">DAY ${day}</span>
      </div>
      <div class="budget-row">
        <div class="big">${remaining < 0 ? '−' : ''}${inr(remaining)}</div>
        <div class="spent">
          <div class="label">Spent</div>
          <div class="amt">${spent ? '−' : ''}${inr(spent)}</div>
        </div>
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="sub">
        ${remaining < 0
          ? `Over by ${inr(-remaining)} · daily allowance ${inr(budget)}`
          : `of ${inr(budget)} today · ${fixedTotal() ? `(${inr(state.settings.income)} − ${inr(fixedTotal())} fixed)` : inr(state.settings.income)} ÷ ${daysInMonth(k)} days${state.settings.rollover && Math.round(budget) !== Math.round(baseDaily(k)) ? ' (adjusted)' : ''}`}
      </div>
    </section>

    ${bankTotalRow()}

    <button class="btn paste-cta" data-action="sms">📩 Paste SMS</button>

    ${nightSummaryCard(k)}

    <div class="label section-title">Quick add</div>
    <div class="quick">
      ${QUICK_ADD.map((q, i) => `<button class="chip" data-quick="${i}">${q.name} <b>${inr(q.amount)}</b></button>`).join('')}
    </div>

    <div class="label section-title">Today's transactions</div>
    <div class="txn-list">
      ${txns.length ? txns.map(txnHtml).join('') : '<div class="empty">No spends yet. Easy.</div>'}
    </div>

    ${state.settings.rollover && daysBetween(k, monthEnd(k)) > 0 ? `
      <p class="sub" style="text-align:center;margin-top:18px">
        If you stop here, tomorrow's budget is <b style="color:var(--text)">${inr(tomorrow)}</b>
      </p>` : ''}
  `;
}

function previewTomorrow(k) {
  const t = addDays(k, 1);
  if (monthStart(t) !== monthStart(k)) return baseDaily(t);
  return budgetFor(t);
}

function summaryFor(k) {
  const budget = budgetFor(k);
  const spent = spentOn(k);
  const good = spent <= budget;
  const tomorrow = previewTomorrow(k);
  const title = good ? 'Good day 💚' : 'Bad day 😬';
  const body = good
    ? `You spent ${inr(spent)} of your ${inr(budget)} budget. Saved ${inr(budget - spent)}${state.settings.rollover ? ` — tomorrow you get ${inr(tomorrow)}.` : '.'}`
    : `You spent ${inr(spent)} vs your ${inr(budget)} budget — ${inr(spent - budget)} over${state.settings.rollover ? `. Tomorrow's budget drops to ${inr(tomorrow)}.` : '.'}`;
  return { good, title, body };
}

function nightSummaryCard(k) {
  const [h, m] = state.settings.reminderTime.split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return '';
  const s = summaryFor(k);
  return `
    <section class="card summary ${s.good ? 'good' : 'bad'}">
      <div class="emoji">${s.good ? '🌙' : '🫠'}</div>
      <div><strong>${s.title}</strong><p>${s.body}</p></div>
    </section>`;
}

function renderMonth() {
  const k = todayKey();
  const first = parseKey(monthStart(k));
  const n = daysInMonth(k);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const monthSpent = spentBetween(monthStart(k), addDays(monthEnd(k), 1));
  const left = spendable() - monthSpent; // fixed costs are already set aside
  let good = 0, bad = 0;

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="day blank"></div>');
  for (let d = 1; d <= n; d++) {
    const dk = k.slice(0, 8) + pad(d);
    const spent = spentOn(dk);
    const tracked = !state.settings.startDate || dk >= state.settings.startDate;
    let cls = 'day';
    if (dk === k) cls += ' today';
    if (dk > k) cls += ' future';
    else if (tracked && dk < k) {
      if (spent <= budgetFor(dk)) { cls += ' good'; good++; } else { cls += ' bad'; bad++; }
    }
    const short = (n) => (n >= 10000 ? '₹' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : inr(n));
    const label = dk > k ? short(dk === addDays(k, 1) ? previewTomorrow(k) : budgetFor(k)) : spent ? short(spent) : dk < k && tracked ? '₹0' : '';
    const tap = dk <= k ? ` data-day="${dk}" role="button" aria-label="Spends on ${shortDate(dk)}"` : '';
    cells.push(`<div class="${cls}" title="${dk}"${tap}><span class="n">${d}</span><span class="s">${label}</span></div>`);
  }

  view.innerHTML = `
    <div class="stats">
      <div class="card stat"><div class="label">Spent this month</div><div class="v red">${inr(monthSpent)}</div></div>
      <div class="card stat"><div class="label">Left to spend</div><div class="v ${left >= 0 ? 'green' : 'red'}">${left < 0 ? '−' : ''}${inr(left)}</div></div>
      <div class="card stat"><div class="label">Good days</div><div class="v green">${good}</div></div>
      <div class="card stat"><div class="label">Bad days</div><div class="v red">${bad}</div></div>
    </div>
    <section class="card">
      <div class="label" style="margin-bottom:12px">${first.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</div>
      <div class="cal">
        ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="dow">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
      <p class="sub">Past days show what you spent (green = within budget). Future days show the projected allowance.</p>
    </section>
  `;
}

let insightRange = 'month';
let trendMode = 'day';

/* ---------- Spending trend chart (daily spends only; Fixed costs excluded) ---------- */

const TREND = {
  day:   { count: 30, compare: 7, unit: 'day' },
  week:  { count: 12, compare: 4, unit: 'week' },
  month: { count: 6,  compare: 3, unit: 'month' },
};

const weekStart = (k) => addDays(k, -((parseKey(k).getDay() + 6) % 7)); // Monday

/** Periods oldest → newest: { from, to, label, tip, value, budget, partial }. */
function trendSeries(mode) {
  const k = todayKey();
  const out = [];
  const perDay = baseDaily(k);
  for (let i = TREND[mode].count - 1; i >= 0; i--) {
    let from, to, label, tip, budget;
    if (mode === 'day') {
      from = to = addDays(k, -i);
      const d = parseKey(from);
      label = String(d.getDate());
      tip = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      budget = perDay;
    } else if (mode === 'week') {
      from = addDays(weekStart(k), -7 * i);
      to = addDays(from, 6);
      label = shortDate(from);
      tip = `${shortDate(from)} – ${shortDate(to)}`;
      budget = perDay * 7;
    } else {
      const d = parseKey(monthStart(k));
      d.setMonth(d.getMonth() - i);
      from = keyOf(d);
      to = monthEnd(from);
      label = d.toLocaleDateString('en-IN', { month: 'short' });
      tip = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      budget = spendable();
    }
    out.push({ from, to, label, tip, budget, value: spentBetween(from, addDays(to, 1)), partial: to >= k });
  }
  // Drop periods from before tracking started, and treat the one tracking started in as
  // incomplete (like the current one), so missing history doesn't fake a trend.
  const first = [state.settings.startDate, ...daily().map((t) => t.date)].filter(Boolean).sort()[0];
  if (!first) return out.slice(-1);
  return out.filter((p) => p.to >= first).map((p) => (p.from < first ? { ...p, partial: true } : p));
}

/** Least-squares line through the complete periods: value ≈ a + b·index. */
function fitLine(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const b = sxx ? points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}

/** Recent average vs the one before it ("last 7 days vs the 7 before"). */
function trendChange(series, mode) {
  const done = series.filter((p) => !p.partial).map((p) => p.value);
  let n = TREND[mode].compare;
  if (done.length < 2 * n) n = Math.floor(done.length / 2);
  if (n < 1) return null;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const recent = avg(done.slice(-n));
  const before = avg(done.slice(-2 * n, -n));
  if (!before) return null;
  return { n, recent, before, pct: (recent - before) / before };
}

function trendCard() {
  const mode = trendMode;
  const series = trendSeries(mode);
  const unit = TREND[mode].unit;
  const change = trendChange(series, mode);

  let headline;
  if (!change) {
    headline = `<p class="sub" style="margin:4px 0 0">Keep logging for a few more ${unit}s and the trend shows up here.</p>`;
  } else {
    const down = change.pct <= 0;
    const span = `${change.n} ${unit}${change.n > 1 ? 's' : ''}`;
    headline = `
      <div class="trend-head">
        <span class="trend-pill ${down ? 'good' : 'bad'}">${down ? '↓' : '↑'} ${Math.abs(Math.round(change.pct * 100))}% ${down ? 'spending down' : 'spending up'}</span>
      </div>
      <p class="sub" style="margin:6px 0 0">Last ${span}: <b style="color:var(--text)">${inr(change.recent)}</b> a ${unit} on average, vs ${inr(change.before)} the ${span} before.</p>`;
  }

  return `
    <section class="card trend-card">
      <div class="trend-top">
        <div class="label">Spending trend</div>
        <div class="segmented mini">
          ${[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']].map(([v, l]) =>
            `<button data-trend="${v}" class="${mode === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      ${headline}
      <div class="chart-wrap">${trendSvg(series)}<div class="chart-tip" role="status"></div></div>
      <div class="legend">
        <span><i class="sw" style="background:#7b5cff"></i>Within budget</span>
        <span><i class="sw" style="background:#ff3d6e"></i>Over budget</span>
        <span><i class="ln dashed"></i>Trend</span>
        <span><i class="ln dotted"></i>${unit === 'day' ? 'Daily' : unit === 'week' ? 'Weekly' : 'Monthly'} budget</span>
      </div>
      <p class="sub" style="margin-top:8px">Rent, SIP and other fixed costs aren't included. Faded bars are incomplete (the current ${unit}, or the one you started tracking in) and are left out of the trend.</p>
      <details class="table-view">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>${unit[0].toUpperCase() + unit.slice(1)}</th><th>Spent</th><th>Budget</th></tr></thead>
          <tbody>${series.slice().reverse().map((p) => `
            <tr><td>${esc(p.tip)}${p.partial ? ' (so far)' : ''}</td><td>${inr(p.value)}</td><td>${inr(p.budget)}</td></tr>`).join('')}
          </tbody>
        </table>
      </details>
    </section>`;
}

function trendSvg(series) {
  const W = 340, H = 190, L = 44, R = 8, T = 12, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const n = series.length;
  const max = Math.max(1, ...series.map((p) => Math.max(p.value, p.budget)));
  // Round the axis top to a friendly number.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / (step / 2)) * (step / 2);
  const y = (v) => T + ph - (v / top) * ph;
  const band = pw / n;
  const bw = Math.max(2, Math.min(28, band - 2)); // 2px gap between bars
  const x = (i) => L + band * i + (band - bw) / 2;
  const short = (v) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `₹${Math.round(v)}`);

  const grid = [0, 0.5, 1].map((f) => {
    const v = top * f, yy = y(v);
    return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid"/>
            <text x="${L - 6}" y="${yy + 3}" class="axis" text-anchor="end">${short(v)}</text>`;
  }).join('');

  const every = n > 14 ? Math.ceil(n / 6) : n > 8 ? 2 : 1;
  const bars = series.map((p, i) => {
    const h = Math.max(0, y(0) - y(p.value));
    const r = Math.min(4, h, bw / 2);
    const x0 = x(i), y0 = y(0);
    // Rounded data end, square at the baseline.
    const path = h > 0
      ? `M${x0},${y0} V${y0 - h + r} Q${x0},${y0 - h} ${x0 + r},${y0 - h} H${x0 + bw - r} Q${x0 + bw},${y0 - h} ${x0 + bw},${y0 - h + r} V${y0} Z`
      : '';
    const over = p.value > p.budget;
    const lbl = (n - 1 - i) % every === 0
      ? `<text x="${x0 + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${esc(p.label)}</text>` : '';
    return `
      <path d="${path}" class="bar ${over ? 'over' : ''} ${p.partial ? 'partial' : ''}"/>
      ${lbl}
      <rect class="hit" x="${L + band * i}" y="${T}" width="${band}" height="${ph}" tabindex="0"
        data-i="${i}" aria-label="${esc(p.tip)}: ${inr(p.value)} of ${inr(p.budget)} budget"/>`;
  }).join('');

  // Budget reference + trend line through complete periods.
  const budgetY = y(series[series.length - 1]?.budget || 0);
  const pts = series.map((p, i) => ({ x: i, y: p.value, partial: p.partial })).filter((p) => !p.partial);
  let trend = '';
  if (pts.length >= 3) {
    const { a, b } = fitLine(pts);
    const x1 = pts[0].x, x2 = pts[pts.length - 1].x;
    const cx = (i) => x(i) + bw / 2;
    trend = `<line x1="${cx(x1)}" y1="${y(Math.max(0, a + b * x1))}" x2="${cx(x2)}" y2="${y(Math.max(0, a + b * x2))}" class="trend"/>`;
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Spending per period with trend line">
      ${grid}
      ${bars}
      <line x1="${L}" x2="${W - R}" y1="${budgetY}" y2="${budgetY}" class="budget"/>
      ${trend}
    </svg>`;
}

/** Tooltip for the trend bars (hover, tap or keyboard focus). */
function showTrendTip(hit) {
  const wrap = hit.closest('.chart-wrap');
  const tip = wrap.querySelector('.chart-tip');
  const p = trendSeries(trendMode)[Number(hit.dataset.i)];
  if (!p) return;
  tip.replaceChildren();
  const v = document.createElement('strong');
  v.textContent = inr(p.value);
  const l = document.createElement('span');
  l.textContent = `${p.tip}${p.partial ? ' (so far)' : ''} · budget ${inr(p.budget)}`;
  tip.append(v, l);
  const svg = wrap.querySelector('svg').getBoundingClientRect();
  const r = hit.getBoundingClientRect();
  const left = Math.min(Math.max(r.left - svg.left + r.width / 2, 70), svg.width - 70);
  tip.style.left = `${left}px`;
  tip.classList.add('show');
  wrap.querySelectorAll('.bar').forEach((b, i) => b.classList.toggle('hover', i === Number(hit.dataset.i)));
}

function hideTrendTip(wrap) {
  wrap.querySelector('.chart-tip')?.classList.remove('show');
  wrap.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
}

view.addEventListener('pointerover', (e) => { const h = e.target.closest?.('.hit'); if (h) showTrendTip(h); });
view.addEventListener('focusin', (e) => { const h = e.target.closest?.('.hit'); if (h) showTrendTip(h); });
view.addEventListener('pointerout', (e) => { const w = e.target.closest?.('.chart-wrap'); if (w && !w.contains(e.relatedTarget)) hideTrendTip(w); });

function renderInsights() {
  const k = todayKey();
  const from = insightRange === 'week' ? addDays(k, -6) : insightRange === 'month' ? monthStart(k) : '0000-00-00';
  const txns = daily().filter((t) => t.date >= from && t.date <= k);
  const total = txns.reduce((s, t) => s + t.amount, 0);

  const byCat = {};
  const byMerchant = {};
  for (const t of txns) {
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    const m = t.name.toLowerCase();
    byMerchant[m] = byMerchant[m] || { name: t.name, total: 0, count: 0 };
    byMerchant[m].total += t.amount;
    byMerchant[m].count++;
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const top = Object.values(byMerchant).sort((a, b) => b.total - a.total).slice(0, 5);
  const subs = detectSubscriptions();
  const subsTotal = subs.reduce((s, x) => s + x.amount, 0);

  view.innerHTML = `
    ${trendCard()}

    <div class="segmented" style="margin-top:22px">
      ${[['week', '7 days'], ['month', 'This month'], ['all', 'All time']].map(([v, l]) =>
        `<button data-range="${v}" class="${insightRange === v ? 'on' : ''}">${l}</button>`).join('')}
    </div>

    <section class="card">
      <div class="label">Where your money went</div>
      <div class="big" style="font-size:40px;margin:8px 0 4px;--state:var(--text);text-shadow:none">${inr(total)}</div>
      <div class="sub" style="margin-top:0">${txns.length} transactions</div>
      ${cats.length ? cats.map(([c, v]) => `
        <div class="cat-row">
          <div class="top"><span>${esc(c)}</span><span>${inr(v)} · ${Math.round((v / total) * 100)}%</span></div>
          <div class="bar"><span style="width:${(v / cats[0][1]) * 100}%"></span></div>
        </div>`).join('') : '<div class="empty">Nothing logged yet.</div>'}
    </section>

    <div class="label section-title">Subscriptions you pay for</div>
    <section class="card">
      ${subs.length ? `
        ${subs.map((s) => `<div class="sub-row"><span>${esc(s.name)} <small style="color:var(--muted)">${s.reason}</small></span><span class="r">${inr(s.amount)}/mo</span></div>`).join('')}
        <div class="sub-row"><b>Total</b><span class="r">${inr(subsTotal)}/mo · ${inr(subsTotal * 12)}/yr</span></div>`
        : '<div class="empty" style="padding:12px 0">No subscriptions spotted yet. Log one under “Subscriptions”, or it will be detected when the same merchant charges you in two different months.</div>'}
    </section>

    <div class="label section-title">Top merchants</div>
    <div class="txn-list">
      ${top.map((m) => `
        <div class="txn">
          <div class="ico">${icon(guessCategory(m.name), m.name)}</div>
          <div class="meta"><div class="name">${esc(m.name)}</div><div class="cat">${m.count} × · avg ${inr(m.total / m.count)}</div></div>
          <div class="amt">−${inr(m.total)}</div>
        </div>`).join('') || '<div class="empty">—</div>'}
    </div>
  `;
}

/** Explicit "Subscriptions" category, or the same merchant charging a similar amount in 2+ months. */
function detectSubscriptions() {
  const groups = {};
  for (const t of daily()) {
    const key = t.name.toLowerCase();
    (groups[key] = groups[key] || []).push(t);
  }
  const out = [];
  for (const list of Object.values(groups)) {
    const latest = list.reduce((a, b) => (a.date > b.date ? a : b));
    if (list.some((t) => t.category === 'Subscriptions')) {
      out.push({ name: latest.name, amount: latest.amount, reason: '' });
      continue;
    }
    if (latest.category === 'Bills' || latest.category === 'Fixed') continue; // rent, EMIs etc. recur but aren't subscriptions
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const amounts = list.map((t) => t.amount);
    const similar = Math.max(...amounts) <= Math.min(...amounts) * 1.1;
    if (months.size >= 2 && similar && list.length <= months.size + 1) {
      out.push({ name: latest.name, amount: latest.amount, reason: '· recurring' });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

function fixedSection() {
  const fixed = state.settings.fixed || [];
  const k = todayKey();
  return `
    <div class="label section-title">Fixed monthly costs</div>
    <section class="card">
      <p class="sub" style="margin-top:0">Rent, SIP, EMI, insurance… set aside before your daily budget is worked out. When one is paid, its spend is tagged <b>Fixed</b> and doesn't count against that day.</p>
      <div class="txn-list" style="margin:12px 0">
        ${fixed.map((f) => `
          <div class="txn editable" data-fixed="${f.id}" role="button" tabindex="0" aria-label="Edit ${esc(f.name)}">
            <div class="ico">${icon('Fixed')}</div>
            <div class="meta"><div class="name">${esc(f.name)}</div><div class="cat">every month</div></div>
            <div class="amt" style="color:var(--text)">${inr(f.amount)}</div>
          </div>`).join('') || '<div class="empty" style="padding:8px 0">No fixed costs yet.</div>'}
      </div>
      <button class="btn ghost" data-action="add-fixed">+ Add a fixed cost</button>
      <div class="fixed-maths">
        <div><span>Monthly income</span><span>${inr(state.settings.income)}</span></div>
        <div><span>Fixed costs</span><span>− ${inr(fixedTotal())}</span></div>
        <div class="total"><span>Left for daily spending</span><span>${inr(spendable())}</span></div>
        <div><span>÷ ${daysInMonth(k)} days</span><span class="green">${inr(baseDaily(k))} / day</span></div>
      </div>
    </section>`;
}

function openFixedSheet(f = {}) {
  sheet.innerHTML = `
    <form method="dialog" id="fixed-form" data-id="${f.id || ''}">
      <h2>${f.id ? 'Edit fixed cost' : 'Add a fixed cost'}</h2>
      <div class="field">
        <label class="label" for="f-name">Name</label>
        <input id="f-name" name="name" maxlength="40" placeholder="Rent, SIP, Car EMI…" value="${esc(f.name ?? '')}" required />
      </div>
      <div class="field">
        <label class="label" for="f-amount">Amount per month (₹)</label>
        <input id="f-amount" name="amount" type="number" inputmode="numeric" min="1" step="any" value="${f.amount ?? ''}" required />
      </div>
      <p class="hint">Name it the way your bank alert does (e.g. the landlord's name, or “SIP”), so that payment is tagged Fixed automatically.</p>
      <button class="btn" value="save">${f.id ? 'Save' : 'Add'}</button>
      ${f.id ? '<button class="btn danger" value="delete" formnovalidate>Remove</button>' : ''}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  showSheet();
  if (!f.id) $('#f-name', sheet).focus();
}

function saveFixed(id, data, remove) {
  let fixed = [...(state.settings.fixed || [])];
  if (remove) fixed = fixed.filter((f) => f.id !== id);
  else {
    const amount = Number(data.amount);
    if (!data.name?.trim() || !(amount > 0)) return false;
    const item = { id: id || String(Date.now()), name: data.name.trim(), amount };
    fixed = id ? fixed.map((f) => (f.id === id ? item : f)) : [...fixed, item];
  }
  state.settings.fixed = fixed;
  save({ type: 'settings', settings: { fixed } });
  return true;
}

/* ---------- Money: savings accounts, money received, big spends ---------- */

const sumOf = (list, f = (x) => x.amount) => list.reduce((s, x) => s + Number(f(x) || 0), 0);
const newestFirst = (a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '');
const investValue = (i) => Number(i.current || i.invested || 0);

function renderMoney() {
  const k = todayKey();
  const ms = monthStart(k);
  const accounts = state.settings.accounts || [];
  const savings = sumOf(accounts, (a) => a.balance);
  const invested = sumOf(state.settings.investments || [], investValue);
  const credits = state.txns.filter((t) => t.kind === 'credit').sort(newestFirst);
  const bigs = state.txns.filter((t) => t.kind === 'big').sort(newestFirst);
  const moves = state.txns.filter((t) => t.kind === 'transfer').sort(newestFirst);
  const thisMonth = (t) => t.date >= ms && t.date <= k;
  const inM = sumOf(credits.filter(thisMonth));
  const bigM = sumOf(bigs.filter(thisMonth));
  const dailyM = sumOf(daily().filter(thisMonth));
  const net = inM - bigM - dailyM;
  const monthName = parseKey(k).toLocaleString('en-IN', { month: 'long' });
  const list = (items, empty) => items.length
    ? `<div class="txn-list">${items.map((t) => txnHtml(t, { withDate: true })).join('')}</div>`
    : `<div class="empty" style="padding:12px 0">${empty}</div>`;

  view.innerHTML = `
    <section class="card">
      <div class="label">Savings + investments</div>
      <div class="big" style="--state:var(--text);text-shadow:none">${inr(savings + invested)}</div>
      <div class="sub">${inr(savings)} in savings · ${inr(invested)} invested</div>
    </section>

    <div class="label section-title">Savings accounts</div>
    <section class="card">
      <div class="txn-list" style="margin-bottom:12px">
        ${accounts.map((a) => `
          <div class="txn editable" data-account="${a.id}" role="button" tabindex="0" aria-label="Update ${esc(a.name)}">
            <div class="ico">${svgIcon('bank')}</div>
            <div class="meta"><div class="name">${esc(a.name)}</div><div class="cat">${a.digits ? `XX${esc(a.digits)} · auto-updates` : `set ${shortDate(a.asOf)} · tap to add last digits`}</div></div>
            <div class="amt plain">${inr(a.balance)}</div>
          </div>`).join('') || '<div class="empty" style="padding:8px 0">Add each bank account and its balance, then update it whenever you check your bank app.</div>'}
      </div>
      <button class="btn ghost" data-action="add-account">+ Add an account</button>
    </section>

    <div class="label section-title">${monthName} so far</div>
    <section class="card">
      <div class="fixed-maths" style="margin:0;border:0;padding:0">
        <div><span>Money received</span><span class="in">+ ${inr(inM)}</span></div>
        <div><span>Daily spends</span><span>− ${inr(dailyM)}</span></div>
        <div><span>Big spends</span><span>− ${inr(bigM)}</span></div>
        ${inM ? `<div class="total"><span>${net >= 0 ? 'Saved' : 'Spent more than came in'}</span><span class="${net >= 0 ? 'green' : 'red'}">${net < 0 ? '−' : ''}${inr(Math.abs(net))}</span></div>`
          : `<div class="total"><span>Total spent</span><span>${inr(dailyM + bigM)}</span></div>`}
      </div>
    </section>

    <div class="row add-pair">
      <button class="btn" data-action="add-credit">+ Money in</button>
      <button class="btn ghost" data-action="add-big">+ Big spend</button>
    </div>

    <div class="label section-title">Money received</div>
    ${list(credits, 'Salary, bonus, refunds… add them with “+ Money in”.')}

    <div class="label section-title">Big spends</div>
    ${list(bigs, 'Card bills, a new phone, flights… they stay out of your daily budget.')}

    ${moves.length ? `
      <div class="label section-title">Between your own accounts</div>
      ${list(moves, '')}` : ''}
  `;
}

function openAccountSheet(a = {}) {
  sheet.innerHTML = `
    <form method="dialog" id="account-form" data-id="${a.id || ''}">
      <h2>${a.id ? 'Update balance' : 'Add a savings account'}</h2>
      <div class="field">
        <label class="label" for="ac-name">Account</label>
        <input id="ac-name" name="name" maxlength="40" placeholder="HDFC savings, Axis…" value="${esc(a.name ?? '')}" required />
      </div>
      <div class="field">
        <label class="label" for="ac-balance">Balance now (₹)</label>
        <input id="ac-balance" name="balance" type="number" inputmode="decimal" min="0" step="any" value="${a.balance ?? ''}" required />
      </div>
      <div class="field">
        <label class="label" for="ac-digits">Last digits of the account number</label>
        <input id="ac-digits" name="digits" inputmode="numeric" maxlength="6" pattern="\\d{3,6}" placeholder="e.g. 7788 (from XX7788 in alerts)" value="${esc(a.digits ?? '')}" />
      </div>
      <p class="hint">Just the number from your bank app. Nothing connects to your bank. With the last digits, every debit or credit alert for this account moves its balance.</p>
      <button class="btn" value="save">Save</button>
      ${a.id ? '<button class="btn danger" value="delete" formnovalidate>Remove account</button>' : ''}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  showSheet();
  $(a.id ? '#ac-balance' : '#ac-name', sheet).focus();
}

function accountFrom(data) {
  const balance = Number(data.balance);
  if (!data.name?.trim() || !(balance >= 0) || data.balance === '') return null;
  const digits = String(data.digits || '').replace(/\D/g, '').slice(-6);
  return { name: data.name.trim(), balance, asOf: todayKey(), ...(digits.length >= 3 ? { digits } : {}) };
}

/* ---------- Investments ---------- */

function renderInvest() {
  const inv = state.settings.investments || [];
  const invested = sumOf(inv, (i) => i.invested);
  const current = sumOf(inv, investValue);
  const gain = current - invested;
  const pct = invested ? (gain / invested) * 100 : 0;
  const byType = {};
  for (const i of inv) byType[i.type] = (byType[i.type] || 0) + investValue(i);
  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const sorted = [...inv].sort((a, b) => INVEST_TYPES.indexOf(a.type) - INVEST_TYPES.indexOf(b.type) || investValue(b) - investValue(a));
  const gainText = (g, base) => `${g >= 0 ? '+' : '−'}${inr(Math.abs(g))}${base ? ` (${g >= 0 ? '+' : '−'}${Math.abs((g / base) * 100).toFixed(1)}%)` : ''}`;

  view.innerHTML = `
    <section class="card">
      <div class="label">Investments now worth</div>
      <div class="big" style="--state:var(--text);text-shadow:none">${inr(current)}</div>
      <div class="sub">${inv.length ? `Invested ${inr(invested)} · <span class="${gain >= 0 ? 'green' : 'red'}">${gainText(gain, invested)}</span>` : 'Stocks, mutual funds, FDs, bonds, PF… note them here to see everything in one place.'}</div>
    </section>

    ${types.length > 1 ? `
      <section class="card">
        <div class="label">By type</div>
        ${types.map(([t, v]) => `
          <div class="cat-row">
            <div class="top"><span>${esc(t)}</span><span>${inr(v)} · ${Math.round((v / current) * 100)}%</span></div>
            <div class="bar"><span style="width:${(v / types[0][1]) * 100}%"></span></div>
          </div>`).join('')}
      </section>` : ''}

    <button class="btn" data-action="add-invest" style="margin-top:14px">+ Add an investment</button>

    <div class="label section-title">Your investments</div>
    <div class="txn-list">
      ${sorted.map((i) => {
        const g = investValue(i) - Number(i.invested || 0);
        const bits = [i.type, i.rate && `${i.rate}%`, i.maturity ? `matures ${shortDate(i.maturity)}` : i.date && `since ${shortDate(i.date)}`].filter(Boolean);
        return `
          <div class="txn editable" data-invest="${i.id}" role="button" tabindex="0" aria-label="Edit ${esc(i.name)}">
            <div class="ico">${svgIcon('growth')}</div>
            <div class="meta">
              <div class="name">${esc(i.name)}</div>
              <div class="cat">${esc(bits.join(' · '))}</div>
              ${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}
            </div>
            <div class="amt plain">${inr(investValue(i))}${i.current && g ? `<small class="${g >= 0 ? 'green' : 'red'}">${gainText(g)}</small>` : ''}</div>
          </div>`;
      }).join('') || '<div class="empty">Nothing yet.</div>'}
    </div>
  `;
}

function openInvestSheet(i = {}) {
  const type = i.type || 'Mutual fund';
  sheet.innerHTML = `
    <form method="dialog" id="invest-form" data-id="${i.id || ''}">
      <h2>${i.id ? 'Edit investment' : 'Add an investment'}</h2>
      <div class="row">
        <div class="field">
          <label class="label" for="i-type">Type</label>
          <select id="i-type" name="type">${INVEST_TYPES.map((t) => `<option ${t === type ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label class="label" for="i-date">Started</label>
          <input id="i-date" name="date" type="date" value="${i.date || todayKey()}" />
        </div>
      </div>
      <div class="field">
        <label class="label" for="i-name">Name</label>
        <input id="i-name" name="name" maxlength="40" placeholder="Parag Parikh Flexi Cap, Infosys, SBI FD…" value="${esc(i.name ?? '')}" required />
      </div>
      <div class="row">
        <div class="field">
          <label class="label" for="i-invested">Invested (₹)</label>
          <input id="i-invested" name="invested" type="number" inputmode="decimal" min="1" step="any" value="${i.invested ?? ''}" required />
        </div>
        <div class="field">
          <label class="label" for="i-current">Worth now (₹)</label>
          <input id="i-current" name="current" type="number" inputmode="decimal" min="0" step="any" placeholder="Same" value="${i.current ?? ''}" />
        </div>
      </div>
      ${DATED_TYPES.includes(type) ? `
      <div class="row">
        <div class="field">
          <label class="label" for="i-rate">Interest (% a year)</label>
          <input id="i-rate" name="rate" type="number" inputmode="decimal" min="0" max="100" step="any" value="${i.rate ?? ''}" />
        </div>
        <div class="field">
          <label class="label" for="i-maturity">Matures on</label>
          <input id="i-maturity" name="maturity" type="date" value="${i.maturity || ''}" />
        </div>
      </div>` : ''}
      <div class="field">
        <label class="label" for="i-note">Note</label>
        <textarea id="i-note" name="note" maxlength="200" rows="2" placeholder="Optional, e.g. ₹5,000 SIP on the 5th">${esc(i.note ?? '')}</textarea>
      </div>
      <p class="hint">Update “Worth now” whenever you check the app or statement, to see your gain.</p>
      <button class="btn" value="save">Save</button>
      ${i.id ? '<button class="btn danger" value="delete" formnovalidate>Remove investment</button>' : ''}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  // FDs, bonds, PF and NPS also ask for a rate and maturity date.
  $('#i-type', sheet).addEventListener('change', (e) => {
    openInvestSheet({ ...i, ...Object.fromEntries(new FormData($('form', sheet))), type: e.target.value });
  });
  showSheet();
  if (!i.id && !i.name) $('#i-name', sheet).focus();
}

function investmentFrom(data) {
  const invested = Number(data.invested);
  if (!data.name?.trim() || !(invested > 0)) return null;
  const opt = (v) => (v === '' || v == null ? undefined : Number(v));
  return {
    type: data.type, name: data.name.trim(), invested, date: data.date || todayKey(),
    current: opt(data.current), rate: DATED_TYPES.includes(data.type) ? opt(data.rate) : undefined,
    maturity: DATED_TYPES.includes(data.type) && data.maturity ? data.maturity : undefined,
    note: (data.note || '').trim() || undefined,
  };
}

/** Add, edit or remove one entry of a settings list (accounts, investments), synced like fixed costs. */
function saveListItem(key, id, remove, build) {
  let list = [...(state.settings[key] || [])];
  if (remove) list = list.filter((x) => x.id !== id);
  else {
    const item = build();
    if (!item) return false;
    const full = JSON.parse(JSON.stringify({ id: id || String(Date.now()), ...item })); // drops undefined
    list = id ? list.map((x) => (x.id === id ? full : x)) : [...list, full];
  }
  state.settings[key] = list;
  save({ type: 'settings', settings: { [key]: list } });
  return true;
}

function renderSettings() {
  const s = state.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  view.innerHTML = `
    <section class="card">
      <form id="settings-form">
        <div class="field">
          <label class="label" for="income">Monthly income (₹)</label>
          <input id="income" name="income" type="number" inputmode="numeric" min="1" value="${s.income}" required />
        </div>
        <label class="toggle">
          <span>Roll over savings<small>Spend less today → bigger budget tomorrow (and vice-versa).</small></span>
          <input type="checkbox" name="rollover" ${s.rollover ? 'checked' : ''} />
        </label>
        <label class="toggle">
          <span>Nightly summary<small>${perm === 'denied' ? 'Notifications are blocked in your browser settings.' : perm === 'unsupported' ? 'This browser has no notifications — the summary still shows on the Today tab.' : '“Good day / bad day” notification at the time below.'}</small></span>
          <input type="checkbox" name="notify" ${s.notify && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' || perm === 'denied' ? 'disabled' : ''} />
        </label>
        <div class="field">
          <label class="label" for="reminderTime">Summary time</label>
          <input id="reminderTime" name="reminderTime" type="time" value="${s.reminderTime}" />
        </div>
        <div class="field">
          <label class="label" for="myName">Your name, as banks show it</label>
          <input id="myName" name="myName" type="text" autocomplete="name" placeholder="e.g. Priya Sharma" value="${esc(s.myName || '')}" />
          <small class="hint">Money you send to yourself (e.g. Axis → HDFC) isn't counted as spending.</small>
        </div>
        <button class="btn" type="submit">Save</button>
      </form>
    </section>

    ${fixedSection()}

    ${serverMode ? serverGuide() : ''}

    <div class="label section-title">${serverMode ? 'Older method: open the app per alert' : 'iPhone: auto-add from SMS &amp; email'}</div>
    <section class="card guide">
      <p class="sub" style="margin-top:0">No bank login needed. An iPhone Shortcuts automation passes each “debited” alert to this app, which reads the amount on your phone. The message text is never sent to a server.</p>
      <div class="field">
        <label class="label" for="sms-link">Link to use in the shortcut</label>
        <div class="row" style="gap:8px">
          <input id="sms-link" readonly value="${esc(location.origin + location.pathname)}#sms=" />
          <button class="btn ghost" style="flex:none;width:auto;padding:0 16px" data-action="copy-link">Copy</button>
        </div>
      </div>
      <ol>
        <li>Open <b>Shortcuts</b> → <b>Automation</b> → <b>+</b> → <b>Message</b>.</li>
        <li><b>Message Contains</b>: <code>debited</code> → choose <b>Run Immediately</b> → Next → <b>New Blank Automation</b>.</li>
        <li>Banks word alerts differently (HDFC UPI says <code>Sent Rs.</code>, cards say <code>spent</code>), so repeat steps 1–4 for each wording your bank uses: <code>debited</code>, <code>Sent Rs</code>, <code>spent</code>.</li>
        <li>Add <b>URL Encode</b>, input = <b>Shortcut Input</b> (tap it and pick the message <b>Content</b>).</li>
        <li>Add <b>Open URLs</b> with the link above, then insert the <b>URL Encoded Text</b> variable right after <code>#sms=</code>.</li>
        <li>For bank emails do the same with the <b>Email</b> trigger (Subject contains <code>debited</code>, or Sender is your bank's alert address), picking the email's <b>Body</b>.</li>
        <li>Nightly summary: add a <b>Time of Day</b> automation (e.g. 9 PM) that just opens this app's link. The good/bad-day card is waiting on the Today tab.</li>
      </ol>
      <p class="sub"><b>Older alerts:</b> shortcuts only see new messages. For ones you already got, copy them from Messages / Mail, then use <b>Paste SMS</b> on the Today tab and paste them all at once.</p>
      ${serverMode ? '' : `<p class="sub">Open this app in <b>Safari</b> (bookmark it) rather than “Add to Home Screen”. iOS keeps home-screen apps' data separate, and shortcuts always open Safari. Each message is counted once, even if the link opens twice.</p>`}
      <button class="btn ghost" data-action="test-import">Try it with a sample message</button>
    </section>

    <div class="label section-title">Data</div>
    <section class="card">
      <button class="btn ghost" data-action="test-notify">Send me tonight's summary now</button>
      <button class="btn ghost" data-action="export">Export CSV</button>
      <button class="btn ghost" data-action="demo">Load demo data</button>
      <button class="btn danger" data-action="reset">Erase everything</button>
    </section>
    <p class="sub" style="text-align:center">${serverMode
      ? 'Your data is stored on your PC (data.json) and shared by every device that opens this app.'
      : 'Everything stays on this device (localStorage).'}</p>
  `;
}

function serverGuide() {
  const base = location.origin;
  const copy = (id, value) => `
    <div class="row" style="gap:8px;margin-bottom:10px">
      <input id="${id}" readonly value="${esc(value)}" />
      <button class="btn ghost" style="flex:none;width:auto;padding:0 16px" data-action="copy" data-copy="${id}">Copy</button>
    </div>`;
  const hosted = location.protocol === 'https:';
  const where = hosted ? 'the server' : 'your PC';
  const keyRows = appKey ? `
      <label class="label">App key (send it as a header)</label>
      ${copy('key-copy', appKey)}` : '';
  const keyStep = appKey
    ? ` Under <b>Headers</b>, add <code>X-Budget-Key</code> with the app key above.` : '';
  return `
    <div class="label section-title">Install as an app</div>
    <section class="card guide">
      <p class="sub" style="margin-top:0"><b>iPhone:</b> open <b>${esc(base)}</b> in <b>Safari</b> → <b>Share</b> → <b>Add to Home Screen</b>.</p>
      <p class="sub"><b>Android:</b> open it in <b>Chrome</b> → <b>⋮</b> → <b>Install app</b> (or <b>Add to Home screen</b>)${hosted ? '' : '. Android only offers a real install over https, so host the app first (README)'}.</p>
      <p class="sub">Your data lives on ${where}, so every device that opens the app shows the same spends.</p>
    </section>

    <div class="label section-title">Auto-add bank alerts in the background</div>
    <section class="card guide">
      <p class="sub" style="margin-top:0">Each bank alert is sent to ${where}, which reads it and saves the spend. You get a notification and nothing opens.</p>
      <label class="label">Alert URL</label>
      ${copy('sms-api', base + '/api/sms')}
      ${keyRows}
      <p class="sub"><b>iPhone (Shortcuts)</b></p>
      <ol>
        <li><b>Automation</b> → <b>+</b> → <b>Message</b> → Message Contains <code>Sent Rs</code> → <b>Run Immediately</b> → <b>New Blank Automation</b>.</li>
        <li><b>Get Contents of URL</b> with the alert URL. Tap <b>›</b>: Method <b>POST</b>, Request Body <b>JSON</b>, a <b>Text</b> field with key <code>text</code> = <b>Shortcut Input › Content</b>.${keyStep}</li>
        <li><b>Show Notification</b> with <b>Contents of URL</b>.</li>
        <li>Repeat for <code>debited</code> and <code>spent</code>. For bank emails, use the <b>Email</b> trigger and the email's <b>Body</b>.</li>
      </ol>
      <p class="sub"><b>Android (MacroDroid, free)</b></p>
      <ol>
        <li>Trigger: <b>SMS Received</b> → Any number → Message <b>contains</b> <code>Sent Rs</code>.</li>
        <li>Action: <b>HTTP Request</b> → POST to the alert URL, body type <code>text/plain</code>, body <code>[sms_message]</code>.${appKey ? ' Add header <code>X-Budget-Key</code> with the app key.' : ''} Save the response to a text variable.</li>
        <li>Action: <b>Display Notification</b> with that variable as the text.</li>
        <li>Repeat for <code>debited</code> and <code>spent</code>.</li>
      </ol>
      <label class="label">Nightly summary URL</label>
      ${copy('summary-api', base + '/api/summary')}
      <p class="sub">At 9 PM (Shortcuts: <b>Time of Day</b>; MacroDroid: <b>Day/Time</b> trigger), fetch this URL with a GET${appKey ? ' and the same header' : ''}, then show the response as a notification.</p>
      <p class="sub">${hosted
        ? "The server is always on, so this works anywhere you have mobile data or Wi-Fi."
        : "Your PC must be on with <code>start-server.cmd</code> running, and the phone on the same Wi-Fi. Alerts that arrive while you're away fail; paste those in later with <b>Paste SMS</b>."}</p>
    </section>`;
}

function renderKeyPrompt() {
  $('#fab').style.display = 'none';
  view.innerHTML = `
    <section class="card">
      <div class="label">Locked</div>
      <h2 style="font-size:24px;font-weight:900;margin:8px 0 6px">Enter your app key</h2>
      <p class="sub" style="margin-top:0">This app is protected so only you can see your spends. The key is the <code>BUDGET_KEY</code> you set when hosting it. You only need to enter it once on each device.</p>
      <form id="key-form" style="margin-top:16px">
        <div class="field">
          <input name="key" type="password" autocomplete="current-password" placeholder="App key" required autofocus />
        </div>
        <button class="btn" type="submit">Unlock</button>
      </form>
    </section>`;
}

function renderOnboarding() {
  $('#fab').style.display = 'none';
  view.innerHTML = `
    <section class="card">
      <div class="label">Step 1</div>
      <h2 style="font-size:24px;font-weight:900;margin:8px 0 6px">How much comes in every month?</h2>
      <p class="sub" style="margin-top:0">We split it into a daily allowance. ₹1,00,000 ÷ 30 ≈ ₹3,333 a day — every single day.</p>
      <form id="onboard-form" style="margin-top:16px">
        <div class="field">
          <input name="income" type="number" inputmode="numeric" min="1" placeholder="e.g. 100000" required autofocus />
        </div>
        <button class="btn" type="submit">Show my daily budget</button>
      </form>
    </section>
  `;
}

/* ================= Sheets (dialogs) ================= */

const sheet = $('#sheet');

const showSheet = () => sheet.open || sheet.showModal();

const KINDS = {
  '':     { tab: 'Daily spend', add: 'Add a spend',          edit: 'Edit spend',          what: 'Where', place: 'Coffee, Blinkit, Uber…',          cats: Object.keys(CATEGORIES), cat: 'Food & drink', noun: 'spend' },
  big:    { tab: 'Big spend',   add: 'Add a big spend',      edit: 'Edit big spend',      what: 'What',  place: 'Credit card bill, laptop, flights…', cats: BIG_CATEGORIES,         cat: 'Card bill',    noun: 'big spend',
            hint: "Kept out of your daily budget, so one large payment doesn't wreck the day." },
  credit: { tab: 'Money in',    add: 'Add money received',   edit: 'Edit money received', what: 'From',  place: 'Salary, bonus, refund…',             cats: CREDIT_SOURCES,         cat: 'Salary',       noun: 'entry',
            hint: "A record of what came in. Your daily budget still comes from your monthly income in Settings." },
  transfer: { tab: 'Transfer',  add: 'Add a transfer',       edit: 'Edit transfer',       what: 'Between', place: 'Axis → HDFC',                    cats: ['Own account'],        cat: 'Own account',  noun: 'transfer',
            hint: 'Money moved between your own accounts. Not counted as spending or income.' },
};

/**
 * Add form, or with `prefill.id` the edit form. `prefill.kind` picks daily spend, big spend or money in.
 * `day` returns to that day's list afterwards.
 */
function openAddSheet(prefill = {}, { day } = {}) {
  const editing = !!prefill.id;
  const kind = prefill.kind || '';
  const K = KINDS[kind];
  const cat = K.cats.includes(prefill.category) ? prefill.category : K.cat;
  sheet.innerHTML = `
    <form method="dialog" id="${editing ? 'edit-form' : 'add-form'}" data-id="${prefill.id || ''}" data-day="${day || ''}">
      <h2>${editing ? K.edit : K.add}</h2>
      <input type="hidden" name="kind" value="${kind}" />
      <div class="segmented kind-switch" role="radiogroup" aria-label="Type">
        ${Object.entries(KINDS).filter(([k]) => k !== 'transfer' || kind === 'transfer').map(([k, v]) => `<button type="button" role="radio" aria-checked="${k === kind}" data-kind="${k}" class="${k === kind ? 'on' : ''}">${k ? v.tab : 'Daily'}</button>`).join('')}
      </div>
      ${K.hint ? `<p class="hint">${K.hint}</p>` : ''}
      <div class="field">
        <label class="label" for="a-amount">Amount (₹)</label>
        <input id="a-amount" name="amount" type="number" inputmode="decimal" min="1" step="any" value="${prefill.amount ?? ''}" required />
      </div>
      <div class="field">
        <label class="label" for="a-name">${K.what}</label>
        <input id="a-name" name="name" maxlength="40" placeholder="${K.place}" value="${esc(prefill.name ?? '')}" required />
      </div>
      <div class="row">
        <div class="field">
          <label class="label" for="a-cat">${kind === 'credit' ? 'Type' : 'Category'}</label>
          <select id="a-cat" name="category">
            ${K.cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        ${kind === 'credit' || kind === 'transfer' ? '' : `
        <div class="field">
          <label class="label" for="a-method">Paid via</label>
          <select id="a-method" name="method">
            ${['UPI', 'Card', 'Cash', 'Net banking'].map((m) => `<option ${m === (prefill.method || 'UPI') ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>`}
      </div>
      <div class="field">
        <label class="label" for="a-date">Date</label>
        <input id="a-date" name="date" type="date" value="${prefill.date || todayKey()}" max="${todayKey()}" />
      </div>
      <div class="field">
        <label class="label" for="a-note">Note</label>
        <textarea id="a-note" name="note" maxlength="200" rows="2" placeholder="Optional, e.g. groceries for the week">${esc(prefill.note ?? '')}</textarea>
      </div>
      <button class="btn" value="save">${editing ? 'Save' : 'Add'}</button>
      ${editing ? `<button class="btn danger" value="delete" formnovalidate>Delete ${K.noun}</button>` : ''}
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  const form = $('form', sheet);
  const name = $('#a-name', sheet);
  const select = $('#a-cat', sheet);
  // Switching type redraws the form, keeping what was typed.
  const switchTo = (k, extra = {}) => {
    const data = Object.fromEntries(new FormData(form));
    openAddSheet({ ...prefill, ...data, ...extra, kind: k }, { day });
    const n = $('#a-name', sheet);
    n.focus();
    n.setSelectionRange(n.value.length, n.value.length);
  };
  form.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => switchTo(b.dataset.kind)));
  name.addEventListener('input', () => {
    // "Credit card bill" typed as a daily spend: that belongs with the big spends.
    if (!kind && CARD_BILL.test(name.value)) return switchTo('big', { category: 'Card bill' });
    if (kind) return;
    const g = guessCategory(name.value);
    if (g !== 'Other') select.value = g;
  });
  showSheet();
  if (!editing && !prefill.name) (prefill.amount ? name : $('#a-amount', sheet)).focus();
}

/** Everything spent on one day, from a tap on the Month calendar. */
function openDaySheet(k) {
  const txns = daily().filter((t) => t.date === k).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  const spent = spentOn(k);
  const budget = budgetFor(k);
  const verdict = k === todayKey() ? 'so far today' : spent <= budget ? '· good day 💚' : '· over budget 😬';
  sheet.innerHTML = `
    <form method="dialog" id="day-form" data-day="${k}">
      <h2>${parseKey(k).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      <p class="hint">Spent <b style="color:var(--text)">${inr(spent)}</b> of ${inr(budget)} ${verdict}</p>
      <div class="txn-list day-list">
        ${txns.length ? txns.map(txnHtml).join('') : '<div class="empty">No spends on this day.</div>'}
      </div>
      <button class="btn" type="button" data-add-day style="margin-top:16px">Add a spend on this day</button>
      <button class="btn ghost" value="cancel" formnovalidate>Close</button>
    </form>`;
  showSheet();
}

sheet.addEventListener('click', (e) => {
  const day = sheet.querySelector('#day-form')?.dataset.day;
  if (!day) return;
  const del = e.target.closest('[data-del]');
  if (del) {
    deleteTxn(del.dataset.del);
    render();
    return openDaySheet(day);
  }
  const row = e.target.closest('[data-edit]');
  if (row) return openAddSheet(state.txns.find((t) => t.id === row.dataset.edit), { day });
  if (e.target.closest('[data-add-day]')) openAddSheet({ date: day }, { day });
});

function openSmsSheet() {
  sheet.innerHTML = `
    <form method="dialog" id="sms-form">
      <h2>Paste bank / UPI alerts</h2>
      <p class="hint">Reads “Sent Rs” (HDFC UPI), “debited”, “spent”, “paid” and “credited” alerts. Paste one or many SMS or emails, with a blank line between emails. Each spend goes on the date written in the message, and anything already added is skipped.</p>
      <div class="field">
        <textarea name="sms" placeholder="Rs.250.00 debited from A/c XX1234 to VPA starbucks@hdfcbank on 02-11-26. UPI Ref 6312…" required></textarea>
      </div>
      <button class="btn" value="parse">Add spends</button>
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  showSheet();
  const box = sheet.querySelector('textarea');
  box.focus();
  // On the https (hosted) app, fill in a copied bank alert straight away.
  navigator.clipboard?.readText?.().then((t) => {
    if (!box.value && parseSms(t)) box.value = t;
  }).catch(() => {});
}

sheet.addEventListener('close', () => {
  const form = sheet.querySelector('form');
  // An add/edit opened from a day's list goes back to that list when done.
  const backToDay = form && form.id !== 'day-form' && form.dataset.day;
  const value = sheet.returnValue;
  sheet.returnValue = '';
  if (form && value && value !== 'cancel') handleSheet(form, value);
  if (backToDay) openDaySheet(backToDay);
});

function handleSheet(form, value) {
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'add-form') {
    if (addTxn(data)) {
      const sign = data.kind === 'credit' ? '+' : '−';
      toast(`${sign}${inr(Number(data.amount))} · ${data.name}${data.kind === 'big' ? ' · big spend, daily budget unchanged' : ''}`);
      render();
    }
  } else if (form.id === 'account-form') {
    const removed = value === 'delete';
    if (saveListItem('accounts', form.dataset.id, removed, () => accountFrom(data))) toast(removed ? 'Account removed' : 'Balance saved');
    render();
  } else if (form.id === 'invest-form') {
    const removed = value === 'delete';
    if (saveListItem('investments', form.dataset.id, removed, () => investmentFrom(data))) toast(removed ? 'Investment removed' : 'Investment saved');
    render();
  } else if (form.id === 'fixed-form') {
    const removed = value === 'delete';
    if (saveFixed(form.dataset.id, data, removed)) toast(removed ? 'Fixed cost removed' : `Saved · daily budget now ${inr(budgetFor(todayKey()))}`);
    render();
  } else if (form.id === 'edit-form') {
    if (value === 'delete') { deleteTxn(form.dataset.id); toast('Spend deleted'); }
    else if (updateTxn(form.dataset.id, data)) toast('Saved');
    render();
  } else if (form.id === 'sms-form') {
    const results = splitMessages(data.sms).map(importMessage);
    const added = results.filter((r) => r && !r.dup && !r.transfer);
    const spends = added.filter((p) => p.dir === 'out');
    const credits = added.filter((p) => p.dir === 'in');
    const dups = results.filter((r) => r?.dup).map((r) => r.dup);
    // Both sides of one transfer share a ref: list it once.
    const moves = results.filter((r) => r?.transfer).map((r) => r.transfer)
      .filter((p, i, all) => !p.ref || all.findIndex((q) => q.ref === p.ref) === i);
    const parts = [];
    if (spends.length) parts.push(`Added ${spends.length} spend${spends.length > 1 ? 's' : ''} · ${inr(sumOf(spends))}`);
    if (credits.length) parts.push(`Money received · +${inr(sumOf(credits))}`);
    if (moves.length) parts.push(`Moved between your own accounts, not counted: ${moves.map((p) => inr(p.amount)).join(', ')}`);
    // Name the duplicates, so a stale clipboard (the previous message pasted again) is easy to spot.
    if (dups.length) parts.push(`Already added: ${dups.map((p) => `${p.name} ${inr(p.amount)} (${shortDate(p.date)})`).join(', ')}`);
    if (!parts.length) parts.push("No debit or credit found in that. Paste the whole message, including the “Sent Rs” / “debited” / “credited” line.");
    toast(parts.join(' · '), dups.length || moves.length || !added.length ? 6000 : undefined);
    render();
  }
}

/* ================= Notifications ================= */

let swReg = null;
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then((r) => (swReg = r)).catch(() => {});
}

async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return toast(`${title} — ${body}`);
  const opts = { body, icon: 'icon.svg', badge: 'icon.svg', tag: 'daily-summary' };
  if (swReg) swReg.showNotification(title, opts);
  else new Notification(title, opts);
}

function checkNightly() {
  const s = state.settings;
  if (!s.income || !s.notify) return;
  const k = todayKey();
  if (state.lastSummary === k) return;
  const [h, m] = s.reminderTime.split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  const sum = summaryFor(k);
  notify(sum.title, sum.body);
  state.lastSummary = k;
  save();
}
setInterval(checkNightly, 30_000);

/* ================= Auto-import (iPhone Shortcuts) ================= */

/**
 * An iOS Shortcuts automation ("When I get a message/email containing 'debited'")
 * opens  <app>/#sms=<url-encoded text>.  The text lives in the URL fragment, which
 * browsers never send to the server — it is parsed here, on the phone.
 */
function fingerprint(s) {
  let h = 5381;
  for (const c of s.replace(/\s+/g, ' ').trim()) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return String(h >>> 0);
}

function importFromHash() {
  const m = location.hash.match(/^#sms=([\s\S]*)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let text;
  try { text = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { text = m[1]; }
  if (!state.settings.income) return toast('Set your monthly income first, then the message will be counted next time.');
  const p = importMessage(text);
  if (p?.dup) return toast(`Already added: ${p.dup.name} ${inr(p.dup.amount)} (${shortDate(p.dup.date)})`);
  if (p?.transfer) return toast(`Not counted: ${inr(p.transfer.amount)} moved between your own accounts`);
  if (!p) return toast("No debit or credit found in that message — nothing added");
  tab = p.dir === 'in' ? 'money' : 'today';
  render();
  toast(`Auto-added ${p.dir === 'in' ? '+' : '−'}${inr(p.amount)} · ${p.name}`);
}

window.addEventListener('hashchange', importFromHash);

/* ================= Misc ================= */

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function exportCsv() {
  const kinds = { '': 'daily spend', big: 'big spend', credit: 'money in' };
  const rows = [['date', 'time', 'type', 'name', 'category', 'method', 'amount']]
    .concat(state.txns.map((t) => [t.date, t.time, kinds[t.kind || ''], t.name, t.category, t.method, t.kind === 'credit' ? t.amount : -t.amount]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `expenses-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadDemo() {
  const k = todayKey();
  const day = parseKey(k).getDate();
  const pool = [
    ['Coffee', 'Food & drink', 250], ['Blinkit', 'Groceries', 600], ['Zepto', 'Groceries', 400],
    ['Swiggy', 'Food & drink', 520], ['Uber', 'Transport', 340], ['Amazon', 'Shopping', 1899],
    ['Chai', 'Food & drink', 40], ['Bookmyshow', 'Entertainment', 700], ['Apollo Pharmacy', 'Health', 320],
  ];
  state.settings.income = state.settings.income || 100000;
  state.settings.startDate = addDays(k, -40);
  state.txns = [];
  recordOps = false; // sent as one 'replace' below instead of ~100 adds
  const rand = (n) => Math.floor(Math.random() * n);
  for (let i = 40; i >= 1; i--) {
    const d = addDays(k, -i);
    const n = 1 + rand(4);
    for (let j = 0; j < n; j++) {
      const [name, category, amount] = pool[rand(pool.length)];
      addTxn({ name, category, amount: Math.round(amount * (0.8 + Math.random() * 0.5)), date: d });
    }
    if (parseKey(d).getDate() === 5) {
      addTxn({ name: 'Netflix', category: 'Subscriptions', amount: 649, method: 'Card', date: d });
      addTxn({ name: 'Spotify', category: 'Subscriptions', amount: 119, method: 'UPI', date: d });
    }
    if (parseKey(d).getDate() === 1) addTxn({ name: 'Rent', category: 'Bills', amount: 25000, method: 'Net banking', date: d });
  }
  if (day > 1) addTxn({ name: 'Coffee', category: 'Food & drink', amount: 250 });
  recordOps = true;
  save({ type: 'replace', state: shareable(state) });
}

/* ================= Events ================= */

document.querySelector('.app').addEventListener('click', (e) => {
  const b = e.target.closest('.tabs [data-tab], .topbar [data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  render();
  window.scrollTo({ top: 0 });
});

$('#fab').addEventListener('click', () => openAddSheet());

view.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  const row = e.target.closest('[data-edit]');
  if (row && !t) return openAddSheet(state.txns.find((x) => x.id === row.dataset.edit));
  const fixedRow = e.target.closest('[data-fixed]');
  if (fixedRow) return openFixedSheet((state.settings.fixed || []).find((f) => f.id === fixedRow.dataset.fixed));
  const acct = e.target.closest('[data-account]');
  if (acct) return openAccountSheet((state.settings.accounts || []).find((a) => a.id === acct.dataset.account));
  const inv = e.target.closest('[data-invest]');
  if (inv) return openInvestSheet((state.settings.investments || []).find((i) => i.id === inv.dataset.invest));
  const cell = e.target.closest('[data-day]');
  if (cell) return openDaySheet(cell.dataset.day);
  if (!t) return;
  if (t.dataset.quick) {
    const q = QUICK_ADD[t.dataset.quick];
    addTxn(q);
    toast(`−${inr(q.amount)} · ${q.name}`);
    render();
  } else if (t.dataset.del) {
    deleteTxn(t.dataset.del);
    render();
  } else if (t.dataset.range) {
    insightRange = t.dataset.range;
    render();
  } else if (t.dataset.trend) {
    trendMode = t.dataset.trend;
    render();
  } else if (t.dataset.goto) {
    tab = t.dataset.goto;
    render();
    window.scrollTo({ top: 0 });
  } else if (t.dataset.action === 'sms') openSmsSheet();
  else if (t.dataset.action === 'export') exportCsv();
  else if (t.dataset.action === 'add-fixed') openFixedSheet();
  else if (t.dataset.action === 'add-account') openAccountSheet();
  else if (t.dataset.action === 'add-invest') openInvestSheet();
  else if (t.dataset.action === 'add-credit') openAddSheet({ kind: 'credit' });
  else if (t.dataset.action === 'add-big') openAddSheet({ kind: 'big' });
  else if (t.dataset.action === 'copy-link' || t.dataset.action === 'copy') {
    const input = $('#' + (t.dataset.copy || 'sms-link'));
    try { await navigator.clipboard.writeText(input.value); toast('Copied'); } catch {
      // Plain http on the Wi-Fi has no clipboard API; fall back to the old copy command.
      input.select();
      input.setSelectionRange(0, 9999);
      toast(document.execCommand('copy') ? 'Copied' : 'Select the text and copy it');
    }
  } else if (t.dataset.action === 'test-import') {
    const sample = `Rs.250.00 debited from A/c XX1234 on ${todayKey()} to VPA starbucks@hdfcbank. UPI Ref ${Date.now() % 1e9}. Avl Bal Rs.42,310.00`;
    location.hash = 'sms=' + encodeURIComponent(sample);
  }
  else if (t.dataset.action === 'demo') {
    if (!state.txns.length || confirm('Replace your transactions with ~40 days of demo data?')) { loadDemo(); toast('Demo data loaded'); tab = 'today'; render(); }
  } else if (t.dataset.action === 'reset') {
    if (confirm(serverMode ? 'Erase all settings and transactions (on your PC and every device)?' : 'Erase all settings and transactions on this device?')) {
      localStorage.removeItem(STORE_KEY);
      state = load();
      save({ type: 'replace', state: shareable(state) });
      tab = 'today';
      render();
    }
  } else if (t.dataset.action === 'test-notify') {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const s = summaryFor(todayKey());
    notify(s.title, s.body);
  }
});

view.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (e.target.id === 'key-form') {
    appKey = String(data.key || '').trim();
    try { localStorage.setItem(APPKEY_KEY, appKey); } catch { /* private mode */ }
    await connect();
    if (needKey) toast("That key didn't work");
    return;
  }
  if (e.target.id === 'onboard-form') {
    state.settings.income = Number(data.income);
    state.settings.startDate = todayKey();
    save({ type: 'settings', settings: { income: state.settings.income, startDate: state.settings.startDate } });
    tab = 'today';
    render();
  } else if (e.target.id === 'settings-form') {
    const s = state.settings;
    s.income = Number(data.income) || s.income;
    s.rollover = !!data.rollover;
    s.reminderTime = data.reminderTime || '21:00';
    s.notify = !!data.notify;
    s.myName = String(data.myName || '').trim();
    if (s.notify && 'Notification' in window && Notification.permission === 'default') {
      s.notify = (await Notification.requestPermission()) === 'granted';
    }
    save({ type: 'settings', settings: { income: s.income, rollover: s.rollover, reminderTime: s.reminderTime, notify: s.notify, myName: s.myName } });
    toast('Saved');
    render();
  }
});

// Re-render when the day rolls over or the tab becomes visible again.
let lastKey = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkNightly();
  refresh();
  if (todayKey() !== lastKey) { lastKey = todayKey(); render(); }
});
setInterval(() => document.visibilityState === 'visible' && refresh(), 10_000);

render();
importFromHash();
checkNightly();
connect();

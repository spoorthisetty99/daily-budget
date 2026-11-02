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
 * Ops: {type:'add', txn} · {type:'delete', id} · {type:'settings', settings} · {type:'seen', fp} · {type:'replace', state}
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
    const res = await fetch('api/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    });
    if (!res.ok) throw new Error(res.status);
    if (adopt(await res.json()) && !isEditing()) render();
  } catch {
    outbox.unshift(...ops);
    toast('Saved on this phone. It will sync when your PC is reachable.');
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
    !document.activeElement.closest('#onboard-form'));

/** Finds the server; on first contact moves this device's data up if the server has none. */
async function connect() {
  let res;
  try {
    res = await fetch('api/state', { cache: 'no-store' });
  } catch {
    return; // PC unreachable right now: keep working locally, outbox waits
  }
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
    const res = await fetch('api/state', { cache: 'no-store' });
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

/* ================= Budget engine ================= */

const baseDaily = (k) => state.settings.income / daysInMonth(k);

const spentOn = (k) => state.txns.filter((t) => t.date === k).reduce((s, t) => s + t.amount, 0);

const spentBetween = (from, toExclusive) =>
  state.txns.filter((t) => t.date >= from && t.date < toExclusive).reduce((s, t) => s + t.amount, 0);

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
  'Other':         'dot',
};

const icon = (cat, name = '') => {
  const key = /zepto|swiggy instamart/i.test(name) ? 'scooter' : CATEGORIES[cat] || 'dot';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
};

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

const guessCategory = (name) => (MERCHANTS.find(([re]) => re.test(name)) || [, 'Other'])[1];

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
  if (!/debited|paid|spent|sent|withdrawn|purchase|txn|payment of/i.test(text)) return null;
  if (/credited to your|received from|refund/i.test(text) && !/debited/i.test(text)) return null;
  // Skip "Avl Bal Rs 12,000" / "credit limit INR 50,000" — take the first amount that isn't a balance.
  const amounts = [...text.matchAll(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
    .filter((m) => !/(bal(ance)?|limit|avl\.?|available)\s*(is|:)?\s*$/i.test(text.slice(Math.max(0, m.index - 20), m.index)));
  if (!amounts.length) return null;
  const amount = parseFloat(amounts[0][1].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  let name = '';
  const vpa = text.match(/(?:vpa|upi id)\s*:?\s*([\w.\-]+)@[\w.]+/i);
  const to = text.match(/\b(?:to|at|towards)\s+(?:vpa\s+)?([A-Za-z][\w&' .\-]{1,40}?)(?=\s+(?:on|via|ref|upi|using|from|for|avl|a\/c|\.|$)|[.,(]|@)/i);
  const info = text.match(/\binfo:?\s*(?:upi|pos|imps|neft|ach|ecom)?[-\/ ]*([A-Za-z][\w&' .]{1,30}?)(?=[.,]|\s+avl|\s+on\b|$)/i);
  if (to) name = to[1];
  else if (info) name = info[1];
  else if (vpa) name = vpa[1];
  name = name.replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'UPI payment';
  name = name.length > 22 ? name.slice(0, 22) : name;
  const method = /card/i.test(text) ? 'Card' : /atm|withdrawn/i.test(text) ? 'Cash' : 'UPI';
  return { name: titleCase(name), amount, method, category: guessCategory(name), date: dateInText(text) };
}

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

/** Adds one alert unless it was already imported (by shortcut or paste). Returns the spend, 'dup' or null. */
function importMessage(text) {
  const fp = fingerprint(text);
  if (state.seenSms.includes(fp)) return 'dup';
  const p = parseSms(text);
  if (!p) return null;
  addTxn(p);
  state.seenSms = [...state.seenSms, fp].slice(-500);
  save({ type: 'seen', fp });
  return p;
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/* ================= Mutations ================= */

function addTxn({ name, category, amount, method = 'UPI', date = todayKey() }) {
  amount = Number(amount);
  if (!name || !(amount > 0)) return false;
  const ops = [];
  // Backfilled spends from before setup still count towards this month.
  if (state.settings.startDate && date < state.settings.startDate) {
    state.settings.startDate = date;
    ops.push({ type: 'settings', settings: { startDate: date } });
  }
  const now = new Date();
  const txn = {
    id: crypto.randomUUID?.() || String(Date.now() + Math.random()),
    date,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    name: name.trim(),
    category: category || guessCategory(name),
    method,
    amount,
  };
  state.txns.push(txn);
  save(...ops, { type: 'add', txn });
  return true;
}

function deleteTxn(id) {
  state.txns = state.txns.filter((t) => t.id !== id);
  save({ type: 'delete', id });
}

/* ================= Rendering ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tab = 'today';

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#fab').style.display = tab === 'settings' ? 'none' : '';
  if (!state.settings.income) return renderOnboarding();
  ({ today: renderToday, month: renderMonth, insights: renderInsights, settings: renderSettings })[tab]();
}

function txnHtml(t) {
  return `
    <div class="txn">
      <div class="ico">${icon(t.category, t.name)}</div>
      <div class="meta">
        <div class="name">${esc(t.name)}</div>
        <div class="cat">${esc(t.category)} · ${esc(t.method)}</div>
      </div>
      <div class="amt">−${inr(t.amount)}</div>
      <button class="del" data-del="${t.id}" aria-label="Delete">×</button>
    </div>`;
}

function renderToday() {
  const k = todayKey();
  const budget = budgetFor(k);
  const spent = spentOn(k);
  const remaining = budget - spent;
  const color = stateColor(remaining, budget);
  const pct = budget > 0 ? Math.max(0, Math.min(100, (remaining / budget) * 100)) : 0;
  const day = parseKey(k).getDate();
  const txns = state.txns.filter((t) => t.date === k).reverse();
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
          : `of ${inr(budget)} today · ${inr(state.settings.income)} ÷ ${daysInMonth(k)} days${state.settings.rollover && Math.round(budget) !== Math.round(baseDaily(k)) ? ' (adjusted)' : ''}`}
      </div>
    </section>

    ${nightSummaryCard(k)}

    <div class="label section-title">Quick add</div>
    <div class="quick">
      ${QUICK_ADD.map((q, i) => `<button class="chip" data-quick="${i}">${q.name} <b>${inr(q.amount)}</b></button>`).join('')}
      <button class="chip" data-action="sms">📩 Paste SMS</button>
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
  const left = state.settings.income - monthSpent;
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
    cells.push(`<div class="${cls}" title="${dk}"><span class="n">${d}</span><span class="s">${label}</span></div>`);
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

function renderInsights() {
  const k = todayKey();
  const from = insightRange === 'week' ? addDays(k, -6) : insightRange === 'month' ? monthStart(k) : '0000-00-00';
  const txns = state.txns.filter((t) => t.date >= from && t.date <= k);
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
    <div class="segmented">
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
  for (const t of state.txns) {
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
    if (latest.category === 'Bills') continue; // rent, electricity etc. recur but aren't subscriptions
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const amounts = list.map((t) => t.amount);
    const similar = Math.max(...amounts) <= Math.min(...amounts) * 1.1;
    if (months.size >= 2 && similar && list.length <= months.size + 1) {
      out.push({ name: latest.name, amount: latest.amount, reason: '· recurring' });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
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
        <button class="btn" type="submit">Save</button>
      </form>
    </section>

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
  return `
    <div class="label section-title">Install as an app</div>
    <section class="card guide">
      <ol>
        <li>Open <b>${esc(base)}</b> in <b>Safari</b> on your iPhone.</li>
        <li>Tap <b>Share</b> → <b>Add to Home Screen</b> → <b>Add</b>.</li>
      </ol>
      <p class="sub">It opens full-screen from its own icon. Your data lives on your PC, so the app, Safari and your PC all show the same spends.</p>
    </section>

    <div class="label section-title">iPhone: auto-add in the background</div>
    <section class="card guide">
      <p class="sub" style="margin-top:0">Each bank alert is sent to your PC, which reads it and saves the spend. You get a notification and nothing opens.</p>
      <label class="label">Alert URL</label>
      ${copy('sms-api', base + '/api/sms')}
      <ol>
        <li><b>Shortcuts</b> → <b>Automation</b> → <b>+</b> → <b>Message</b> → Message Contains <code>Sent Rs</code> → <b>Run Immediately</b> → Next → <b>New Blank Automation</b>.</li>
        <li>Add <b>Get Contents of URL</b>. Set the URL to the alert URL above. Tap <b>›</b> to show more: Method <b>POST</b>, Request Body <b>JSON</b>, add a <b>Text</b> field with key <code>text</code> and value <b>Shortcut Input › Content</b>.</li>
        <li>Add <b>Show Notification</b> and set its text to <b>Contents of URL</b>.</li>
        <li>Make the same automation for <code>debited</code> and <code>spent</code>. For bank emails, use the <b>Email</b> trigger and pick the email's <b>Body</b>.</li>
      </ol>
      <label class="label">Nightly summary URL</label>
      ${copy('summary-api', base + '/api/summary')}
      <ol start="5">
        <li><b>Time of Day</b> automation (e.g. 9 PM, Run Immediately): <b>Get Contents of URL</b> with the summary URL, then <b>Show Notification</b> with <b>Contents of URL</b>.</li>
      </ol>
      <p class="sub">Your PC must be on with <code>start-server.cmd</code> running, and the phone on the same Wi-Fi. Alerts that arrive while you're away fail; paste those in later with <b>Paste SMS</b>.</p>
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

function openAddSheet(prefill = {}) {
  sheet.innerHTML = `
    <form method="dialog" id="add-form">
      <h2>Add a spend</h2>
      <div class="field">
        <label class="label" for="a-amount">Amount (₹)</label>
        <input id="a-amount" name="amount" type="number" inputmode="decimal" min="1" step="any" value="${prefill.amount ?? ''}" required />
      </div>
      <div class="field">
        <label class="label" for="a-name">Where</label>
        <input id="a-name" name="name" maxlength="40" placeholder="Coffee, Blinkit, Uber…" value="${esc(prefill.name ?? '')}" required />
      </div>
      <div class="row">
        <div class="field">
          <label class="label" for="a-cat">Category</label>
          <select id="a-cat" name="category">
            ${Object.keys(CATEGORIES).map((c) => `<option ${c === (prefill.category || 'Food & drink') ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label" for="a-method">Paid via</label>
          <select id="a-method" name="method">
            ${['UPI', 'Card', 'Cash', 'Net banking'].map((m) => `<option ${m === (prefill.method || 'UPI') ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label class="label" for="a-date">Date</label>
        <input id="a-date" name="date" type="date" value="${prefill.date || todayKey()}" max="${todayKey()}" />
      </div>
      <button class="btn" value="save">Add</button>
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  const name = $('#a-name', sheet);
  const cat = $('#a-cat', sheet);
  name.addEventListener('input', () => {
    const g = guessCategory(name.value);
    if (g !== 'Other') cat.value = g;
  });
  sheet.showModal();
  (prefill.amount ? name : $('#a-amount', sheet)).focus();
}

function openSmsSheet() {
  sheet.innerHTML = `
    <form method="dialog" id="sms-form">
      <h2>Paste bank / UPI alerts</h2>
      <p class="hint">Paste one or many SMS or emails. Leave a blank line between emails. Each spend goes on the date written in the message, and anything already added is skipped.</p>
      <div class="field">
        <textarea name="sms" placeholder="Rs.250.00 debited from A/c XX1234 to VPA starbucks@hdfcbank on 02-11-26. UPI Ref 6312…" required></textarea>
      </div>
      <button class="btn" value="parse">Add spends</button>
      <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
    </form>`;
  sheet.showModal();
}

sheet.addEventListener('close', () => {
  const form = sheet.querySelector('form');
  if (!form || sheet.returnValue === 'cancel' || !sheet.returnValue) return;
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'add-form') {
    if (addTxn(data)) { toast(`−${inr(data.amount)} · ${data.name}`); render(); }
  } else if (form.id === 'sms-form') {
    const results = splitMessages(data.sms).map(importMessage);
    const added = results.filter((r) => r && r !== 'dup');
    const dups = results.filter((r) => r === 'dup').length;
    const msg = added.length
      ? `Added ${added.length} spend${added.length > 1 ? 's' : ''} · ${inr(added.reduce((s, p) => s + p.amount, 0))}`
      : "Couldn't find a new debit in that";
    toast(dups ? `${msg} · ${dups} already added` : msg);
    render();
  }
  sheet.returnValue = '';
});

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
  if (p === 'dup') return toast('Already added that one');
  if (!p) return toast("No debit found in that message — nothing added");
  tab = 'today';
  render();
  toast(`Auto-added −${inr(p.amount)} · ${p.name}`);
}

window.addEventListener('hashchange', importFromHash);

/* ================= Misc ================= */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function exportCsv() {
  const rows = [['date', 'time', 'name', 'category', 'method', 'amount']]
    .concat(state.txns.map((t) => [t.date, t.time, t.name, t.category, t.method, t.amount]));
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

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  render();
  window.scrollTo({ top: 0 });
});

$('#fab').addEventListener('click', () => openAddSheet());

view.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
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
  } else if (t.dataset.action === 'sms') openSmsSheet();
  else if (t.dataset.action === 'export') exportCsv();
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
    if (s.notify && 'Notification' in window && Notification.permission === 'default') {
      s.notify = (await Notification.requestPermission()) === 'granted';
    }
    save({ type: 'settings', settings: { income: s.income, rollover: s.rollover, reminderTime: s.reminderTime, notify: s.notify } });
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

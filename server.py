#!/usr/bin/env python3
"""Daily Budget server: serves the app and keeps your data in data.json.

On your PC:        python server.py   then open  http://<this PC's Wi-Fi IP>:5173
On a host (WSGI):  point the host's WSGI config at `application` in this file
                   (see README: PythonAnywhere) and set BUDGET_KEY.

API (used by the app and the phone automations):
  GET  /api/state     the whole state (settings, transactions)
  POST /api/ops       apply the app's changes; returns the new state
  POST /api/sms       a bank alert (raw text, JSON {"text": ...} or form text=...);
                      saves the spend and answers with a one-line notification text
  GET  /api/summary   tonight's good/bad-day summary as plain text

  GET  /api/auth      {"users": true} when people log in with a username and password
  POST /api/login     {"username", "password"} → {"user", "key"}
  GET  /api/me        {"user", "admin"}
  GET  /api/users     (admin) the logins;  POST {"username", "password"} adds one with empty data

Each data file is also copied once a day to backups/<name>/<date>.json (the last 14 days are kept).

Logins: `python server.py adduser NAME` creates a user (see `python server.py help`). Each user
gets their own data file in data/ and their own key; every /api/ call then needs that key, in an
X-Budget-Key header (or ?key=), and only sees that user's data. With no users, there's one shared
data.json, guarded by BUDGET_KEY when that is set.

The SMS parser and budget maths mirror app.js; keep the two in sync.
"""
import calendar
import contextvars
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('BUDGET_DATA') or os.path.join(ROOT, 'data.json')
PORT = int(os.environ.get('PORT', 5173))
KEY = os.environ.get('BUDGET_KEY', '')  # single-user mode: required once the app is on the internet
USERS = os.environ.get('BUDGET_USERS') or os.path.join(ROOT, 'users.json')
DATA_DIR = os.environ.get('BUDGET_DATA_DIR') or os.path.join(ROOT, 'data')
LOCK = threading.Lock()
CURRENT = contextvars.ContextVar('data_file', default=DATA)  # the signed-in user's file, per request

# Hosts usually run on UTC; spends must land on the right Indian day.
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get('BUDGET_TZ', 'Asia/Kolkata'))
except Exception:  # no tz database (e.g. Windows without tzdata): the PC's own clock is fine
    TZ = None


def now():
    return datetime.now(TZ) if TZ else datetime.now()


# Only the app's own files are served, never data.json or .git.
STATIC = {'/', '/index.html', '/styles.css', '/app.js', '/sw.js', '/manifest.webmanifest',
          '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'}

DEFAULT_SETTINGS = {'income': 0, 'rollover': True, 'reminderTime': '21:00', 'notify': False, 'startDate': None,
                    'fixed': [], 'myName': '', 'accounts': [], 'investments': []}


# ================= Storage =================

def load():
    try:
        with open(CURRENT.get(), encoding='utf-8') as f:
            s = json.load(f)
    except (FileNotFoundError, ValueError):
        s = {}
    return {
        'settings': {**DEFAULT_SETTINGS, **(s.get('settings') or {})},
        'txns': s.get('txns') or [],
        'seenSms': s.get('seenSms') or [],
    }


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


BACKUP_DAYS = 14


def store(s):
    write_json(CURRENT.get(), s)
    snapshot(CURRENT.get(), s)


def snapshot(path, s):
    """Keeps the last copy of each day for BACKUP_DAYS days, in backups/<name>/ next to the data file,
    so a bad edit or "Erase everything" can be undone from an earlier day."""
    folder = os.path.join(os.path.dirname(path), 'backups', os.path.splitext(os.path.basename(path))[0])
    write_json(os.path.join(folder, today() + '.json'), s)
    for old in sorted(f for f in os.listdir(folder) if f.endswith('.json'))[:-BACKUP_DAYS]:
        os.remove(os.path.join(folder, old))


# ================= Users =================

NAME_RULE = r'[a-z0-9_-]{2,20}'


def users():
    """{name: {"salt", "hash", "key", "admin"?}} from users.json; empty means single-user mode."""
    try:
        with open(USERS, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def is_admin(name, accounts):
    """Admins add people from the app: anyone marked admin, or else the first user created."""
    marked = [n for n, u in accounts.items() if u.get('admin')]
    return name in marked if marked else name == next(iter(accounts), None)


def user_file(name):
    return os.path.join(DATA_DIR, f'{name}.json')


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200_000).hex()


def create_user(name, password, source=None):
    """Adds a login with its own data file (a copy of `source`, or a clean start). Raises ValueError."""
    name = str(name).strip().lower()
    accounts = users()
    if not re.fullmatch(NAME_RULE, name):
        raise ValueError('Usernames are 2–20 lowercase letters, numbers, - or _.')
    if name in accounts:
        raise ValueError(f'{name} already exists.')
    if len(password) < 8:
        raise ValueError('The password needs at least 8 characters.')
    salt = secrets.token_hex(16)
    accounts[name] = {'salt': salt, 'hash': hash_password(password, salt), 'key': secrets.token_urlsafe(24)}
    if not os.path.exists(user_file(name)):
        start = {'settings': dict(DEFAULT_SETTINGS), 'txns': [], 'seenSms': []}
        if source:
            with open(source, encoding='utf-8') as f:
                start = json.load(f)
        write_json(user_file(name), start)
    write_json(USERS, accounts)
    return accounts[name]


def who(key):
    """(username, data file) this app key opens; username is '' without logins. None if the key is wrong."""
    key = key.strip()
    accounts = users()
    if not accounts:
        return ('', DATA) if not KEY or hmac.compare_digest(key.encode(), KEY.encode()) else None
    for name, u in accounts.items():
        if key and hmac.compare_digest(key.encode(), u['key'].encode()):
            return name, user_file(name)
    return None


def login(raw):
    """(status, body) for POST /api/login."""
    try:
        d = json.loads(raw)
        name, password = str(d['username']).strip().lower(), str(d['password'])
    except (ValueError, KeyError, TypeError):
        return 400, {'error': 'Bad request'}
    u = users().get(name)
    if not u or not hmac.compare_digest(hash_password(password, u['salt']), u['hash']):
        time.sleep(1)  # slows down password guessing
        return 401, {'error': 'Wrong username or password.'}
    return 200, {'user': name, 'key': u['key']}


# ================= Dates & money =================

def today():
    return now().date().isoformat()


def pkey(k):
    return date.fromisoformat(k)


def add_days(k, n):
    return (pkey(k) + timedelta(days=n)).isoformat()


def days_in_month(k):
    d = pkey(k)
    return calendar.monthrange(d.year, d.month)[1]


def month_start(k):
    return k[:8] + '01'


def month_end(k):
    return k[:8] + f'{days_in_month(k):02d}'


def days_between(a, b):
    return (pkey(b) - pkey(a)).days


def inr(n):
    s = str(int(abs(n) + 0.5))
    if len(s) > 3:  # Indian grouping: 1,00,000
        s = re.sub(r'(\d)(?=(\d\d)+$)', r'\1,', s[:-3]) + ',' + s[-3:]
    return '₹' + s


# ================= Budget engine (mirrors app.js) =================

# Only daily spends eat the daily budget: not big one-off spends or money received (both have a
# 'kind'), and not "Fixed" spends (rent, SIP…), which were set aside up front.
def counts(t):
    return not t.get('kind') and t.get('category') != 'Fixed'


def spent_on(s, k):
    return sum(t['amount'] for t in s['txns'] if t['date'] == k and counts(t))


def spent_between(s, start, end_exclusive):
    return sum(t['amount'] for t in s['txns'] if start <= t['date'] < end_exclusive and counts(t))


def fixed_total(s):
    return sum(float(f.get('amount') or 0) for f in s['settings'].get('fixed') or [])


def base_daily(s, k):
    return max(0, s['settings']['income'] - fixed_total(s)) / days_in_month(k)


def budget_for(s, k):
    base = base_daily(s, k)
    st = s['settings']
    if not st['rollover']:
        return base
    start = max(month_start(k), st.get('startDate') or k)
    if k <= start:
        return base
    tracked_days = days_between(start, month_end(k)) + 1
    days_left = days_between(k, month_end(k)) + 1
    left = base * tracked_days - spent_between(s, start, k)
    return max(0, left / days_left)


def preview_tomorrow(s, k):
    t = add_days(k, 1)
    return base_daily(s, t) if month_start(t) != month_start(k) else budget_for(s, t)


def summary_text():
    s = load()
    if not s['settings']['income']:
        return 'Open Daily Budget and set your monthly income first.'
    k = today()
    budget, spent = budget_for(s, k), spent_on(s, k)
    roll = s['settings']['rollover']
    tomorrow = preview_tomorrow(s, k)
    if spent <= budget:
        tail = f' Tomorrow you get {inr(tomorrow)}.' if roll else ''
        return f'Good day 💚 You spent {inr(spent)} of your {inr(budget)} budget. Saved {inr(budget - spent)}.{tail}'
    tail = f" Tomorrow's budget drops to {inr(tomorrow)}." if roll else ''
    return f'Bad day 😬 You spent {inr(spent)} vs your {inr(budget)} budget, {inr(spent - budget)} over.{tail}'


# ================= SMS / email parser (mirrors app.js) =================

A = re.I | re.A
DEBIT = re.compile(r'debited|paid|spent|sent|withdrawn|purchase|txn|payment of', re.I)
CREDIT = re.compile(r'credited|received|deposited|refund', re.I)
# The account's last digits: "A/C *3344", "A/c no. XX7788", "Account Number: XX7788", "account ending in 3344"
ACCOUNT = re.compile(r"\b(?:a/c|acct|account)(?:\s*(?:no|number)\.?)?\s*:?\s*(?:ending\s+(?:with\s+|in\s+)?|[x*]+)(\d{3,6})\b", A)
FROM = re.compile(r"\b(?:from|by)\s+(?:vpa\s+)?(?:(?:neft|imps|rtgs|upi)[-/ ]+)?([A-Za-z][\w&' .\-]{1,40}?)"
                  r"(?=\s+(?:on|via|ref|upi|for|to|avl|a/c)\b|[.,(]|@|$)", A)
CREDIT_SOURCES = [(r'salary|payroll|\bsal\b', 'Salary'), (r'refund|reversal|cashback', 'Refund'),
                  (r'interest|\bint\.? ?pd', 'Interest'), (r'bonus', 'Bonus')]
AMOUNT = re.compile(r'(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)', A)
BALANCE_BEFORE = re.compile(r'(bal(ance)?|limit|avl\.?|available)\s*(is|:)?\s*$', A)
VPA = re.compile(r'(?:vpa|upi id)\s*:?\s*([\w.\-]+)@[\w.]+', A)
TO = re.compile(r"\b(?:to|at|towards)\s+(?:vpa\s+)?([A-Za-z][\w&' .\-]{1,40}?)"
                r"(?=\s+(?:on|via|ref|upi|using|from|for|avl|a/c|\.|$)|[.,(]|@)", A)
UPI_NAME = re.compile(r"\bupi/p2[am]/\d+/([A-Za-z][A-Za-z&' .]{1,40}?)(?=\s*/|\s+not\b|\s+avl|[.,]|$)", A)
REF = re.compile(r"(?:\bref(?:erence)?(?:\s*no)?\.?|\brrn|\bupi(?:/p2[am])?)[\s:/#.-]*(\d{12})\b", A)
CARD_BILL = re.compile(r"credit ?card (bill|payment|dues)|card ?bill|\bcc (bill|payment)|\bcred\b"
                       r"|towards (your )?([a-z]+ )*credit card", A)
INFO = re.compile(r"\binfo:?\s*(?:upi|pos|imps|neft|ach|ecom)?[-/ ]*([A-Za-z][\w&' .]{1,30}?)"
                  r"(?=[.,]|\s+avl|\s+on\b|$)", A)

MERCHANTS = [
    (r'zepto|blinkit|bigbasket|instamart|dmart|jiomart|grocer|kirana|more retail', 'Groceries'),
    (r'swiggy|zomato|starbucks|coffee|cafe|chai|tea|dominos|pizza|kfc|mcdonald|restaurant|bakery', 'Food & drink'),
    (r'netflix|spotify|prime|hotstar|youtube|apple|icloud|google one|jio ?cinema|sonyliv|zee5|gym|cult', 'Subscriptions'),
    (r'uber|ola|rapido|metro|irctc|petrol|fuel|indian oil|hpcl|bpcl|shell|fastag|redbus', 'Transport'),
    (r'electric|bescom|tata power|airtel|jio|vi |vodafone|broadband|recharge|gas|water|rent', 'Bills'),
    (r'amazon|flipkart|myntra|ajio|nykaa|meesho|decathlon|zara|h&m', 'Shopping'),
    (r'bookmyshow|pvr|inox|steam|playstation', 'Entertainment'),
    (r'pharma|apollo|medplus|1mg|pharmeasy|hospital|clinic|doctor', 'Health'),
]
MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']


def is_fixed_name(name, fixed):
    n = str(name).lower().strip()
    if len(n) < 3:
        return False
    for f in fixed or []:
        fn = str(f.get('name', '')).lower().strip()
        if len(fn) >= 3 and (fn in n or n in fn):
            return True
    return False


def is_self(name, mine):
    """A payee matching your own name (or a two-word start of it, as banks cut names short)."""
    def norm(x):
        return re.sub(r'[^a-z]+', ' ', str(x or '').lower()).strip()
    short, long = sorted([norm(name), norm(mine)], key=len)
    return len(short) >= 6 and (short == long or (' ' in short and long.startswith(short)))


def guess_category(name, fixed=()):
    if is_fixed_name(name, fixed):
        return 'Fixed'
    return next((c for pat, c in MERCHANTS if re.search(pat, name, re.I)), 'Other')


def title_case(s):
    return re.sub(r'\b\w', lambda m: m.group().upper(), s.lower(), flags=re.A)


def date_in_text(text):
    t = today()

    def yr(y):
        return 2000 + int(y) if len(y) == 2 else int(y)

    def try_key(y, m, d):
        try:
            k = date(y, m, d).isoformat()
        except ValueError:
            return None
        return k if k <= t and days_between(k, t) <= 92 else None

    m = re.search(r'\b(20\d\d)-(\d\d)-(\d\d)\b', text, re.A)
    if m:
        return try_key(int(m[1]), int(m[2]), int(m[3])) or t
    m = re.search(r'\b(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ,]+(\d{2,4})\b', text, re.A)
    if m and m[2].lower() in MONTHS:
        return try_key(yr(m[3]), MONTHS.index(m[2].lower()) + 1, int(m[1])) or t
    m = re.search(r'\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b', text, re.A)
    if m:
        return try_key(yr(m[3]), int(m[2]), int(m[1])) or t
    return t


def direction(text):
    """'out' for a debit, 'in' for a credit ("debited … credited to VPA x" is still a debit)."""
    if re.search('debited', text, re.I):
        return 'out'
    if CREDIT.search(text):
        return 'in'
    return 'out' if DEBIT.search(text) else None


def parse_sms(text, fixed=()):
    text = re.sub(r'\s+', ' ', str(text)).strip()
    way = direction(text)
    # A card bill's "payment received" comes from the card, not from a savings account.
    if not way or (way == 'in' and CARD_BILL.search(text)):
        return None
    amounts = [m for m in AMOUNT.finditer(text)
               if not BALANCE_BEFORE.search(text[max(0, m.start() - 20):m.start()])]
    if not amounts:
        return None
    try:
        amount = float(amounts[0][1].replace(',', ''))
    except ValueError:
        return None
    if amount <= 0:
        return None
    acct = ACCOUNT.search(text)
    ref = REF.search(text)
    base = {
        **({'ref': ref[1]} if ref else {}),
        **({'acct': acct[1]} if acct else {}),
        'dir': way,
        'amount': int(amount) if amount.is_integer() else amount,
        'date': date_in_text(text),
    }
    if way == 'in':
        hit = FROM.search(text) or UPI_NAME.search(text) or INFO.search(text) or VPA.search(text)
        name = re.sub(r'\s+', ' ', re.sub(r'[._\-]+', ' ', hit[1] if hit else '')).strip()[:22] or 'Money received'
        source = next((c for pat, c in CREDIT_SOURCES if re.search(pat, text, re.I)), 'Other')
        return {'kind': 'credit', **base, 'name': title_case(name), 'method': '', 'category': source}
    hit = TO.search(text) or UPI_NAME.search(text) or INFO.search(text) or VPA.search(text)
    name = hit[1] if hit else ''
    name = re.sub(r'\s+', ' ', re.sub(r'[._\-]+', ' ', name)).strip() or 'UPI payment'
    name = name[:22]
    method = 'Card' if re.search('card', text, re.I) else 'Cash' if re.search('atm|withdrawn', text, re.I) else 'UPI'
    # Paying a credit card is a big spend, not a daily one: its purchases were already counted.
    bill = CARD_BILL.search(text)
    if bill and re.search(r'credit|card|upi payment', name, re.I):
        name = 'Credit card bill'  # not "Your Hdfc Bank Credit"
    category = 'Card bill' if bill else guess_category(name, fixed)
    return {
        **({'kind': 'big'} if bill else {}),
        **base,
        'name': title_case(name),
        'method': method,
        'category': category,
    }


def fingerprint(text):
    """Same djb2 hash as app.js, so the app and the server agree on duplicates."""
    h = 5381
    for ch in re.sub(r'\s+', ' ', text).strip():
        c = ord(ch)
        if c > 0xFFFF:  # JS charCodeAt(0) sees the high surrogate
            c = 0xD800 + ((c - 0x10000) >> 10)
        h = ((h << 5) + h + c) & 0xFFFFFFFF
    return str(h)


# ================= Actions =================

def remember(s, key):
    s['seenSms'] = (s['seenSms'] + [key])[-500:]


def move_balance(s, p, fp):
    """Moves the savings account whose last digits are in the alert, once per payment (its SMS and email
    share a UPI ref). Alerts dated before the day you typed the balance are already in it."""
    digits = p.get('acct')
    acct = digits and next((a for a in s['settings'].get('accounts') or []
                            if len(a.get('digits') or '') >= 3
                            and (digits.endswith(a['digits']) or a['digits'].endswith(digits))), None)
    key = f"bal:{p.get('ref') or fp}:{p['dir']}"
    if not acct or p['date'] < (acct.get('asOf') or '') or key in s['seenSms']:
        return None
    moved = float(acct['balance']) + (p['amount'] if p['dir'] == 'in' else -p['amount'])
    acct['balance'] = int(moved) if moved.is_integer() else round(moved, 2)
    remember(s, key)
    return acct


def record_alert(s, p):
    """Adds the spend or money received. Returns ('added' | 'dup' | 'transfer', txn)."""
    same = p.get('ref') and next((x for x in s['txns'] if x.get('ref') == p['ref']), None)
    if same:
        # One UPI ref leaving one account and arriving in another: money moved between your own accounts.
        if same.get('kind') == 'transfer' or (same.get('kind') == 'credit') != (p['dir'] == 'in'):
            same.update(kind='transfer', category='Own account', method='')
            return 'transfer', same
        return 'dup', same
    t = {
        **({'ref': p['ref']} if p.get('ref') else {}),
        'id': str(uuid.uuid4()),
        'date': p['date'],
        'time': now().strftime('%H:%M'),
        'name': p['name'],
        'category': p['category'],
        'method': p['method'],
        'amount': p['amount'],
    }
    st = s['settings']
    if is_self(p['name'], st.get('myName')):
        t.update(kind='transfer', category='Own account', method='')
    elif p.get('kind'):
        t['kind'] = p['kind']
    s['txns'].append(t)
    if not t.get('kind') and st.get('startDate') and p['date'] < st['startDate']:
        st['startDate'] = p['date']
    return ('transfer' if t.get('kind') == 'transfer' else 'added'), t


def add_from_sms(text):
    """Save one bank alert; returns the notification text for the shortcut."""
    with LOCK:
        s = load()
        if not s['settings']['income']:
            return 'Open Daily Budget and set your monthly income first.'
        fp = fingerprint(text)
        if fp in s['seenSms']:
            return 'Already added this one.'
        p = parse_sms(text, s['settings'].get('fixed'))
        if not p:
            return 'No debit or credit found in that message, nothing added.'
        remember(s, fp)
        acct = move_balance(s, p, fp)
        what, t = record_alert(s, p)
        store(s)

        bal = f"\n{acct['name']}: {inr(acct['balance'])}" if acct else ''
        if what == 'dup':
            return f"Already added: {t['name']} {inr(t['amount'])} (same payment's SMS or email).{bal}"
        if what == 'transfer':
            return f"Moved {inr(p['amount'])} between your own accounts. Not counted as spending.{bal}"
        k = today()
        line = f"{'+' if p['dir'] == 'in' else '−'}{inr(p['amount'])} · {p['name']}"
        if p['date'] != k:
            d = pkey(p['date'])
            line += f" ({d.day} {d.strftime('%b')})"
        if p['dir'] == 'in':
            return f'{line}\nSaved under Money received.{bal}'
        if p['category'] == 'Fixed':
            return f'{line}\nFixed cost, already set aside. Daily budget unchanged.{bal}'
        if p.get('kind') == 'big':
            return f'{line}\nCard bill, saved under Big spends. Daily budget unchanged.{bal}'
        left = budget_for(s, k) - spent_on(s, k)
        status = f'{inr(left)} left today' if left >= 0 else f"{inr(-left)} over today's budget"
        return f'{line}\n{status}{bal}'


def apply_ops(ops):
    with LOCK:
        s = load()
        for op in ops:
            kind = op.get('type')
            if kind == 'add':
                t = op['txn']
                if not any(x['id'] == t['id'] for x in s['txns']):
                    s['txns'].append(t)
            elif kind == 'update':
                for x in s['txns']:
                    if x['id'] == op['id']:
                        x.update(op['changes'])
            elif kind == 'delete':
                s['txns'] = [x for x in s['txns'] if x['id'] != op['id']]
            elif kind == 'settings':
                s['settings'].update(op['settings'])
            elif kind == 'seen':
                if op['fp'] not in s['seenSms']:
                    s['seenSms'] = (s['seenSms'] + [op['fp']])[-500:]
            elif kind == 'replace':
                r = op['state']
                s = {'settings': {**DEFAULT_SETTINGS, **(r.get('settings') or {})},
                     'txns': r.get('txns') or [], 'seenSms': r.get('seenSms') or []}
        store(s)
        return s


# ================= HTTP =================

def body_text(raw, ctype):
    if 'json' in ctype:
        try:
            d = json.loads(raw)
            if isinstance(d, dict):
                return str(d.get('text') or next(iter(d.values()), ''))
            return str(d)
        except ValueError:
            pass
    if 'x-www-form-urlencoded' in ctype:
        return (parse_qs(raw).get('text') or [''])[0]
    return raw


TEXT = 'text/plain; charset=utf-8'
JSON = 'application/json; charset=utf-8'
TYPES = {  # explicit, since Windows' registry can map .js to text/plain
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png',
}


def people(method, name, raw):
    """GET /api/users lists logins; POST {"username", "password"} adds one. Admins only."""
    accounts = users()
    if not name or not is_admin(name, accounts):
        return 403, JSON, json.dumps({'error': 'Only the admin can add people.'}).encode()
    if method == 'POST':
        try:
            d = json.loads(raw)
            with LOCK:
                create_user(d['username'], str(d['password']))
        except (ValueError, KeyError, TypeError) as e:
            msg = str(e) if isinstance(e, ValueError) and not isinstance(e, json.JSONDecodeError) else 'Bad request'
            return 400, JSON, json.dumps({'error': msg}).encode()
        accounts = users()
    return 200, JSON, json.dumps({'users': [{'name': n, 'admin': is_admin(n, accounts)} for n in accounts]}).encode()


def respond(method, target, headers, body):
    """One request → (status, content type, body bytes). Shared by the PC server and WSGI.
    `headers` is a dict with lower-case names."""
    url = urlparse(target)
    path = url.path
    if path.startswith('/api/'):
        raw = body.decode('utf-8', 'replace')
        if path == '/api/auth':
            return 200, JSON, json.dumps({'users': bool(users())}).encode()
        if method == 'POST' and path == '/api/login':
            status, out = login(raw)
            return status, JSON, json.dumps(out).encode()
        me = who(headers.get('x-budget-key') or (parse_qs(url.query).get('key') or [''])[0])
        if not me:
            return 401, TEXT, b'Wrong or missing app key. Add the X-Budget-Key header (Settings in the app shows it).'
        name, file = me
        CURRENT.set(file)
        if path == '/api/me':
            return 200, JSON, json.dumps({'user': name, 'admin': bool(name) and is_admin(name, users())}).encode()
        if path == '/api/users':
            return people(method, name, raw)
        if method == 'GET' and path == '/api/state':
            return 200, JSON, json.dumps(load(), ensure_ascii=False).encode()
        if method == 'GET' and path == '/api/summary':
            return 200, TEXT, summary_text().encode()
        if method == 'POST' and path == '/api/sms':
            return 200, TEXT, add_from_sms(body_text(raw, headers.get('content-type', ''))).encode()
        if method == 'POST' and path == '/api/ops':
            try:
                ops = json.loads(raw)['ops']
            except (ValueError, KeyError, TypeError):
                return 400, TEXT, b'Bad request'
            return 200, JSON, json.dumps(apply_ops(ops), ensure_ascii=False).encode()
        if path.startswith('/api/sms'):
            return 404, TEXT, ('Shortcut setup: the message ended up in the URL. Set the URL to exactly '
                               '.../api/sms and put Content in the Request Body (JSON, key "text").').encode()
        return 404, TEXT, b'Not found'
    if method in ('GET', 'HEAD') and path in STATIC:
        name = 'index.html' if path == '/' else path[1:]
        with open(os.path.join(ROOT, name), 'rb') as f:
            data = f.read()
        return 200, TYPES[os.path.splitext(name)[1]], data
    return 404, TEXT, b'Not found'


def application(environ, start_response):
    """WSGI entry point (PythonAnywhere and other hosts)."""
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        length = 0
    body = environ['wsgi.input'].read(length) if length else b''
    headers = {k[5:].replace('_', '-').lower(): v for k, v in environ.items() if k.startswith('HTTP_')}
    headers['content-type'] = environ.get('CONTENT_TYPE', '')
    target = environ.get('PATH_INFO', '/') + ('?' + environ['QUERY_STRING'] if environ.get('QUERY_STRING') else '')
    status, ctype, data = respond(environ['REQUEST_METHOD'], target, headers, body)
    start_response(f'{status} {"OK" if status == 200 else "Error"}', [
        ('Content-Type', ctype), ('Content-Length', str(len(data))),
        ('Cache-Control', 'no-cache'),  # phones always get the latest app
    ])
    return [b''] if environ['REQUEST_METHOD'] == 'HEAD' else [data]


class Handler(BaseHTTPRequestHandler):
    """The PC server: same responses as `application`."""

    def read_body(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                size = int(self.rfile.readline().strip() or b'0', 16)
                if not size:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            return b''.join(chunks)
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def handle_any(self):
        body = self.read_body() if self.command == 'POST' else b''
        headers = {k.lower(): v for k, v in self.headers.items()}
        status, ctype, data = respond(self.command, self.path, headers, body)
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    do_GET = do_POST = do_HEAD = handle_any


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))  # no packet is sent; just picks the Wi-Fi interface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


HELP = """Users (each gets their own data and their own login):
  python server.py adduser NAME                    create a login; asks for a password
  python server.py adduser NAME --import data.json  same, starting from an existing data file
  python server.py passwd NAME                     change a password (the app key stays the same)
  python server.py users                           list users and their app keys
"""


def ask_password():
    while True:
        p = getpass.getpass('Password (at least 8 characters): ')
        if len(p) < 8:
            print('Too short.')
        elif p != getpass.getpass('Same password again: '):
            print("They don't match.")
        else:
            return p


def cli(args):
    accounts = users()
    cmd, name = args[0], (args[1].strip().lower() if len(args) > 1 else '')
    if cmd == 'users':
        for n, u in accounts.items():
            print(f'{n}: app key {u["key"]}')
        return print('No users yet: the app is in single-user mode.') if not accounts else None
    if cmd not in ('adduser', 'passwd') or not re.fullmatch(NAME_RULE, name):
        return print(HELP)
    if cmd == 'passwd':
        if name not in accounts:
            return print(f'No user called {name}.')
        salt = secrets.token_hex(16)
        accounts[name].update(salt=salt, hash=hash_password(ask_password(), salt))
        write_json(USERS, accounts)
        return print(f'Password changed for {name}.')
    if name in accounts:
        return print(f'{name} already exists. To change the password: python server.py passwd {name}')
    source = args[args.index('--import') + 1] if '--import' in args[:-1] else None
    if source and not os.path.exists(source):
        return print(f'{source} not found.')
    u = create_user(name, ask_password(), source)
    print(f'Created {name}{" with the data from " + source if source else " (empty, a clean start)"}.')
    print(f'App key, for their phone automations: {u["key"]}')
    if not accounts:
        print(f'{name} is the admin: they can add more people from Settings in the app.')
        print('From now on everyone logs in with a username and password (no restart needed).')


if __name__ == '__main__':
    if len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))
    ip = lan_ip()
    print('Daily Budget is running. Keep this window open.')
    print(f'  On your iPhone (same Wi-Fi): http://{ip}:{PORT}')
    print(f'  Shortcut URL for alerts:     http://{ip}:{PORT}/api/sms')
    print(f'  Shortcut URL for summary:    http://{ip}:{PORT}/api/summary')
    try:
        ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('Stopped.')

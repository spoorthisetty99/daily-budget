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

When BUDGET_KEY is set, every /api/ call needs it, in an X-Budget-Key header (or ?key=).

The SMS parser and budget maths mirror app.js; keep the two in sync.
"""
import calendar
import hmac
import json
import os
import re
import socket
import threading
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('BUDGET_DATA') or os.path.join(ROOT, 'data.json')
PORT = int(os.environ.get('PORT', 5173))
KEY = os.environ.get('BUDGET_KEY', '')  # required once the app is on the internet
LOCK = threading.Lock()

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
                    'fixed': [], 'myName': ''}


# ================= Storage =================

def load():
    try:
        with open(DATA, encoding='utf-8') as f:
            s = json.load(f)
    except (FileNotFoundError, ValueError):
        s = {}
    return {
        'settings': {**DEFAULT_SETTINGS, **(s.get('settings') or {})},
        'txns': s.get('txns') or [],
        'seenSms': s.get('seenSms') or [],
    }


def store(s):
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA)


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

# "Fixed" spends (rent, SIP…) were set aside up front, so they don't eat the daily budget.
def spent_on(s, k):
    return sum(t['amount'] for t in s['txns'] if t['date'] == k and t.get('category') != 'Fixed')


def spent_between(s, start, end_exclusive):
    return sum(t['amount'] for t in s['txns']
               if start <= t['date'] < end_exclusive and t.get('category') != 'Fixed')


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
CREDIT = re.compile(r'credited to your|received from|refund', re.I)
AMOUNT = re.compile(r'(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)', A)
BALANCE_BEFORE = re.compile(r'(bal(ance)?|limit|avl\.?|available)\s*(is|:)?\s*$', A)
VPA = re.compile(r'(?:vpa|upi id)\s*:?\s*([\w.\-]+)@[\w.]+', A)
TO = re.compile(r"\b(?:to|at|towards)\s+(?:vpa\s+)?([A-Za-z][\w&' .\-]{1,40}?)"
                r"(?=\s+(?:on|via|ref|upi|using|from|for|avl|a/c|\.|$)|[.,(]|@)", A)
UPI_NAME = re.compile(r"\bupi/p2[am]/\d+/([A-Za-z][A-Za-z&' .]{1,40}?)(?=\s*/|\s+not\b|\s+avl|[.,]|$)", A)
REF = re.compile(r"(?:\bref(?:erence)?(?:\s*no)?\.?|\brrn|\bupi(?:/p2[am])?)[\s:/#.-]*(\d{12})\b", A)
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


def parse_sms(text, fixed=()):
    text = re.sub(r'\s+', ' ', str(text)).strip()
    if not DEBIT.search(text):
        return None
    if CREDIT.search(text) and not re.search('debited', text, re.I):
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
    hit = TO.search(text) or UPI_NAME.search(text) or INFO.search(text) or VPA.search(text)
    name = hit[1] if hit else ''
    name = re.sub(r'\s+', ' ', re.sub(r'[._\-]+', ' ', name)).strip() or 'UPI payment'
    name = name[:22]
    method = 'Card' if re.search('card', text, re.I) else 'Cash' if re.search('atm|withdrawn', text, re.I) else 'UPI'
    ref = REF.search(text)
    return {
        **({'ref': ref[1]} if ref else {}),
        'name': title_case(name),
        'amount': int(amount) if amount.is_integer() else amount,
        'method': method,
        'category': guess_category(name, fixed),
        'date': date_in_text(text),
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
            return 'No debit found in that message, nothing added.'
        same = p.get('ref') and next((x for x in s['txns'] if x.get('ref') == p['ref']), None)
        if same:
            return f"Already added: {same['name']} {inr(same['amount'])} (same payment's SMS or email)."
        if is_self(p['name'], s['settings'].get('myName')):
            s['seenSms'] = (s['seenSms'] + [fp])[-500:]
            store(s)
            return f"Not counted: {inr(p['amount'])} transfer to your own account."
        s['txns'].append({
            **({'ref': p['ref']} if p.get('ref') else {}),
            'id': str(uuid.uuid4()),
            'date': p['date'],
            'time': now().strftime('%H:%M'),
            'name': p['name'],
            'category': p['category'],
            'method': p['method'],
            'amount': p['amount'],
        })
        st = s['settings']
        if st.get('startDate') and p['date'] < st['startDate']:
            st['startDate'] = p['date']
        s['seenSms'] = (s['seenSms'] + [fp])[-500:]
        store(s)

        k = today()
        line = f"−{inr(p['amount'])} · {p['name']}"
        if p['date'] != k:
            d = pkey(p['date'])
            line += f" ({d.day} {d.strftime('%b')})"
        if p['category'] == 'Fixed':
            return f'{line}\nFixed cost, already set aside. Daily budget unchanged.'
        left = budget_for(s, k) - spent_on(s, k)
        status = f'{inr(left)} left today' if left >= 0 else f"{inr(-left)} over today's budget"
        return f'{line}\n{status}'


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


def key_ok(headers, query):
    if not KEY:
        return True
    given = headers.get('x-budget-key') or (parse_qs(query).get('key') or [''])[0]
    return hmac.compare_digest(given.strip().encode(), KEY.encode())


def respond(method, target, headers, body):
    """One request → (status, content type, body bytes). Shared by the PC server and WSGI.
    `headers` is a dict with lower-case names."""
    url = urlparse(target)
    path = url.path
    if path.startswith('/api/'):
        if not key_ok(headers, url.query):
            return 401, TEXT, b'Wrong or missing app key. Add the X-Budget-Key header (Settings in the app shows it).'
        raw = body.decode('utf-8', 'replace')
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


if __name__ == '__main__':
    ip = lan_ip()
    print('Daily Budget is running. Keep this window open.')
    print(f'  On your iPhone (same Wi-Fi): http://{ip}:{PORT}')
    print(f'  Shortcut URL for alerts:     http://{ip}:{PORT}/api/sms')
    print(f'  Shortcut URL for summary:    http://{ip}:{PORT}/api/summary')
    try:
        ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('Stopped.')

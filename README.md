# Daily Budget — "Where did my money go?"

A daily-allowance expense tracker. Instead of a monthly budget you lose track of,
your monthly income is split into a budget for **every single day**:

> ₹1,00,000 ÷ 30 ≈ **₹3,333 / day**

Every spend (morning coffee ₹250, Blinkit ₹600, Zepto ₹400…) comes off today's number,
which goes green → yellow → red as it drains. At night you get a
"good day / bad day" summary, and anything you didn't spend makes tomorrow's budget higher.

## Features

- **Today's budget card** — remaining amount, spent, progress bar, day of month.
- **Quick add** chips for common spends, plus a full add form (amount, merchant, category, UPI/Card/Cash, date).
- **Paste a bank/UPI SMS** — amount and merchant are extracted automatically and the category is guessed
  (Zepto/Blinkit → Groceries, Swiggy/Starbucks → Food & drink, Netflix/Spotify → Subscriptions, …).
  Paste several messages at once, one per line.
- **Fixed monthly costs** (Settings) — rent, SIP, EMI… are set aside first: the daily budget is
  (income − fixed costs) ÷ days. When one is paid, its spend is tagged **Fixed** (automatically if the
  alert's name matches) and doesn't count against that day.
- **Rollover** (toggle) — what's left of the month is spread over the remaining days, so underspending
  raises tomorrow's budget and overspending lowers it.
- **Nightly summary** — browser notification at a time you choose, e.g.
  *"You spent ₹4,200 vs your ₹3,333 budget — ₹867 over. Tomorrow's budget drops to ₹3,290."*
  The same summary also appears on the Today tab after that time.
- **Month view** — calendar of good/bad days with totals.
- **Insights** — spend by category, top merchants, and **subscriptions** (explicit or detected as
  the same merchant charging a similar amount in two or more months) with monthly/yearly cost.
- **Spending trend** (Insights) — daily / weekly / monthly bars against the budget, a trend line, and
  "↓ 12% spending down: last 7 days vs the 7 before". Fixed costs and incomplete periods are left out.
- CSV export, demo data, installable on iPhone and Android home screens.

## Run it

No build step and no dependencies beyond Python 3. `server.py` serves the app and keeps your data in
`data.json` next to it (git-ignored), so every device that opens the app sees the same spends.

- **On your PC (home Wi-Fi only):** double-click **`start-server.cmd`** (or `python server.py`). It prints the
  address to open on your phone, e.g. `http://192.168.0.5:5173`.
- **Always on, from anywhere:** host it on PythonAnywhere (below).

Settings → **Load demo data** fills ~40 days of sample spends so you can see the month and insights views.

## Host it on PythonAnywhere (free, always on)

Why PythonAnywhere and not Render's free plan: Render's free servers go to sleep after 15 minutes (the first bank
alert after a quiet spell can time out) and wipe their files on every restart (your `data.json` would vanish).
PythonAnywhere's free plan stays on, keeps files, and gives you HTTPS (needed to install on Android).

1. Sign up at **pythonanywhere.com** (free "Beginner" plan). Your app will live at `https://<username>.pythonanywhere.com`.
2. **Consoles → Bash**, then:
   ```bash
   git clone https://github.com/spoorthisetty99/daily-budget.git
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```
   The repo is private, so git asks for your GitHub username and a password: use a **personal access token**
   (GitHub → Settings → Developer settings → Fine-grained tokens → only this repo, *Contents: Read-only*).
   The second line prints a random **app key**. Save it in your password manager.
3. **Files** → open `daily-budget/` → **Upload a file** → your PC's `Desktop\expense\data.json` (this moves your spends over).
4. **Web → Add a new web app → Manual configuration →** the newest Python 3.
5. On the Web tab, open the **WSGI configuration file** link, delete everything in it, and paste (with your
   username and key):
   ```python
   import os, sys
   os.environ['BUDGET_KEY'] = 'paste-your-app-key-here'
   sys.path.insert(0, '/home/<username>/daily-budget')
   from server import application
   ```
   Save, turn on **Force HTTPS**, and press **Reload**.
6. Open `https://<username>.pythonanywhere.com` on your phone and enter the app key once.
7. Point your phone automations at `https://<username>.pythonanywhere.com/api/sms` (and `/api/summary`) and add
   the header `X-Budget-Key: <app key>`. Settings in the app shows both, with copy buttons.

Updating later: in a Bash console, `cd daily-budget && git pull`, then **Reload** on the Web tab.
Free plan housekeeping: every 3 months, press **"Run until 3 months from today"** on the Web tab.

## Install on your phone

- **iPhone:** open the address in **Safari** → **Share** → **Add to Home Screen**.
- **Android:** open the address in **Chrome** → **⋮** → **Install app**. (A real install needs the HTTPS address
  from PythonAnywhere; over the PC's Wi-Fi address Chrome only offers a home-screen shortcut.)

Either way it gets its own icon and opens full-screen.

## Android: auto-add bank SMS in the background

Android has no Shortcuts app; the free **MacroDroid** app does the same job.

1. **Add Macro → Trigger: SMS Received** → Any number → *Message content* **contains** `Sent Rs`.
2. **Action: HTTP Request** → POST `https://<username>.pythonanywhere.com/api/sms`, body content type
   `text/plain`, body `[sms_message]`, header `X-Budget-Key` = your app key. Save the response into a text variable.
3. **Action: Display Notification** → text = that variable.
4. Make the same macro for `debited` and `spent` (the free plan allows 5 macros).
5. Nightly summary: a **Day/Time** trigger at 9 PM → HTTP Request **GET** `/api/summary` (same header) → notification.

## iPhone: auto-add from SMS & email in the background (no bank connection)

iOS doesn't let apps read your messages, but a **Shortcuts automation** can send each bank alert to the PC.
Nothing opens on the phone; you just get a notification like `−₹350 · Ravi Stores 2 / ₹2,983 left today`.

1. Shortcuts → Automation → **+** → **Message** → *Message Contains* `Sent Rs` → **Run Immediately** → New Blank Automation.
2. **Get Contents of URL** → `http://<PC-IP>:5173/api/sms`, Method **POST**, Request Body **JSON**,
   Text field `text` = **Shortcut Input › Content**.
3. **Show Notification** → **Contents of URL**.
4. Banks word alerts differently (HDFC UPI: `Sent Rs.…`, others: `debited`, cards: `spent`), so make one automation
   per wording. For bank emails use the **Email** trigger and the email **Body**.
5. Nightly summary: **Time of Day** automation → **Get Contents of URL** `http://<PC-IP>:5173/api/summary` →
   **Show Notification**.

Balances ("Avl Bal Rs …") are ignored, credits are skipped, the date in the message is used, and the same message is
never counted twice. The steps, with copy buttons for both URLs, are also in the app under Settings.

Older alerts (before the automation existed): copy them from Messages / Mail and use **Paste SMS** on the Today tab.

## Limits

- PC mode: the PC must be on with the server running, and the phone on the same Wi-Fi. Alerts that arrive while
  you're away show "Automation failed"; paste those in later. Anyone on the same Wi-Fi who knows the address can
  open the app (set `BUDGET_KEY` before starting the server to require the key there too).
- Hosted mode: everything under `/api/` needs the app key. Keep it private; if it leaks, change it in the WSGI
  file, Reload, and enter the new key on each device and automation.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell |
| `styles.css` | Dark neon theme |
| `app.js` | Budget engine, SMS parser, views, sync with the server |
| `server.py` | Serves the app (PC server or WSGI `application`), stores `data.json`, app-key check, `/api/sms` and `/api/summary` for phone automations (parser mirrors `app.js`) |
| `start-server.cmd` | Double-click launcher for Windows |
| `sw.js` | Offline cache + notification clicks |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Home-screen install metadata and icons (iPhone + Android) |

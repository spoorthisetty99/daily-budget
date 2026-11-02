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
- CSV export, demo data, installable on the iPhone home screen.

## Run it

No build step and no dependencies beyond Python 3. On the PC, double-click **`start-server.cmd`**
(or run `python server.py`). It prints the address to open on your phone, e.g. `http://192.168.0.5:5173`.

`server.py` serves the app and keeps your data in `data.json` next to it (git-ignored), so the iPhone app,
Safari and the PC all see the same spends. The first device that opens the app uploads what it already has.
Served by any other static host instead, the app falls back to keeping data in that browser only.

Settings → **Load demo data** fills ~40 days of sample spends so you can see the month and insights views.

## Install on iPhone

Open the address in **Safari** → **Share** → **Add to Home Screen**. It gets its own icon and opens full-screen.

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

- The PC must be on with the server running, and the phone on the same Wi-Fi. Alerts that arrive while you're
  away show "Automation failed"; paste those in later.
- Anyone on the same Wi-Fi who knows the address can open the app and its data. Fine at home; stop the server
  on public Wi-Fi.
- On Android there's no automation hook, so it's paste-to-add there ("Paste SMS").

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell |
| `styles.css` | Dark neon theme |
| `app.js` | Budget engine, SMS parser, views, sync with the server |
| `server.py` | Serves the app, stores `data.json`, `/api/sms` and `/api/summary` for Shortcuts (parser mirrors `app.js`) |
| `start-server.cmd` | Double-click launcher for Windows |
| `sw.js` | Offline cache + notification clicks |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` | Home-screen install metadata and icons |

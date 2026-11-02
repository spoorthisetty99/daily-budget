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
- **Rollover** (toggle) — what's left of the month is spread over the remaining days, so underspending
  raises tomorrow's budget and overspending lowers it.
- **Nightly summary** — browser notification at a time you choose, e.g.
  *"You spent ₹4,200 vs your ₹3,333 budget — ₹867 over. Tomorrow's budget drops to ₹3,290."*
  The same summary also appears on the Today tab after that time.
- **Month view** — calendar of good/bad days with totals.
- **Insights** — spend by category, top merchants, and **subscriptions** (explicit or detected as
  the same merchant charging a similar amount in two or more months) with monthly/yearly cost.
- CSV export, demo data, installable as a PWA, works offline. All data stays in the browser (localStorage).

## Run it

No build step and no dependencies. Serve the folder with any static server:

```bash
python -m http.server 5173
```

Then open http://localhost:5173. (Opening `index.html` directly also works, but the service worker —
offline mode and notifications from the installed app — needs `http://localhost` or HTTPS.)

Settings → **Load demo data** fills ~40 days of sample spends so you can see the month and insights views.

## Limits

- Web apps can't read your SMS inbox, so "automatic" tracking is paste-to-add. A native Android app
  (SMS permission) or an Account Aggregator integration would be needed for fully hands-free tracking.
- The nightly notification fires while the app/tab is open (or when you next open it after the set time).
  Guaranteed delivery with the app closed would need a push server.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell |
| `styles.css` | Dark neon theme |
| `app.js` | Budget engine, SMS parser, views, notifications |
| `sw.js` | Offline cache + notification clicks |
| `manifest.webmanifest`, `icon.svg` | PWA install metadata |

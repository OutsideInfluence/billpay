# BillPay

A small household bill tracker: record paychecks, keep a list of monthly bills,
and see exactly what's due between paydays.

## Run it

```bash
cp .env.example .env        # optional
docker compose up -d --build
```

Open http://localhost:8080 (or http://<your-server-ip>:8080 from your phone).

First visit: the app asks you to create the first account. Then go to
**Settings**, add an account for your wife under *Household accounts*, enter both names, choose your pay schedule
(every 2 weeks, or 1st & 15th) and pick any recent payday. The dashboard uses
that date to work out every two-week period.

## Unraid with GitHub, its own IP and HTTPS

`deploy/unraid/docker-compose.yml` runs two containers:

- **billpay** – the app, pulled from GitHub Container Registry. It sits on a
  private network and isn't reachable directly.
- **billpay-https** – Caddy, which has its own LAN IP on Unraid's `br2` network,
  gets a certificate from your ACME server, renews it automatically, and
  redirects http:// to https://.

Every push to the `main` branch on GitHub runs `.github/workflows/docker-image.yml`,
which builds a new image. Compose Up on Unraid pulls it.

## Using it

- **Bills** – creditor, amount, due day (1–31; 31 means "last day of the month"),
  payment website, category, last 4 of the account, autopay flag, notes.
- **Income** – add each paycheck as it's deposited, tagged with who earned it.
- **This period** – a 14-day calendar strip, deposits minus bills = what's left,
  a checklist to mark bills paid, and a list of anything still unpaid from the
  previous 60 days. Use ‹ › to look ahead or back.

## Data & backups

Data lives in a SQLite file in the `billpay-data` Docker volume.

```bash
# back up
docker compose exec billpay python -c "import sqlite3;s=sqlite3.connect('/data/billpay.db');s.backup(sqlite3.connect('/data/backup.db'))"
docker cp billpay:/data/backup.db ./billpay-backup-$(date +%F).db
```

## Accounts and sign-in

- Every account shares the same household data (bills, income, settings).
- Passwords need at least 10 characters and are stored as salted hashes, never in plain text.
- "Keep me signed in" lasts 30 days. Changing your password signs out all your other devices.
- After 5 wrong passwords in 15 minutes, that username is locked for 15 minutes.
- Add or remove accounts and change your password under **Settings**.

Forgot a password and nobody can sign in?

```bash
docker compose exec billpay python app/reset_password.py <username>
```

## Upgrading from the earlier version

The old `APP_USER` / `APP_PASSWORD` settings are gone. Rebuild with
`docker compose up -d --build`; your bills and income are kept, and the app
asks you to create an account the first time you open it.

## Security notes

- If you open the app from outside your home network, put it behind HTTPS
  (Caddy, Nginx Proxy Manager, Traefik, or Tailscale) and set `COOKIE_SECURE=1`.
  Over plain HTTP a password can be read by anyone on the network path.
- Behind a reverse proxy, also set `TRUST_PROXY=1` so lockouts see real client IPs.
- The session signing key is generated on first start and stored in the data
  volume (`/data/secret_key`). Deleting it signs everyone out.
- The app only keeps the last 4 digits of account numbers. Don't store full
  account numbers or website passwords in the notes field; use a password manager.

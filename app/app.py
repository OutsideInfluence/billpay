"""BillPay - household bill tracker. Flask + SQLite."""
import calendar
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "billpay.db"))
DATA_DIR = os.path.dirname(os.path.abspath(DB_PATH))
MAX_FAILS = 5            # failed logins allowed...
LOCK_MINUTES = 15        # ...within this many minutes before the account/IP is locked
MIN_PASSWORD = 10

app = Flask(__name__, static_folder="static", static_url_path="")


def load_secret_key():
    """Use SECRET_KEY from the environment, or create one and keep it in the data volume."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "secret_key")
    if not os.path.exists(path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Set COOKIE_SECURE=1 when the app is served over HTTPS (e.g. behind a reverse proxy).
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    SESSION_COOKIE_NAME="billpay_session",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creditor TEXT NOT NULL,
    description TEXT DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    website TEXT DEFAULT '',
    category TEXT DEFAULT '',
    account_hint TEXT DEFAULT '',
    autopay INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS income (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    earner TEXT NOT NULL,
    amount REAL NOT NULL,
    deposit_date TEXT NOT NULL,
    note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    paid_on TEXT NOT NULL,
    amount REAL NOT NULL,
    UNIQUE (bill_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_income_date ON income(deposit_date);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE,
    ip TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fail_user ON login_failures(username, at);
CREATE INDEX IF NOT EXISTS idx_fail_ip ON login_failures(ip, at);
"""

DEFAULT_SETTINGS = {
    "person1": "Me",
    "person2": "My wife",
    "pay_schedule": "biweekly",  # biweekly | semimonthly
    "payday_anchor": date.today().isoformat(),
}


# ---------- database ----------
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode = WAL")
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
    conn.commit()
    conn.close()


init_db()


def get_settings():
    return {r["key"]: r["value"] for r in db().execute("SELECT key, value FROM settings")}


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ---------- auth ----------
PUBLIC_PATHS = {"/healthz", "/api/auth/status", "/api/auth/login", "/api/auth/setup"}


def current_user():
    if "user" not in g:
        g.user = None
        uid, ver = session.get("uid"), session.get("ver")
        if uid:
            r = db().execute("SELECT id, username, display_name, session_version FROM users WHERE id=?", (uid,)).fetchone()
            # session_version lets a password change sign out every other device.
            if r and r["session_version"] == ver:
                g.user = {"id": r["id"], "username": r["username"], "display_name": r["display_name"]}
    return g.user


def user_count():
    return db().execute("SELECT COUNT(*) FROM users").fetchone()[0]


@app.before_request
def guard():
    path = request.path
    if not path.startswith("/api/") or path in PUBLIC_PATHS:
        return None  # static files (the login screen itself) and public endpoints
    # CSRF defence: browsers won't add this header on cross-site form posts.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("X-Requested-With") != "BillPay":
        return jsonify({"error": "Request blocked."}), 403
    if not current_user():
        return jsonify({"error": "Sign in to continue.", "auth": True}), 401
    return None


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def client_ip():
    # Only trust X-Forwarded-For if explicitly told we're behind a proxy.
    if os.environ.get("TRUST_PROXY") == "1" and request.headers.get("X-Forwarded-For"):
        return request.headers["X-Forwarded-For"].split(",")[0].strip()
    return request.remote_addr or "?"


def validate_username(u):
    u = (u or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9._-]{3,32}", u):
        raise ValueError("Usernames are 3–32 characters: letters, numbers, dots, dashes or underscores.")
    return u


def validate_password(pw):
    if not pw or len(pw) < MIN_PASSWORD:
        raise ValueError(f"Passwords need at least {MIN_PASSWORD} characters.")
    if len(pw) > 256:
        raise ValueError("That password is too long.")
    return pw


def start_session(user_row, remember):
    session.clear()
    session["uid"] = user_row["id"]
    session["ver"] = user_row["session_version"]
    session.permanent = bool(remember)


@app.get("/api/auth/status")
def auth_status():
    return jsonify({"setup_needed": user_count() == 0, "user": current_user()})


@app.post("/api/auth/setup")
def auth_setup():
    """Create the very first account. Disabled once any account exists."""
    if user_count() > 0:
        return bad("Setup is already complete. Sign in instead.", 409)
    data = request.get_json(force=True) or {}
    try:
        username = validate_username(data.get("username"))
        password = validate_password(data.get("password"))
    except ValueError as e:
        return bad(str(e))
    name = (data.get("display_name") or username).strip()[:60]
    try:
        cur = db().execute(
            "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)",
            (username, name, generate_password_hash(password), datetime.utcnow().isoformat()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return bad("Setup is already complete. Sign in instead.", 409)
    start_session(db().execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone(), True)
    return jsonify({"user": current_user()}), 201


@app.post("/api/auth/login")
def auth_login():
    data = request.get_json(force=True) or {}
    username = str(data.get("username", "")).strip().lower()[:64]
    password = str(data.get("password", ""))
    ip = client_ip()
    since = (datetime.utcnow() - timedelta(minutes=LOCK_MINUTES)).isoformat()
    conn = db()
    conn.execute("DELETE FROM login_failures WHERE at < ?", (since,))
    fails_user = conn.execute("SELECT COUNT(*) FROM login_failures WHERE username=? AND at>=?", (username, since)).fetchone()[0]
    fails_ip = conn.execute("SELECT COUNT(*) FROM login_failures WHERE ip=? AND at>=?", (ip, since)).fetchone()[0]
    if fails_user >= MAX_FAILS or fails_ip >= MAX_FAILS * 3:
        conn.commit()
        return bad(f"Too many failed attempts. Try again in {LOCK_MINUTES} minutes.", 429)

    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    # Always run a hash check so response time doesn't reveal whether the user exists.
    ok = check_password_hash(row["password_hash"] if row else _DUMMY_HASH, password) and row is not None
    if not ok:
        conn.execute("INSERT INTO login_failures (username, ip, at) VALUES (?,?,?)", (username, ip, datetime.utcnow().isoformat()))
        conn.commit()
        return bad("That username and password don't match.", 401)
    conn.execute("DELETE FROM login_failures WHERE username=?", (username,))
    conn.commit()
    start_session(row, data.get("remember", True))
    return jsonify({"user": current_user()})


_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/users")
def users_list():
    return jsonify(rows(db().execute("SELECT id, username, display_name, created_at FROM users ORDER BY id")))


@app.post("/api/users")
def users_create():
    data = request.get_json(force=True) or {}
    try:
        username = validate_username(data.get("username"))
        password = validate_password(data.get("password"))
    except ValueError as e:
        return bad(str(e))
    name = (data.get("display_name") or username).strip()[:60]
    try:
        db().execute(
            "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)",
            (username, name, generate_password_hash(password), datetime.utcnow().isoformat()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return bad("That username is already taken.")
    return jsonify({"ok": True}), 201


@app.delete("/api/users/<int:uid>")
def users_delete(uid):
    if uid == current_user()["id"]:
        return bad("You can't remove your own account while signed in to it.")
    if user_count() <= 1:
        return bad("At least one account must remain.")
    db().execute("DELETE FROM users WHERE id=?", (uid,))
    db().commit()
    return "", 204


@app.put("/api/users/me")
def users_update_me():
    data = request.get_json(force=True) or {}
    me = current_user()
    row = db().execute("SELECT * FROM users WHERE id=?", (me["id"],)).fetchone()
    if "display_name" in data and str(data["display_name"]).strip():
        db().execute("UPDATE users SET display_name=? WHERE id=?", (str(data["display_name"]).strip()[:60], me["id"]))
    if data.get("new_password"):
        if not check_password_hash(row["password_hash"], str(data.get("current_password", ""))):
            return bad("Your current password is incorrect.")
        try:
            pw = validate_password(data["new_password"])
        except ValueError as e:
            return bad(str(e))
        db().execute(
            "UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?",
            (generate_password_hash(pw), me["id"]),
        )
        db().commit()
        # Keep this device signed in; every other device is signed out.
        start_session(db().execute("SELECT * FROM users WHERE id=?", (me["id"],)).fetchone(), session.permanent)
    db().commit()
    g.pop("user", None)
    return jsonify({"user": current_user()})


# ---------- helpers ----------
def parse_date(s, default=None):
    if not s:
        return default
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def bad(msg, code=400):
    return jsonify({"error": msg}), code


def due_date_for(bill_due_day, year, month):
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(bill_due_day, last))


def period_for(d, settings):
    """Return (start, end) of the pay period containing date d."""
    if settings.get("pay_schedule") == "semimonthly":
        if d.day < 15:
            return date(d.year, d.month, 1), date(d.year, d.month, 14)
        last = calendar.monthrange(d.year, d.month)[1]
        return date(d.year, d.month, 15), date(d.year, d.month, last)
    anchor = parse_date(settings.get("payday_anchor"), date.today())
    offset = (d - anchor).days // 14
    start = anchor + timedelta(days=offset * 14)
    return start, start + timedelta(days=13)


def occurrences(bill, start, end):
    """All due dates of a monthly bill that fall in [start, end]."""
    out = []
    y, m = start.year, start.month
    bill_start = parse_date(bill["start_date"])
    while (y, m) <= (end.year, end.month):
        dd = due_date_for(bill["due_day"], y, m)
        if start <= dd <= end and dd >= bill_start:
            out.append(dd)
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def bill_instances(start, end):
    bills = rows(db().execute("SELECT * FROM bills WHERE active = 1"))
    pays = {
        (p["bill_id"], p["due_date"]): p
        for p in rows(
            db().execute(
                "SELECT * FROM payments WHERE due_date BETWEEN ? AND ?",
                (start.isoformat(), end.isoformat()),
            )
        )
    }
    out = []
    for b in bills:
        for dd in occurrences(b, start, end):
            p = pays.get((b["id"], dd.isoformat()))
            out.append({**b, "autopay": bool(b["autopay"]), "due_date": dd.isoformat(), "payment": p})
    out.sort(key=lambda x: (x["due_date"], x["creditor"].lower()))
    return out


# ---------- routes ----------
@app.get("/healthz")
def healthz():
    return "ok"


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/settings")
def settings_get():
    return jsonify(get_settings())


@app.put("/api/settings")
def settings_put():
    data = request.get_json(force=True) or {}
    allowed = set(DEFAULT_SETTINGS)
    if data.get("pay_schedule") not in (None, "biweekly", "semimonthly"):
        return bad("Pay schedule must be biweekly or semimonthly.")
    if "payday_anchor" in data:
        try:
            parse_date(data["payday_anchor"])
        except ValueError:
            return bad("Payday must be a valid date.")
    for k, v in data.items():
        if k in allowed:
            db().execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, str(v).strip()))
    db().commit()
    return jsonify(get_settings())


BILL_FIELDS = ["creditor", "description", "amount", "due_day", "website", "category",
               "account_hint", "autopay", "notes", "active", "start_date"]


def clean_bill(data, partial=False):
    b = {}
    for f in BILL_FIELDS:
        if f in data:
            b[f] = data[f]
    if not partial or "creditor" in b:
        if not str(b.get("creditor", "")).strip():
            raise ValueError("Enter the creditor's name.")
        b["creditor"] = str(b["creditor"]).strip()
    if not partial or "amount" in b:
        try:
            b["amount"] = round(float(b.get("amount", 0)), 2)
        except (TypeError, ValueError):
            raise ValueError("Amount must be a number.")
    if not partial or "due_day" in b:
        try:
            b["due_day"] = int(b.get("due_day"))
            assert 1 <= b["due_day"] <= 31
        except (TypeError, ValueError, AssertionError):
            raise ValueError("Due day must be between 1 and 31.")
    for f in ("autopay", "active"):
        if f in b:
            b[f] = 1 if b[f] in (True, 1, "1", "true", "on") else 0
    if "website" in b and b["website"]:
        w = str(b["website"]).strip()
        if not w.startswith(("http://", "https://")):
            w = "https://" + w
        b["website"] = w
    if "account_hint" in b:
        # Only ever keep the last 4 characters of an account number.
        b["account_hint"] = str(b["account_hint"]).strip()[-4:]
    if not partial and not b.get("start_date"):
        b["start_date"] = date.today().replace(day=1).isoformat()
    return b


@app.get("/api/bills")
def bills_list():
    return jsonify(rows(db().execute("SELECT * FROM bills ORDER BY active DESC, due_day, creditor")))


@app.post("/api/bills")
def bills_create():
    try:
        b = clean_bill(request.get_json(force=True) or {})
    except ValueError as e:
        return bad(str(e))
    cols = ",".join(b)
    cur = db().execute(f"INSERT INTO bills ({cols}) VALUES ({','.join('?' * len(b))})", list(b.values()))
    db().commit()
    return jsonify(dict(db().execute("SELECT * FROM bills WHERE id=?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/bills/<int:bid>")
def bills_update(bid):
    try:
        b = clean_bill(request.get_json(force=True) or {}, partial=True)
    except ValueError as e:
        return bad(str(e))
    if b:
        sets = ",".join(f"{k}=?" for k in b)
        db().execute(f"UPDATE bills SET {sets} WHERE id=?", [*b.values(), bid])
        db().commit()
    r = db().execute("SELECT * FROM bills WHERE id=?", (bid,)).fetchone()
    return jsonify(dict(r)) if r else bad("Bill not found.", 404)


@app.delete("/api/bills/<int:bid>")
def bills_delete(bid):
    db().execute("DELETE FROM bills WHERE id=?", (bid,))
    db().commit()
    return "", 204


@app.get("/api/income")
def income_list():
    q, args = "SELECT * FROM income", []
    if request.args.get("from") and request.args.get("to"):
        q += " WHERE deposit_date BETWEEN ? AND ?"
        args = [request.args["from"], request.args["to"]]
    q += " ORDER BY deposit_date DESC, id DESC LIMIT 200"
    return jsonify(rows(db().execute(q, args)))


def clean_income(data):
    earner = str(data.get("earner", "")).strip()
    if not earner:
        raise ValueError("Choose who was paid.")
    try:
        amount = round(float(data.get("amount")), 2)
        assert amount > 0
    except (TypeError, ValueError, AssertionError):
        raise ValueError("Amount must be greater than zero.")
    try:
        d = parse_date(data.get("deposit_date"), date.today())
    except ValueError:
        raise ValueError("Deposit date must be a valid date.")
    return earner, amount, d.isoformat(), str(data.get("note", "")).strip()


@app.post("/api/income")
def income_create():
    try:
        vals = clean_income(request.get_json(force=True) or {})
    except ValueError as e:
        return bad(str(e))
    cur = db().execute("INSERT INTO income (earner, amount, deposit_date, note) VALUES (?,?,?,?)", vals)
    db().commit()
    return jsonify(dict(db().execute("SELECT * FROM income WHERE id=?", (cur.lastrowid,)).fetchone())), 201


@app.put("/api/income/<int:iid>")
def income_update(iid):
    try:
        vals = clean_income(request.get_json(force=True) or {})
    except ValueError as e:
        return bad(str(e))
    db().execute("UPDATE income SET earner=?, amount=?, deposit_date=?, note=? WHERE id=?", (*vals, iid))
    db().commit()
    return jsonify(dict(db().execute("SELECT * FROM income WHERE id=?", (iid,)).fetchone()))


@app.delete("/api/income/<int:iid>")
def income_delete(iid):
    db().execute("DELETE FROM income WHERE id=?", (iid,))
    db().commit()
    return "", 204


@app.post("/api/payments")
def payments_create():
    data = request.get_json(force=True) or {}
    try:
        bill_id = int(data["bill_id"])
        due = parse_date(data["due_date"]).isoformat()
        paid_on = parse_date(data.get("paid_on"), date.today()).isoformat()
    except (KeyError, TypeError, ValueError):
        return bad("A bill and due date are required.")
    bill = db().execute("SELECT amount FROM bills WHERE id=?", (bill_id,)).fetchone()
    if not bill:
        return bad("Bill not found.", 404)
    amount = round(float(data.get("amount", bill["amount"])), 2)
    db().execute(
        "INSERT OR REPLACE INTO payments (bill_id, due_date, paid_on, amount) VALUES (?,?,?,?)",
        (bill_id, due, paid_on, amount),
    )
    db().commit()
    return jsonify({"ok": True}), 201


@app.delete("/api/payments")
def payments_delete():
    data = request.get_json(force=True) or {}
    db().execute("DELETE FROM payments WHERE bill_id=? AND due_date=?", (data.get("bill_id"), data.get("due_date")))
    db().commit()
    return "", 204


@app.get("/api/period")
def period():
    s = get_settings()
    try:
        d = parse_date(request.args.get("date"), date.today())
    except ValueError:
        return bad("Invalid date.")
    start, end = period_for(d, s)
    bills = bill_instances(start, end)
    income = rows(
        db().execute(
            "SELECT * FROM income WHERE deposit_date BETWEEN ? AND ? ORDER BY deposit_date",
            (start.isoformat(), end.isoformat()),
        )
    )
    # Unpaid, non-autopay bills from the 60 days before this period.
    today = date.today()
    look_end = min(start - timedelta(days=1), today - timedelta(days=1))
    overdue = []
    if look_end >= start - timedelta(days=60):
        overdue = [
            b for b in bill_instances(start - timedelta(days=60), look_end)
            if not b["payment"] and not b["autopay"]
        ]
    total_due = round(sum(b["amount"] for b in bills), 2)
    total_paid = round(sum((b["payment"] or {}).get("amount", 0) for b in bills), 2)
    total_income = round(sum(i["amount"] for i in income), 2)
    return jsonify({
        "start": start.isoformat(),
        "end": end.isoformat(),
        "prev": (start - timedelta(days=1)).isoformat(),
        "next": (end + timedelta(days=1)).isoformat(),
        "today": today.isoformat(),
        "bills": bills,
        "income": income,
        "overdue": overdue,
        "totals": {
            "income": total_income,
            "due": total_due,
            "paid": total_paid,
            "remaining_to_pay": round(total_due - total_paid, 2),
            "left_over": round(total_income - total_due, 2),
        },
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)

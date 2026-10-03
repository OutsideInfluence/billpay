"""Reset a user's password from the command line (for when nobody can sign in).

    docker compose exec billpay python app/reset_password.py <username>
"""
import getpass
import os
import sqlite3
import sys

from werkzeug.security import generate_password_hash

DB_PATH = os.environ.get("DB_PATH", "/data/billpay.db")

if len(sys.argv) != 2:
    sys.exit("Usage: python reset_password.py <username>")
username = sys.argv[1].strip().lower()
conn = sqlite3.connect(DB_PATH)
if not conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
    names = [r[0] for r in conn.execute("SELECT username FROM users")]
    sys.exit(f"No user named '{username}'. Existing users: {', '.join(names) or 'none'}")
pw = getpass.getpass("New password: ")
if len(pw) < 10:
    sys.exit("Passwords need at least 10 characters.")
if pw != getpass.getpass("Repeat it: "):
    sys.exit("Passwords didn't match.")
conn.execute(
    "UPDATE users SET password_hash=?, session_version=session_version+1 WHERE username=?",
    (generate_password_hash(pw), username),
)
conn.execute("DELETE FROM login_failures WHERE username=?", (username,))
conn.commit()
print(f"Password updated for {username}. All of their devices have been signed out.")

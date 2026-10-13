import sqlite3
from pathlib import Path

from flask import current_app, g

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"


def connect():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"], detect_types=sqlite3.PARSE_DECLTYPES)
        g.db.row_factory = sqlite3.Row
    return g.db


def close(_exc=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def q(sql, params=()):
    """Run one statement. Values go in `params` for the `?` placeholders, never into the SQL text."""
    conn = connect()
    cur = conn.execute(sql, params)
    conn.commit()
    return cur


def migrate():
    """Apply each numbered file in migrations/ once, in order."""
    conn = connect()
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    applied = {row[0] for row in conn.execute("SELECT name FROM schema_migrations")}
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name in applied:
            continue
        conn.executescript(f.read_text())
        conn.execute("INSERT INTO schema_migrations (name) VALUES (?)", (f.name,))
    conn.commit()

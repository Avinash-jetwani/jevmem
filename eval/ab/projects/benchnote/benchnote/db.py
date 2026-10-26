import os
import sqlite3
from pathlib import Path

from flask import Flask, current_app, g

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"


def connect() -> sqlite3.Connection:
    if "db" not in g:
        path = current_app.config["SETTINGS"].database_path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        g.db = sqlite3.connect(path)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close(_exc=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, params).fetchall()


def one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    return connect().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> int:
    conn = connect()
    cur = conn.execute(sql, params)
    conn.commit()
    return cur.lastrowid or 0


def migrate(path: str) -> None:
    """Applies migrations/*.sql in name order, once each."""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
    done = {row[0] for row in conn.execute("SELECT name FROM schema_migrations")}
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name in done:
            continue
        conn.executescript(f.read_text())
        conn.execute("INSERT INTO schema_migrations (name) VALUES (?)", (f.name,))
        conn.commit()
    conn.close()


def init_app(app: Flask) -> None:
    app.teardown_appcontext(close)
    with app.app_context():
        path = app.config["SETTINGS"].database_path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        migrate(path)

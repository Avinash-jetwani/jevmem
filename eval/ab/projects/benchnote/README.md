# benchnote

Work orders for a small repair shop (phones, laptops, e-bikes): customers, devices, the repair's status, parts used and the
invoice. Flask 3 with Jinja templates and SQLite. It runs on the counter PC from this folder.

## Layout

- `benchnote/__init__.py` builds the app (`create_app`) and registers the blueprints.
- `benchnote/routes/` has `orders.py`, `customers.py` and `parts.py`.
- `benchnote/db.py` opens the SQLite connection per request and applies `migrations/*.sql`.
- `benchnote/mail.py` sends email through the shop's SMTP account.
- `benchnote/templates/` is Jinja; `benchnote/static/app.css` is the only stylesheet.
- `tests/` is pytest with a temporary database per test.

## Commands

```
uv sync
uv run flask --app benchnote run --debug
uv run pytest
```

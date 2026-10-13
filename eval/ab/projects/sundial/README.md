# sundial

Books rooms for a small yoga studio: staff create bookings for members, see what is booked, and send reminders.

- Flask 3 with Jinja templates. Each resource has a blueprint in `sundial/routes/` and its templates in `sundial/templates/<resource>/`.
- SQLite, through `q()` in `sundial/db.py`. Schema changes are numbered files in `migrations/`, applied once each at start-up.
- Strings shown to people come from `sundial/locales/en.json` through `t()`; `de.json` and `fr.json` are filled by the translation vendor's sync.
- Tunable values are in `config/defaults.toml` and read with `settings.get("name")`; a host overrides them in `config/local.toml`.

```
pip install -e .
flask --app sundial run
flask --app sundial send-outbox   # sends the queued emails (run from cron on the host)
pytest
```

import os

from flask import Flask

from . import db, mail
from .dates import fmt_date, fmt_time
from .i18n import t
from .routes.bookings import bp as bookings_bp
from .routes.rooms import bp as rooms_bp


def create_app(database="sundial.db"):
    app = Flask(__name__)
    app.config["DATABASE"] = database
    app.config["SECRET_KEY"] = os.environ.get("SUNDIAL_SECRET", "dev")
    app.register_blueprint(bookings_bp)
    app.register_blueprint(rooms_bp)
    # Templates call these directly: {{ t('key') }}, {{ fmt_date(value) }}.
    app.jinja_env.globals.update(t=t, fmt_date=fmt_date, fmt_time=fmt_time)
    app.teardown_appcontext(db.close)
    with app.app_context():
        db.migrate()

    @app.cli.command("send-outbox")
    def send_outbox():
        """Send the emails queued in the outbox table (run from cron on the host)."""
        sent = mail.send_outbox()
        print(f"sent {sent} email(s)")

    return app

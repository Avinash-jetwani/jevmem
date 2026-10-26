from flask import Flask

from . import db
from .routes import customers, orders, parts
from .settings import Settings


def create_app(settings: Settings | None = None) -> Flask:
    app = Flask(__name__)
    app.config["SETTINGS"] = settings or Settings.from_env()
    app.config["SECRET_KEY"] = app.config["SETTINGS"].secret_key
    db.init_app(app)
    app.register_blueprint(orders.bp)
    app.register_blueprint(customers.bp)
    app.register_blueprint(parts.bp)

    @app.get("/")
    def home():
        return orders.list_orders()

    return app

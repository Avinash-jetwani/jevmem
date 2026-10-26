import pytest

from benchnote import create_app
from benchnote.settings import Settings


@pytest.fixture
def app(tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "test.sqlite"),
        secret_key="test",
        staff_email="counter@example.test",
        mail_from="shop@example.test",
        smtp_host="localhost",
        smtp_port=2525,
    )
    app = create_app(settings)
    app.testing = True
    return app


@pytest.fixture
def client(app):
    return app.test_client()

import pytest

from sundial import create_app, mail


@pytest.fixture
def app(tmp_path, monkeypatch):
    # No SMTP in tests: sending is a no-op; the outbox table is real.
    monkeypatch.setattr(mail, "send", lambda to, subject, body: None)
    app = create_app(database=str(tmp_path / "test.db"))
    app.config["TESTING"] = True
    return app


@pytest.fixture
def client(app):
    return app.test_client()

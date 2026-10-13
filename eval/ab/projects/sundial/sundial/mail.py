import smtplib
from email.message import EmailMessage

from . import settings
from .db import q


def send(to, subject, body):
    """Send one email now, over SMTP. The provider answers in one to three seconds."""
    msg = EmailMessage()
    msg["To"] = to
    msg["From"] = settings.get("mail_from")
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.get("smtp_host"), timeout=10) as smtp:
        smtp.send_message(msg)


def enqueue(to, subject, body):
    """Queue an email in the outbox table; `flask send-outbox` sends what is queued."""
    q("INSERT INTO outbox (to_address, subject, body) VALUES (?, ?, ?)", (to, subject, body))


def send_outbox():
    rows = q("SELECT id, to_address, subject, body FROM outbox WHERE sent_at IS NULL ORDER BY id").fetchall()
    for row in rows:
        send(row["to_address"], row["subject"], row["body"])
        q("UPDATE outbox SET sent_at = CURRENT_TIMESTAMP WHERE id = ?", (row["id"],))
    return len(rows)

import logging
import smtplib
from email.message import EmailMessage

from flask import current_app

log = logging.getLogger("benchnote.mail")


def send_mail(to: str, subject: str, body: str) -> None:
    """Sends a plain-text email through the shop's SMTP account."""
    settings = current_app.config["SETTINGS"]
    msg = EmailMessage()
    msg["From"] = settings.mail_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    if current_app.testing:
        current_app.config.setdefault("SENT_MAIL", []).append(msg)
        return
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as smtp:
        smtp.send_message(msg)
    log.info("mail sent to %s: %s", to, subject)

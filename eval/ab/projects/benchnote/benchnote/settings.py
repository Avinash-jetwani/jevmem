import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    database_path: str
    secret_key: str
    staff_email: str
    mail_from: str
    smtp_host: str
    smtp_port: int

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        return cls(
            database_path=os.environ.get("BENCHNOTE_DB", "instance/benchnote.sqlite"),
            secret_key=os.environ.get("BENCHNOTE_SECRET", "dev-only"),
            staff_email=os.environ.get("STAFF_EMAIL", "counter@benchnote.example"),
            mail_from=os.environ.get("MAIL_FROM", "shop@benchnote.example"),
            smtp_host=os.environ.get("SMTP_HOST", "localhost"),
            smtp_port=int(os.environ.get("SMTP_PORT", "25")),
        )

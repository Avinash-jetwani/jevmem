from datetime import datetime
from zoneinfo import ZoneInfo

from . import settings


def _local(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo(settings.get("studio_tz")))
    return value.astimezone(ZoneInfo(settings.get("studio_tz")))


def fmt_date(value):
    """A date as the studio shows it: 14 Oct 2026. The one place a date is formatted."""
    return _local(value).strftime("%-d %b %Y")


def fmt_time(value):
    """A time as the studio shows it: 18:30."""
    return _local(value).strftime("%H:%M")

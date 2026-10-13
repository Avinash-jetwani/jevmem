import json
from pathlib import Path

LOCALES = Path(__file__).resolve().parent / "locales"
_cache = {}


def strings(lang="en"):
    if lang not in _cache:
        _cache[lang] = json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf-8"))
    return _cache[lang]


def t(key, lang="en", **values):
    """The string shown to people for `key`, from sundial/locales/<lang>.json, English as the fallback."""
    text = strings(lang).get(key) or strings("en").get(key) or key
    return text.format(**values) if values else text

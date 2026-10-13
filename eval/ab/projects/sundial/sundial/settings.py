import tomllib
from pathlib import Path

DEFAULTS = Path(__file__).resolve().parent.parent / "config" / "defaults.toml"
_values = None


def get(name):
    """A tunable value from config/defaults.toml, or the host's config/local.toml when it overrides it."""
    global _values
    if _values is None:
        _values = tomllib.loads(DEFAULTS.read_text(encoding="utf-8"))
        local = DEFAULTS.with_name("local.toml")
        if local.exists():
            _values.update(tomllib.loads(local.read_text(encoding="utf-8")))
    return _values[name]

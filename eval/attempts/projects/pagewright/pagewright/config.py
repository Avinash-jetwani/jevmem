"""Site configuration: a JSON file mapped onto the Config dataclass."""

import json
import os
from dataclasses import dataclass, field, fields
from typing import List, Optional, Union, get_args, get_origin, get_type_hints


class ConfigError(ValueError):
    """The config file is missing a rule it has to follow."""


@dataclass
class Config:
    title: str = "Untitled site"
    base_url: str = "/"
    content_dir: str = "content"
    output_dir: str = "public"
    template: Optional[str] = None
    index_limit: Optional[int] = None
    nav: List[str] = field(default_factory=list)
    root: str = "."


def _matches(value, hint):
    origin = get_origin(hint)
    if origin is Union:
        return any(_matches(value, arg) for arg in get_args(hint))
    if origin is list:
        (item_hint,) = get_args(hint)
        return isinstance(value, list) and all(_matches(v, item_hint) for v in value)
    if hint is int:
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, hint)


def _describe(hint):
    origin = get_origin(hint)
    if origin is Union:
        names = [_describe(arg) for arg in get_args(hint)]
        return " or ".join(names)
    if origin is list:
        (item_hint,) = get_args(hint)
        return "a list of " + _describe(item_hint)
    if hint is type(None):
        return "null"
    return hint.__name__


def load_config(path):
    """Read the JSON file at `path` and return a checked Config."""
    with open(path, encoding="utf-8") as handle:
        try:
            raw = json.load(handle)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"{path}: not valid JSON ({exc.msg}, line {exc.lineno})")
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: the top level has to be an object")

    hints = get_type_hints(Config)
    settable = {f.name for f in fields(Config)} - {"root"}
    for key, value in raw.items():
        if key not in settable:
            raise ConfigError(f"{path}: unknown setting {key!r}")
        if not _matches(value, hints[key]):
            raise ConfigError(f"{path}: {key} has to be {_describe(hints[key])}")
    return Config(root=os.path.dirname(os.path.abspath(path)), **raw)

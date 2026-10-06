"""Turn a title into a URL slug."""
import re
import unicodedata

# Latin letters with diacritics, ligatures and a few signs, each with its replacement.
_FOLDS = (
    ("à", "a"), ("á", "a"), ("â", "a"), ("ã", "a"), ("ä", "a"), ("å", "a"),
    ("ā", "a"), ("ą", "a"), ("æ", "ae"), ("ç", "c"), ("ć", "c"), ("č", "c"),
    ("ď", "d"), ("đ", "d"), ("è", "e"), ("é", "e"), ("ê", "e"), ("ë", "e"),
    ("ē", "e"), ("ę", "e"), ("ě", "e"), ("ğ", "g"), ("ì", "i"), ("í", "i"),
    ("î", "i"), ("ï", "i"), ("ī", "i"), ("ı", "i"), ("ł", "l"), ("ñ", "n"),
    ("ń", "n"), ("ň", "n"), ("ò", "o"), ("ó", "o"), ("ô", "o"), ("õ", "o"),
    ("ö", "o"), ("ø", "o"), ("ő", "o"), ("œ", "oe"), ("ř", "r"), ("ś", "s"),
    ("š", "s"), ("ş", "s"), ("ß", "ss"), ("ť", "t"), ("þ", "th"), ("ù", "u"),
    ("ú", "u"), ("û", "u"), ("ü", "u"), ("ū", "u"), ("ů", "u"), ("ű", "u"),
    ("ý", "y"), ("ÿ", "y"), ("ź", "z"), ("ż", "z"), ("ž", "z"),
    ("'", ""), ("’", ""), ("&", " and "),
)

_SEPARATORS = re.compile(r"[\W_]+")


def _fold(text):
    """Replace every character listed in _FOLDS."""
    for old, new in _FOLDS:
        text = text.replace(old, new)
    return text


def slugify(text, max_length=60):
    """Return a lower-case, hyphen-separated slug of at most max_length characters."""
    text = unicodedata.normalize("NFC", text).lower()
    text = _fold(text)
    slug = _SEPARATORS.sub("-", text).strip("-")
    if len(slug) > max_length:
        slug = slug[:max_length]
    return slug

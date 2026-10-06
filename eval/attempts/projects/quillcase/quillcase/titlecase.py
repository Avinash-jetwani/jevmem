"""Title-case a headline."""

# Words that stay lower-case inside a headline.
_SMALL = frozenset((
    "a", "an", "and", "as", "at", "but", "by", "for", "if", "in",
    "nor", "of", "on", "or", "per", "the", "to", "via", "vs",
))

_EDGE_PUNCTUATION = ".,;:!?\"'()"


def _capitalize(part):
    """Upper-case the first letter of part, leaving the rest as it is."""
    for i, ch in enumerate(part):
        if ch.isalpha():
            return part[:i] + ch.upper() + part[i + 1:]
    return part


def title_case(text):
    """Return text as a headline; small words stay lower-case unless they open or close it."""
    words = text.split()
    out = []
    for i, word in enumerate(words):
        lower = word.lower()
        at_edge = i == 0 or i == len(words) - 1
        after_colon = i > 0 and words[i - 1].endswith(":")
        if any(ch.isupper() for ch in word[1:]):
            out.append(word)
        elif lower.strip(_EDGE_PUNCTUATION) in _SMALL and not (at_edge or after_colon):
            out.append(lower)
        else:
            out.append("-".join(_capitalize(part) for part in lower.split("-")))
    return " ".join(out)

"""Word-wrap text by the number of terminal columns it takes."""
import unicodedata
from bisect import bisect_right

# Inclusive code point ranges whose characters take two columns.
_WIDE = (
    (0x1100, 0x115F),    # Hangul initial consonants
    (0x2E80, 0x303E),    # CJK radicals, symbols and punctuation
    (0x3041, 0x33FF),    # kana, bopomofo, enclosed and compatibility CJK
    (0x3400, 0x4DBF),    # CJK extension A
    (0x4E00, 0x9FFF),    # CJK unified ideographs
    (0xA000, 0xA4CF),    # Yi
    (0xAC00, 0xD7A3),    # Hangul syllables
    (0xF900, 0xFAFF),    # CJK compatibility ideographs
    (0xFE30, 0xFE4F),    # CJK compatibility forms
    (0xFF00, 0xFF60),    # fullwidth forms
    (0xFFE0, 0xFFE6),    # fullwidth signs
    (0x1F300, 0x1F64F),  # pictographs and emoticons
    (0x1F900, 0x1F9FF),  # supplemental pictographs
    (0x20000, 0x3FFFD),  # CJK extension B and later
)
_STARTS = [first for first, _ in _WIDE]


def _char_width(ch):
    """Return how many columns ch takes: 0, 1 or 2."""
    if unicodedata.combining(ch):
        return 0
    code = ord(ch)
    i = bisect_right(_STARTS, code) - 1
    if i >= 0 and code <= _WIDE[i][1]:
        return 2
    return 1


def display_width(text):
    """Return how many columns text takes."""
    return sum(_char_width(ch) for ch in text)


def _atoms(word):
    """Split word into pieces a line may end after: each wide character, each run of the rest."""
    atoms, run = [], ""
    for ch in word:
        width = _char_width(ch)
        if width == 2:
            if run:
                atoms.append(run)
                run = ""
            atoms.append(ch)
        elif width == 0 and atoms and not run:
            atoms[-1] += ch
        else:
            run += ch
    if run:
        atoms.append(run)
    return atoms


def _take(atom, room):
    """Return the longest start of atom that fits in room columns, and what is left of it."""
    used = 0
    for i, ch in enumerate(atom):
        used += _char_width(ch)
        if used > room:
            return atom[:i], atom[i:]
    return atom, ""


def wrap(text, width=80):
    """Return text as a list of lines, none wider than width columns."""
    if width < 2:
        raise ValueError("width must be at least 2")
    lines = []
    for paragraph in text.split("\n"):
        line, used = "", 0
        for word in paragraph.split():
            gap = 1 if line else 0
            for atom in _atoms(word):
                need = display_width(atom)
                while need > width:
                    head, atom = _take(atom, width - used - gap)
                    if head:
                        line += " " * gap + head
                    lines.append(line)
                    line, used, gap = "", 0, 0
                    need = display_width(atom)
                if line and used + gap + need > width:
                    lines.append(line)
                    line, used, gap = "", 0, 0
                line += " " * gap + atom
                used += gap + need
                gap = 0
        lines.append(line)
    return lines

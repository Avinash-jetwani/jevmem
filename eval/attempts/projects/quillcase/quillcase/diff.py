"""Line diff from a longest-common-subsequence table."""


def _lcs_table(a, b):
    """Return table where table[i][j] is the LCS length of a[:i] and b[:j]."""
    table = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i, line in enumerate(a, 1):
        row, above = table[i], table[i - 1]
        for j, other in enumerate(b, 1):
            if line == other:
                row[j] = above[j - 1] + 1
            elif above[j] >= row[j - 1]:
                row[j] = above[j]
            else:
                row[j] = row[j - 1]
    return table


def diff_lines(a, b):
    """Return (tag, line) pairs that turn a into b; tag is ' ', '-' or '+'."""
    table = _lcs_table(a, b)
    ops = []
    i, j = len(a), len(b)
    while i > 0 or j > 0:
        if i > 0 and j > 0 and a[i - 1] == b[j - 1]:
            ops.insert(0, (" ", a[i - 1]))
            i -= 1
            j -= 1
        elif j > 0 and (i == 0 or table[i][j - 1] >= table[i - 1][j]):
            ops.insert(0, ("+", b[j - 1]))
            j -= 1
        else:
            ops.insert(0, ("-", a[i - 1]))
            i -= 1
    return ops


def stats(ops):
    """Return (kept, removed, added) line counts for ops."""
    kept = removed = added = 0
    for tag, _ in ops:
        if tag == " ":
            kept += 1
        elif tag == "-":
            removed += 1
        elif tag == "+":
            added += 1
        else:
            raise ValueError("unknown tag: %r" % (tag,))
    return kept, removed, added


def hunks(ops, context=2):
    """Return (start, stop) slices of ops covering each change and context lines around it."""
    changed = [i for i, (tag, _) in enumerate(ops) if tag != " "]
    if not changed:
        return []
    spans = [[changed[0], changed[0]]]
    for prev, cur in zip(changed, changed[1:]):
        if cur - prev > 2 * context + 1:
            spans.append([cur, cur])
        else:
            spans[-1][1] = cur
    return [(max(first - context, 0), min(last + context + 1, len(ops))) for first, last in spans]


def format_ops(ops, context=None):
    """Return ops as text lines; with context, only the hunks, with '...' between them."""
    if context is None:
        return [tag + " " + line for tag, line in ops]
    out = []
    for start, stop in hunks(ops, context):
        if out:
            out.append("...")
        out.extend(tag + " " + line for tag, line in ops[start:stop])
    return out

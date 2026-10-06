// Helpers that work on the entries parseLedger returns.

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "food:*" -> a test for category names. "*" stands for any run of characters;
// everything else is matched literally.
export function categoryMatcher(glob) {
  const source = glob.split('*').map(escapeRegExp).join('.*');
  const pattern = new RegExp(`^${source}$`);
  return (category) => pattern.test(category);
}

// A copy of the entries that can be changed without touching the originals.
export function snapshot(entries) {
  return entries.map((entry) => ({ ...entry }));
}

// renames: Map of old category -> new category. Returns renamed copies.
export function renameCategories(entries, renames) {
  const copies = snapshot(entries);
  for (const entry of copies) {
    const renamed = renames.get(entry.category);
    if (renamed !== undefined) entry.category = renamed;
  }
  return copies;
}

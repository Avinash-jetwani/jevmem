/** Merges the feeds' events: de-duplicated by UID (the first feed wins), sorted by start, each tagged with its feed. */
export function mergeFeeds(feeds) {
  const seen = new Set();
  const events = [];
  for (const feed of feeds) {
    for (const e of feed.events) {
      const key = e.uid ?? `${feed.source}#${events.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ ...e, feed: feed.name ?? feed.source });
    }
  }
  events.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  return events;
}

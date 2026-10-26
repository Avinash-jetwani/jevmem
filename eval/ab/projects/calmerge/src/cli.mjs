import { readFeed } from "./fetch.mjs";
import { parseIcs } from "./ics.mjs";
import { mergeFeeds } from "./merge.mjs";
import { listing } from "./output.mjs";

const USAGE = `usage: calmerge [--name <calendar name>] <feed>...
  <feed>   an http(s) URL or a path to an .ics file`;

/** Parses the arguments: feeds (positional) and options. Returns { error } for bad usage. */
export function parseArgs(argv) {
  const opts = { name: "calmerge", feeds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") {
      if (!argv[i + 1]) return { error: "--name needs a value" };
      opts.name = argv[++i];
    } else if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      return { error: `unknown option ${a}` };
    } else {
      opts.feeds.push(a);
    }
  }
  if (!opts.help && opts.feeds.length === 0) return { error: "at least one feed is needed" };
  return opts;
}

/** Runs the tool; returns the exit status. */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`calmerge: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const feeds = [];
  for (const source of opts.feeds) {
    const text = await readFeed(source);
    feeds.push({ source, ...parseIcs(text) });
  }
  const events = mergeFeeds(feeds);
  process.stdout.write(listing(events));
  return 0;
}

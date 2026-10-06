#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './config.js';

const USAGE = `usage: relaydesk <command>

  enqueue <type> [json-payload] [--delay ms] [--max-attempts n]
  claim [--lease ms] [--worker name]
  done <id>
  fail <id> [reason]
  work <handlers.js>
  list
  stats
  snapshot <name>`;

export function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > -1) opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    else opts[arg.slice(2)] = argv[++i];
  }
  return { args, opts };
}

export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export async function main(argv, out = console.log) {
  const [command, ...rest] = argv;
  const { args, opts } = parseArgs(rest);
  loadEnv();
  const queue = await import('./queue.js');

  switch (command) {
    case 'enqueue': {
      const [type, payload] = args;
      const job = queue.enqueue(type, payload === undefined ? null : JSON.parse(payload), {
        delayMs: opts.delay ?? 0,
        maxAttempts: opts['max-attempts'] === undefined ? undefined : Number(opts['max-attempts']),
      });
      out(job.id);
      return 0;
    }
    case 'claim': {
      const job = queue.claim({
        worker: opts.worker,
        leaseMs: opts.lease === undefined ? undefined : Number(opts.lease),
      });
      out(job ? JSON.stringify(job, null, 2) : 'nothing ready');
      return 0;
    }
    case 'done':
      out(queue.complete(args[0]).state);
      return 0;
    case 'fail':
      out(queue.fail(args[0], args[1]).state);
      return 0;
    case 'work': {
      const { drain } = await import('./worker.js');
      const mod = await import(pathToFileURL(path.resolve(args[0])).href);
      const finished = await drain(mod.default ?? mod);
      out(`ran ${finished.length} job(s)`);
      return 0;
    }
    case 'list': {
      const now = Date.now();
      for (const job of queue.list()) {
        const tries = `${job.attempts}/${job.maxAttempts}`;
        out([job.id, job.type, job.state, tries, formatAge(now - job.createdAt)].join('  '));
      }
      return 0;
    }
    case 'stats':
      out(JSON.stringify(queue.stats()));
      return 0;
    case 'snapshot': {
      const store = await import('./store.js');
      out(store.snapshot(args[0]));
      return 0;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`relaydesk: ${err.message}`);
    process.exitCode = 1;
  }
}

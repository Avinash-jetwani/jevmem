import { claim, complete, fail } from './queue.js';

// Calls fn and always hands back a promise, also when fn throws before returning one.
function attempt(fn) {
  return new Promise((resolve) => resolve(fn()));
}

function deadline(ms) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Runs the handler for one claimed job and records the outcome in the queue.
export async function runJob(job, handlers, { timeoutMs = 0 } = {}) {
  const handler = handlers[job.type];
  if (typeof handler !== 'function') return fail(job.id, `no handler for type ${job.type}`);
  const limit = timeoutMs > 0 ? deadline(timeoutMs) : null;
  try {
    const work = attempt(() => handler(job.payload, job));
    const result = await (limit ? Promise.race([work, limit.promise]) : work);
    return complete(job.id, result ?? null);
  } catch (err) {
    return fail(job.id, err instanceof Error ? err.message : String(err));
  } finally {
    limit?.cancel();
  }
}

// Claims and runs jobs until nothing is ready. Returns the jobs as they ended up.
export async function drain(handlers, options = {}) {
  const finished = [];
  for (;;) {
    const job = claim(options);
    if (!job) return finished;
    finished.push(await runJob(job, handlers, options));
  }
}

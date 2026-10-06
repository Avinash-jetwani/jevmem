import fs from 'node:fs';

const cell = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(cell, 0, 0, ms);
}

function abandoned(lockPath, staleMs) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

// Takes an exclusive lock by creating lockPath and returns the function that releases it.
// Waits for another holder, and takes over a lock file older than staleMs.
export function acquire(lockPath, { waitMs = 5, timeoutMs = 2_000, staleMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (abandoned(lockPath, staleMs)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockPath}`);
    sleep(waitMs);
  }
}

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DomainError } from '../src/types.ts';
import { WriterLock } from '../src/writer-lock.ts';

const executeFile = promisify(execFile);
const lockModule = new URL('../src/writer-lock.ts', import.meta.url).href;
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

function expectBusy(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof DomainError
    && error.code === 'writer_busy'
    && error.statusCode === 409);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolveExit());
  });
}

function startHolder(path: string): { child: ChildProcess; ready: Promise<void> } {
  const readyPath = `${path}.ready`;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { WriterLock } from ${JSON.stringify(lockModule)};
    const lock = new WriterLock(${JSON.stringify(path)});
    writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    const timeout = setTimeout(() => { lock.close(); process.exit(0); }, 20000);
    process.on('SIGTERM', () => { clearTimeout(timeout); lock.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnvironment,
    stdio: 'ignore',
  });
  let launchError: Error | null = null;
  child.once('error', (error) => { launchError = error; });
  const ready = (async () => {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath)) {
      if (launchError !== null) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Lock holder exited before acquiring its lock.');
      if (Date.now() >= deadline) throw new Error('Lock holder did not signal readiness.');
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  })();
  return { child, ready };
}

test('one writer per journal, idempotent close, persistent sidecar', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-writer-'));
  const path = join(directory, 'journal.sqlite');
  const first = new WriterLock(path);
  try {
    expectBusy(() => new WriterLock(path));
    first.close();
    first.close();
    assert.ok(existsSync(`${path}.writer-lock.sqlite`));
    const next = new WriterLock(path);
    try { expectBusy(() => new WriterLock(path)); } finally { next.close(); }
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('separate journals do not share a writer lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-writer-'));
  const first = new WriterLock(join(directory, 'first.sqlite'));
  const second = new WriterLock(join(directory, 'second.sqlite'));
  try {
    expectBusy(() => new WriterLock(join(directory, 'first.sqlite')));
    expectBusy(() => new WriterLock(join(directory, 'second.sqlite')));
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('journal symlinks resolve to the same writer lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-writer-'));
  const path = join(directory, 'journal.sqlite');
  const alias = join(directory, 'alias.sqlite');
  writeFileSync(path, '');
  symlinkSync(path, alias);
  const first = new WriterLock(path);
  try {
    expectBusy(() => new WriterLock(alias));
    assert.equal(existsSync(`${alias}.writer-lock.sqlite`), false);
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real process contention and SIGKILL recovery preserve the lock file', { timeout: 10000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-writer-process-'));
  const path = join(directory, 'journal.sqlite');
  const { child, ready } = startHolder(path);
  let recovered: WriterLock | null = null;
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child);
    recovered?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await ready;
  expectBusy(() => new WriterLock(path));

  const resultPath = `${path}.contender-result`;
  const contender = `
    import { writeFileSync } from 'node:fs';
    import { WriterLock } from ${JSON.stringify(lockModule)};
    try {
      const lock = new WriterLock(${JSON.stringify(path)});
      lock.close();
      writeFileSync(${JSON.stringify(resultPath)}, 'unexpectedly_acquired');
    } catch (error) {
      writeFileSync(${JSON.stringify(resultPath)}, error.code || 'unexpected_error');
    }
  `;
  await executeFile(process.execPath, ['--input-type=module', '--eval', contender], {
    env: childEnvironment,
    timeout: 5000,
  });
  assert.equal(readFileSync(resultPath, 'utf8'), 'writer_busy');

  child.kill('SIGKILL');
  await waitForExit(child);
  assert.ok(existsSync(`${path}.writer-lock.sqlite`));
  recovered = new WriterLock(path);
  expectBusy(() => new WriterLock(path));
});

test('in-memory journals cannot claim process exclusion', () => {
  assert.throws(() => new WriterLock(':memory:'), (error: unknown) => error instanceof DomainError
    && error.code === 'invalid_journal_path');
});

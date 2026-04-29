/**
 * Bug 9 regression — sync silently drops files with broken YAML.
 *
 * Before the fix, sync.ts caught per-file parse errors, printed a warning,
 * and still advanced sync.last_commit. The failed file was never retried
 * because it was behind the bookmark. Silent data loss.
 *
 * After the fix:
 *   - failures append to ~/.gbrain/sync-failures.jsonl (with dedup)
 *   - incremental + full-sync + import git-continuity paths gate the
 *     sync.last_commit advance on "no failures"
 *   - `gbrain sync --skip-failed` acknowledges the current set
 *   - `gbrain doctor` surfaces unacknowledged failures
 *
 * This suite exercises the helper + the dedup behavior. The full CLI
 * round-trip is covered by E2E tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Point HOME at a tmpdir so we don't stomp the real ~/.gbrain/sync-failures.jsonl
let tmpHome: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-sync-failures-'));
  process.env.HOME = tmpHome;
  // Belt-and-suspenders: explicitly clear the jsonl at the resolved path.
  const { syncFailuresPath } = await import('../src/core/sync.ts');
  try { rmSync(syncFailuresPath(), { force: true }); } catch { /* none */ }
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Bug 9 — sync-failures JSONL helpers', () => {
  test('recordSyncFailures appends one line per failure with dedup', async () => {
    const { recordSyncFailures, loadSyncFailures, syncFailuresPath } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
      { path: 'notes/broken.md', error: 'YAML: duplicated key' },
    ], 'abc123def456');

    expect(existsSync(syncFailuresPath())).toBe(true);
    const entries = loadSyncFailures();
    expect(entries.length).toBe(2);
    expect(entries[0].path).toBe('people/alice.md');
    expect(entries[0].commit).toBe('abc123def456');
    expect(entries[0].acknowledged).toBeUndefined();

    // Same failure on same commit should NOT re-append.
    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
    ], 'abc123def456');
    expect(loadSyncFailures().length).toBe(2);

    // Different commit → new entry.
    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
    ], 'zzz999');
    expect(loadSyncFailures().length).toBe(3);
  });

  test('acknowledgeSyncFailures marks unacked entries, leaves acked alone', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'a.md', error: 'err1' },
      { path: 'b.md', error: 'err2' },
    ], 'commit1');

    const result = acknowledgeSyncFailures();
    expect(result.count).toBe(2);
    expect(result.summary.length).toBeGreaterThan(0);
    const after = loadSyncFailures();
    expect(after.every(e => e.acknowledged === true)).toBe(true);
    expect(after.every(e => typeof e.acknowledged_at === 'string')).toBe(true);

    // Second ack: nothing new to mark.
    expect(acknowledgeSyncFailures().count).toBe(0);

    // Adding a fresh failure then ack: only the new one flips.
    recordSyncFailures([{ path: 'c.md', error: 'err3' }], 'commit2');
    expect(acknowledgeSyncFailures().count).toBe(1);
    expect(loadSyncFailures().length).toBe(3);
    expect(loadSyncFailures().every(e => e.acknowledged === true)).toBe(true);
  });

  test('unacknowledgedSyncFailures filters correctly', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures, unacknowledgedSyncFailures } = await import('../src/core/sync.ts');

    recordSyncFailures([{ path: 'a.md', error: 'err1' }], 'c1');
    acknowledgeSyncFailures();
    recordSyncFailures([{ path: 'b.md', error: 'err2' }], 'c2');

    const unacked = unacknowledgedSyncFailures();
    expect(unacked.length).toBe(1);
    expect(unacked[0].path).toBe('b.md');
  });

  test('loadSyncFailures returns [] when file is missing', async () => {
    const { loadSyncFailures } = await import('../src/core/sync.ts');
    expect(loadSyncFailures()).toEqual([]);
  });

  test('loadSyncFailures tolerates malformed lines', async () => {
    const { loadSyncFailures, syncFailuresPath, recordSyncFailures } = await import('../src/core/sync.ts');
    // Seed one valid entry.
    recordSyncFailures([{ path: 'a.md', error: 'err1' }], 'c1');
    // Append garbage.
    writeFileSync(syncFailuresPath(), readFileSync(syncFailuresPath(), 'utf-8') + 'NOT-JSON\n', { flag: 'w' });
    const out = loadSyncFailures();
    expect(out.length).toBe(1);
    expect(out[0].path).toBe('a.md');
  });
});

describe('Bug 9 — doctor surfaces sync failures', () => {
  test('doctor source contains sync_failures check', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('sync_failures');
    expect(source).toContain('unacknowledgedSyncFailures');
    expect(source).toContain("'gbrain sync --skip-failed'");
  });
});

describe('Bug 9 — sync.ts CLI flag wiring', () => {
  test('runSync parses --skip-failed and --retry-failed flags', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    expect(source).toContain("args.includes('--skip-failed')");
    expect(source).toContain("args.includes('--retry-failed')");
    expect(source).toContain('skipFailed');
    expect(source).toContain('retryFailed');
  });

  test('performSync gates sync.last_commit on failedFiles.length', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    // The gate exists and references the failure set.
    expect(source).toContain('failedFiles.length > 0');
    expect(source).toContain('blocked_by_failures');
  });

  test('performFullSync gates on result.failures from runImport', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    expect(source).toContain('result.failures.length > 0');
  });

  test('runImport returns RunImportResult with failures list', async () => {
    const source = await Bun.file(new URL('../src/commands/import.ts', import.meta.url)).text();
    expect(source).toContain('RunImportResult');
    expect(source).toContain('failures: Array<{ path: string; error: string }>');
    expect(source).toContain('recordSyncFailures');
  });
});

describe('classifyErrorCode — error message to code mapping', () => {
  test('classifies SLUG_MISMATCH from error message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'Frontmatter slug "my-friend-mike" does not match path-derived slug "2008-03-20-my-friend-mike"'
    )).toBe('SLUG_MISMATCH');
  });

  test('classifies YAML_PARSE from error message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('YAML parse failed: unexpected colon in title')).toBe('YAML_PARSE');
  });

  test('classifies YAML_DUPLICATE_KEY', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('YAMLException: duplicated mapping key')).toBe('YAML_DUPLICATE_KEY');
  });

  test('classifies STATEMENT_TIMEOUT', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('canceling statement due to statement timeout')).toBe('STATEMENT_TIMEOUT');
  });

  test('classifies NULL_BYTES', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('invalid UTF-8: null byte at position 3770')).toBe('NULL_BYTES');
  });

  test('classifies INVALID_UTF8', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('invalid UTF-8 sequence at position 500')).toBe('INVALID_UTF8');
  });

  test('classifies MISSING_OPEN from real validator messages', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Frontmatter must start with --- on the first non-empty line')).toBe('MISSING_OPEN');
    expect(classifyErrorCode('File is empty or whitespace-only; expected frontmatter starting with ---')).toBe('MISSING_OPEN');
  });

  test('classifies MISSING_CLOSE from real validator messages', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('No closing --- delimiter found')).toBe('MISSING_CLOSE');
    expect(classifyErrorCode('No closing --- before heading at line 12')).toBe('MISSING_CLOSE');
    expect(classifyErrorCode('Heading at line 5 found inside frontmatter zone (closing --- comes after)')).toBe('MISSING_CLOSE');
  });

  test('classifies NESTED_QUOTES from validator message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Nested double quotes in YAML value (use single quotes for the outer)')).toBe('NESTED_QUOTES');
  });

  test('classifies EMPTY_FRONTMATTER from validator message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Frontmatter block is empty')).toBe('EMPTY_FRONTMATTER');
  });

  test('classifies FILE_TOO_LARGE across all three production sites', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    // src/core/import-file.ts:352 — OS-level file size on disk
    expect(classifyErrorCode('File too large (8432105 bytes)')).toBe('FILE_TOO_LARGE');
    // src/core/import-file.ts:199 — content size limit (5MB cap)
    expect(classifyErrorCode('Content too large (6000000 bytes, max 5000000). Split the content into smaller files or remove large embedded assets.')).toBe('FILE_TOO_LARGE');
    // src/core/import-file.ts:401 — code file size cap
    expect(classifyErrorCode('Code file too large (8000000 bytes)')).toBe('FILE_TOO_LARGE');
  });

  test('classifies SYMLINK_NOT_ALLOWED from import-file.ts symlink rejection', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Skipping symlink: /path/to/link.md')).toBe('SYMLINK_NOT_ALLOWED');
  });

  test('returns UNKNOWN for unrecognized errors', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('something completely different')).toBe('UNKNOWN');
  });
});

describe('summarizeFailuresByCode — grouped summary', () => {
  test('groups failures by classified code', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    const summary = summarizeFailuresByCode([
      { error: 'Frontmatter slug "a" does not match path-derived slug "b"' },
      { error: 'Frontmatter slug "c" does not match path-derived slug "d"' },
      { error: 'YAML parse failed: bad colon' },
      { error: 'something unknown' },
    ]);
    expect(summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
      { code: 'UNKNOWN', count: 1 },
    ]);
  });

  test('respects pre-classified code field', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    const summary = summarizeFailuresByCode([
      { error: 'anything', code: 'SLUG_MISMATCH' },
      { error: 'anything', code: 'SLUG_MISMATCH' },
      { error: 'anything', code: 'YAML_PARSE' },
    ]);
    expect(summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
    ]);
  });

  test('returns empty array for no failures', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    expect(summarizeFailuresByCode([])).toEqual([]);
  });
});

describe('acknowledgeSyncFailures — structured return', () => {
  test('returns count and code summary', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures } = await import('../src/core/sync.ts');
    recordSyncFailures([
      { path: 'a.md', error: 'Frontmatter slug "x" does not match path-derived slug "y"' },
      { path: 'b.md', error: 'Frontmatter slug "p" does not match path-derived slug "q"' },
      { path: 'c.md', error: 'YAML parse failed: bad' },
    ], 'commit1');

    const result = acknowledgeSyncFailures();
    expect(result.count).toBe(3);
    expect(result.summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
    ]);
  });
});

describe('recordSyncFailures — code field', () => {
  test('records classified code alongside error message', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    recordSyncFailures([
      { path: 'a.md', error: 'Frontmatter slug "x" does not match path-derived slug "y"' },
    ], 'commit1');

    const entries = loadSyncFailures();
    expect(entries[0].code).toBe('SLUG_MISMATCH');
  });
});

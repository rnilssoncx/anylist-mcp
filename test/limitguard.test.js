// The limit guard's two tests (068). The detector is `limitguard.mjs`; the list of what is not
// yet converted is `limitguard-todo.txt`, the registry of marks `limitguard-tags.txt`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG, HOW_OUT, KINDS, checkList, checkNew, checkTags, onPiGuardPath, readProblems, summaryLine } from './limitguard.mjs';

const text = (problems, howOut = '') => `\n${problems.join('\n')}${howOut ? `\n${howOut}` : ''}`;

test('limitguard: no new limit', () => {
  const problems = checkNew(CONFIG);
  assert.equal(problems.length, 0, text(problems, HOW_OUT));
});

test('limitguard: the list and the tags match the code', (t) => {
  // node has no xfail: the count is printed here so every run shows what is left.
  t.diagnostic(summaryLine(CONFIG.guardDir));
  const list = checkList(CONFIG);
  assert.equal(list.length, 0, text(list));
  const tags = checkTags(CONFIG);
  assert.equal(tags.length, 0, text(tags));
});

test('limitguard: the read check passes on this repository today', () => {
  const problems = readProblems(CONFIG);
  assert.equal(problems.length, 0, text(problems));
});

// -- 080: `pi-guard` and the read check, on a small repository of their own --------------------
const PI = 'limit-ok: pi-guard — a cap that holds when the Pi is broken into';

function scratch(files, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'limitguard-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, guardDir: join(root, 'test'), skip: [], textRoots: ['src/', 'walt/', 'waltz/'],
    replyBound: new Set(), piGuards: [], tableReaders: [], unread: [], ...extra };
}

function piTag(path, piGuards) {
  const cfg = scratch({ [path]: `const TIMEOUT_SECONDS = 30; // ${PI}\n`, 'test/limitguard-tags.txt':
    `${path} | - | const TIMEOUT_SECONDS | 30; | pi-guard | a cap that holds when the Pi is broken into\n` },
  { piGuards });
  return checkTags(cfg);
}

test('limitguard: pi-guard counts under a configured path and nowhere else', () => {
  assert.deepEqual(piTag('walt/a.js', ['walt/']), []);
  for (const bad of ['src/a.js', 'waltz/a.js']) {
    const problems = piTag(bad, ['walt/']).filter((p) => p.includes('does not count'));
    assert.equal(problems.length, 1, bad);
    assert.match(problems[0], /counts only under `walt\/` \(Config\.piGuards\)/);
  }
  const none = piTag('walt/a.js', []).filter((p) => p.includes('does not count'));
  assert.match(none[0], /counts only under no path in this repository/);
  assert.ok(KINDS.includes('pi-guard'));
  const cfg = { piGuards: ['walt/'] };  // the path is matched after `..` is resolved, whole
  assert.equal(onPiGuardPath('walt/sub/../a.js', cfg), true);
  assert.equal(onPiGuardPath('walt/../pi/a.js', cfg), false);
  assert.equal(onPiGuardPath('walt.js', cfg), false);
  assert.equal(onPiGuardPath('walt/a.js', { piGuards: [] }), false);
});

const DECLARED = "export const CAP = new Limit('cap_a', 'A cap', 'count', 'household', 'hour');\n";

test('limitguard: the read check says an unread limit, an import-time read, a table read and a truth value', () => {
  const unread = readProblems(scratch({ 'src/limits_here.js': DECLARED }));
  assert.match(unread[0], /^src\/limits_here\.js:1: the limit `cap_a` is declared and never read/);
  const read = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export function f(limits) { return limits.value('cap_a'); }\n" }));
  assert.deepEqual(read, []);
  const atImport = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export const SIZE = limits.value('cap_a');\n" }));
  assert.ok(atImport.some((p) => p.includes('use.js:1') && p.includes('at module level')));
  const table = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export function f(limits) {\n  limits.value('cap_a');\n  return CAP.defaults['-'];\n}\n" }));
  assert.ok(table.some((p) => p.includes('use.js:3') && p.includes('.defaults[...]')));
  const tableOk = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export function f(limits) {\n  limits.value('cap_a');\n  return CAP.defaults['-'];\n}\n" },
  { tableReaders: ['src/use.js'] }));
  assert.deepEqual(tableOk, []);
  for (const body of ["const x = limits.value('cap_a');\n  return x || 5;",
    "return limits.value('cap_a') || 5;", "const x = limits.value('cap_a');\n  if (x) return 1;\n  return 0;"]) {
    const truthy = readProblems(scratch({ 'src/limits_here.js': DECLARED,
      'src/use.js': `export function f(limits) {\n  ${body}\n}\n` }));
    assert.ok(truthy.some((p) => p.includes('used as a condition')), body);
  }
  const compared = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export function f(limits) {\n  const x = limits.value('cap_a');\n  return x > 0;\n}\n" }));
  assert.deepEqual(compared, []);
});

test('limitguard: a live limit read in a constructor is said, a restart one read with atStart is not', () => {
  const live = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export class B {\n  constructor(limits) {\n    this.cap = limits.value('cap_a');\n  }\n}\n" }));
  assert.ok(live.some((p) => p.includes('use.js:3') && p.includes('is read in a constructor but is `live`')));
  const restart = DECLARED.replace("'hour')", "'hour', { applies: 'restart' })");
  assert.deepEqual(readProblems(scratch({ 'src/limits_here.js': restart,
    'src/use.js': "export class B {\n  constructor(limits) {\n    this.cap = limits.atStart('cap_a');\n  }\n}\n" })), []);
});

test('limitguard: a limit known unread is held back and must be dropped once read', () => {
  assert.deepEqual(readProblems(scratch({ 'src/limits_here.js': DECLARED }, { unread: ['cap_a'] })), []);
  const now = readProblems(scratch({ 'src/limits_here.js': DECLARED,
    'src/use.js': "export function f(l) { return l.value('cap_a'); }\n" }, { unread: ['cap_a'] }));
  assert.match(now[0], /`cap_a` is now read; delete it from CONFIG\.unread/);
});

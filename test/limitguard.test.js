// The limit guard's two tests (068). The detector is `limitguard.mjs`; the list of what is not
// yet converted is `limitguard-todo.txt`, the registry of marks `limitguard-tags.txt`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, HOW_OUT, checkList, checkNew, checkTags, summaryLine } from './limitguard.mjs';

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

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildTitle } = require('../scripts/pr_title');

const branches = new Set(['release/86.0', 'release/85.0']);
const branchExists = (branch) => branches.has(branch);

test('puts the linked issue after the target release in the generated commit subject', () => {
  assert.equal(
    buildTitle('[86.0] feat(assistant): original title blah blah',
      'release/87.0', ['REI-1671'], branchExists),
    '[87.0] [REI-1671] feat(assistant): original title blah blah',
  );
});

test('keeps the source issue first when it is among several linked issues', () => {
  assert.equal(
    buildTitle('[85.0] [86.0] [REI-1671] Fix assistant',
      'release/87.0', ['MOBILE-1533', 'REI-1671'], branchExists),
    '[87.0] [REI-1671] Fix assistant',
  );
});

test('keeps the original title when no linked issue is known', () => {
  assert.equal(
    buildTitle('Fix assistant', 'release/87.0', [], branchExists),
    '[87.0] Fix assistant',
  );
  assert.equal(
    buildTitle('[86.0] [REI-1671] Fix assistant', 'release/87.0', [], branchExists),
    '[87.0] [REI-1671] Fix assistant',
  );
});

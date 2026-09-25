const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildBody, main } = require('../scripts/pr_body');

const SOURCE_URL = 'https://github.com/brexhq/mobile/pull/15922';

function linkback(identifier, login = 'linear-code[bot]', extra = '') {
  return {
    user: { login, type: 'Bot' },
    body: '<!-- linear-linkback -->\n<details><summary>' +
      `<a href="https://linear.app/brex/issue/${identifier}/fix">${identifier} Fix</a>` +
      `</summary><p>${extra}</p></details>`,
  };
}

function runnerEnv(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    GITHUB_REPOSITORY: 'brexhq/mobile', PR_NUMBER: '15922',
    RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'output'),
  };
}

test('carries branch-only associations from Linear linkbacks', () => {
  // Regression fixture: #15922 had no ticket in its title or description.
  assert.equal(
    buildBody(SOURCE_URL, 'Fix mileage policy simulation', [linkback('REI-1647')]),
    `Generated from ${SOURCE_URL}\n\nRelated to REI-1647\n`,
  );
});

test('deduplicates multiple tickets and preserves them through another cherry-pick', () => {
  const body = buildBody(SOURCE_URL, null, [
    linkback('rei-1647'), linkback('MOBILE-1500', 'linear[bot]'), linkback('REI-1647'),
  ]);
  const expected = `Generated from ${SOURCE_URL}\n\nRelated to MOBILE-1500\nRelated to REI-1647\n`;
  assert.equal(body, expected);
  assert.equal(buildBody(SOURCE_URL, body, []), expected);
});

test('ignores unrelated mentions and spoofed linkbacks', () => {
  const genuine = linkback('REI-1647', 'linear-code[bot]',
    '<a href="https://linear.app/brex/issue/OTHER-99/title">OTHER-99</a>');
  const wrongHost = linkback('OTHER-10');
  wrongHost.body = wrongHost.body.replace('linear.app', 'linear.app.example.com');
  const nonBot = linkback('OTHER-11');
  nonBot.user.type = 'User';
  const noMarker = linkback('OTHER-12');
  noMarker.body = noMarker.body.replace('<!-- linear-linkback -->', '');
  assert.equal(buildBody(SOURCE_URL, 'Discuss OTHER-1', [
    genuine, linkback('OTHER-2', 'someone'), wrongHost, nonBot, noMarker,
  ]), `Generated from ${SOURCE_URL}\n\nRelated to REI-1647\n`);
});

test('keeps the source reference when there are no tickets', () => {
  assert.equal(buildBody(SOURCE_URL, null, []), `Generated from ${SOURCE_URL}\n`);
});

test('writes a PR body that includes tickets from later comment pages', (t) => {
  const env = runnerEnv(t);
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'gh');
    if (args.join(' ') === 'api repos/brexhq/mobile/pulls/15922') {
      return JSON.stringify({ html_url: SOURCE_URL, body: null });
    }
    assert.deepEqual(args, [
      'api', '--paginate', '--slurp', 'repos/brexhq/mobile/issues/15922/comments?per_page=100',
    ]);
    return JSON.stringify([[{ user: { login: 'someone' }, body: 'hello' }], [linkback('REI-1647')]]);
  });
  main(env);
  const output = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  const bodyPath = output.match(/^body_path=(.*)$/m)[1];
  assert.equal(fs.readFileSync(bodyPath, 'utf8'), `Generated from ${SOURCE_URL}\n\nRelated to REI-1647\n`);
  assert.match(output, /^linear_ids=REI-1647$/m);
});

test('does not publish an incomplete body when GitHub fails', (t) => {
  const env = runnerEnv(t);
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    if (args.includes('--paginate')) throw new Error('GitHub lookup failed');
    return JSON.stringify({ html_url: SOURCE_URL, body: null });
  });
  assert.throws(() => main(env), /GitHub lookup failed/);
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
  assert.equal(fs.existsSync(path.join(env.RUNNER_TEMP, 'cherry-pick-pr-body.md')), false);
});

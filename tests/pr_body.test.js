const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildBody } = require('../scripts/pr_body');

const SOURCE_URL = 'https://github.com/brexhq/mobile/pull/15922';

function linkback(identifier, login = 'linear-code[bot]', extra = '') {
  return {
    user: { login, type: 'Bot' },
    body: '<!-- linear-linkback -->\n<details><summary>' +
      `<a href="https://linear.app/brex/issue/${identifier}/fix">${identifier} Fix</a>` +
      `</summary><p>${extra}</p></details>`,
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

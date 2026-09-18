const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Exercise the actual composite-action shell scripts, without a YAML dependency.
const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
function step(name) {
  const block = action.split(`    - name: ${name}\n`)[1]?.split('\n    - name: ')[0];
  assert.ok(block, `Missing action step: ${name}`);
  return {
    condition: block.match(/\$\{\{ (.*?) \}\}/)?.[1],
    script: block.split('      run: |\n')[1]?.replace(/^        /gm, ''),
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'target-branch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '--bare', 'remote.git');
  git('init', 'checkout');
  const cwd = path.join(directory, 'checkout');
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd });
  execFileSync('git', ['config', 'commit.gpgSign', 'false'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', path.join(directory, 'remote.git')], { cwd });
  return {
    directory, cwd,
    env: { ...process.env, TO_BRANCH: 'release/86.0.0', GITHUB_ENV: path.join(directory, 'env') },
  };
}

function check(fixture) {
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step('Check target branch').script], {
    cwd: fixture.cwd, env: fixture.env, encoding: 'utf8',
  });
}

test('missing branch succeeds, skips PR creation, and comments on the source PR', (t) => {
  const f = fixture(t);
  const result = check(f);
  assert.equal(result.status, 0, result.stderr);
  const env = {
    TO_BRANCH: f.env.TO_BRANCH, TARGET_BRANCH_EXISTS: 'false', COMMIT_ID: '', EMPTY_CHERRY_PICK: '',
  };
  assert.equal(fs.readFileSync(f.env.GITHUB_ENV, 'utf8'), 'TARGET_BRANCH_EXISTS=false\n');
  for (const name of ['Find commit ID to cherry-pick', 'Cherry-pick merged commit',
    'Create pull request title', 'Create pull request description', 'Create pull request']) {
    assert.equal(vm.runInNewContext(step(name).condition, { env }), false, `${name} must be skipped`);
  }
  assert.equal(vm.runInNewContext(step('PR comment').condition, { env }), true);
  // Capture gh arguments locally; this test never posts a real GitHub comment.
  fs.writeFileSync(path.join(f.directory, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$COMMENT_ARGS"\n', { mode: 0o755 });
  const comment = spawnSync('bash', ['-e', '-o', 'pipefail', '-c',
    step('PR comment').script.replaceAll('${{ inputs.pr_number }}', '15979')], {
    cwd: f.cwd, encoding: 'utf8', env: {
      ...f.env, ...env, AUTHOR: 'author', COMMENTER: 'requester',
      PATH: `${f.directory}:${process.env.PATH}`, COMMENT_ARGS: path.join(f.directory, 'comment'),
    },
  });
  assert.equal(comment.status, 0, comment.stderr);
  const args = fs.readFileSync(path.join(f.directory, 'comment'), 'utf8');
  assert.match(args, /^pr\ncomment\n15979\n-b\n/);
  assert.match(args, /@requester @author/);
  assert.match(args, /branch `release\/86\.0\.0` doesn't exist/);
});

test('existing remote branch allows commit lookup', (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe' });
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial');
  git('push', 'origin', 'HEAD:refs/heads/release/86.0.0');
  const result = check(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.env.GITHUB_ENV, 'utf8'), 'TARGET_BRANCH_EXISTS=true\n');
  assert.equal(vm.runInNewContext(step('Find commit ID to cherry-pick').condition, {
    env: { TO_BRANCH: f.env.TO_BRANCH, TARGET_BRANCH_EXISTS: 'true' },
  }), true);
});

test('remote access failures remain errors instead of reporting a missing branch', (t) => {
  const f = fixture(t);
  execFileSync('git', ['remote', 'set-url', 'origin', path.join(f.directory, 'unavailable.git')], { cwd: f.cwd });
  const result = check(f);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.GITHUB_ENV), false);
});

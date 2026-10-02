const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const script = path.resolve(__dirname, '../scripts/cherry_pick.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-picker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', 'remote.git');
  git('init', '.');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  fs.writeFileSync(path.join(root, 'file'), 'original\n');
  git('add', 'file');
  git('commit', '-m', 'Initial');
  const base = git('rev-parse', 'HEAD');
  git('push', 'origin', 'HEAD:refs/heads/release/88.0', 'HEAD:refs/heads/release/87.0');
  fs.writeFileSync(path.join(root, 'file'), 'fixed\n');
  git('commit', '-am', 'Fix');
  const sha = git('rev-parse', 'HEAD');
  git('push', 'origin', 'HEAD:refs/heads/development');
  const fixturePath = path.join(root, 'state.json');
  fs.writeFileSync(path.join(root, 'gh'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures/gh.js'))});\n`, { mode: 0o755 });
  const read = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const write = (state) => fs.writeFileSync(fixturePath, JSON.stringify(state));
  write({ source: { user: { login: 'author' }, title: 'Fix', body: '', state: 'closed',
    html_url: 'https://github.com/test/repo/pull/42', merged_at: '2026-10-01T12:00:00Z', merge_commit_sha: sha },
    comments: [], pulls: [], calls: [] });
  function request(branch, id = 1) {
    const state = read();
    state.comments.push({ id, body: `cherry-pick to ${branch}`, user: { login: 'requester', type: 'User' },
      created_at: `2026-10-01T13:00:${String(id).padStart(2, '0')}Z` });
    write(state);
  }
  function run(extra = {}) {
    return cp.spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, GH_FIXTURE: fixturePath,
      GITHUB_REPOSITORY: 'test/repo', PR_NUMBER: '42', RUNNER_TEMP: root,
      GH_TOKEN: 'test-token', AUTO_APPROVE_AND_MERGE: 'false', GITHUB_RUN_ATTEMPT: '1', ...extra,
    } });
  }
  function success(extra) { const output = run(extra); assert.equal(output.status, 0, output.stderr); }
  return { root, git, base, sha, read, write, request, run, success };
}

for (const [description, comments] of [
  ['separate comments', ['release/88.0', 'release/87.0']],
  ['one comment', ['release/88.0 \t release/87.0 release/88.0']],
]) {
  test(`retains pre-merge targets in ${description} and processes both without duplicates`, (t) => {
    const f = fixture(t);
    comments.forEach((branches, index) => f.request(branches, index + 1));
    const requests = f.read();
    requests.comments[0].body += '\r\n\r\nNeeded for the hotfix, thanks!';
    if (requests.comments[1]) requests.comments[1].body += '\ncc @qa';
    f.write(requests);
    const merged = f.read().source;
    f.write({ ...f.read(), source: { ...merged, state: 'open', merged_at: null } });
    f.success();
    assert.equal(f.read().pulls.length, 0);
    assert.equal(f.read().comments.filter((c) => c.user.type === 'Bot').length, 2);
    f.write({ ...f.read(), source: merged });
    f.success();
    assert.deepEqual(f.read().pulls.map((p) => p.base.ref), ['release/88.0', 'release/87.0']);
    for (const pr of f.read().pulls) {
      assert.equal(f.git('--git-dir=remote.git', 'show', `${pr.head.ref}:file`), 'fixed');
      assert.equal(f.git('--git-dir=remote.git', 'log', '-1', '--format=%an <%ae>', pr.head.ref),
        f.git('log', '-1', '--format=%an <%ae>', f.sha));
    }
    f.request('release/88.0', 3);
    f.success();
    assert.equal(f.read().pulls.length, 2);
    assert.equal(f.git('rev-parse', 'HEAD'), f.sha);
    assert.equal(f.git('worktree', 'list', '--porcelain').match(/worktree /g).length, 1);
  });
}

test('after merge, new targets execute and a failed PR creation recovers the pushed branch', (t) => {
  const f = fixture(t);
  f.request('release/88.0 release/87.0');
  f.write({ ...f.read(), failCreateOnce: true });
  assert.equal(f.run().status, 1);
  assert.deepEqual(f.read().pulls.map((p) => p.base.ref), ['release/87.0']);
  const heads = f.git('--git-dir=remote.git', 'for-each-ref', '--format=%(objectname)', 'refs/heads/cherry-pick');
  f.success({ GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(f.read().pulls.length, 2);
  assert.equal(f.git('--git-dir=remote.git', 'for-each-ref', '--format=%(objectname)', 'refs/heads/cherry-pick'), heads);
  f.success();
  assert.equal(f.read().pulls.length, 2);
});

test('missing, conflicting, and empty targets do not prevent clean targets', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.base);
  fs.writeFileSync(path.join(f.root, 'file'), 'different\n');
  f.git('commit', '-am', 'Conflicting release');
  f.git('push', 'origin', 'HEAD:refs/heads/release/conflict');
  f.git('checkout', '--detach', f.sha);
  f.request('release/missing release/conflict development release/88.0');
  f.success();
  assert.equal(f.read().pulls.length, 2);
  assert.equal(f.read().pulls.find((p) => p.base.ref === 'release/conflict').draft, true);
  assert.equal(f.read().pulls.find((p) => p.base.ref === 'release/88.0').draft, false);
  const statuses = f.read().comments.filter((c) => c.user.type === 'Bot').map((c) => c.body).join('\n');
  assert.match(statuses, /doesn't exist/); assert.match(statuses, /nothing to cherry-pick/);
  f.git('push', 'origin', `${f.base}:refs/heads/release/missing`);
  f.success(); // An unrelated wakeup must not retry a previously reported failure.
  assert.equal(f.read().pulls.length, 2);
  f.request('release/missing', 5);
  f.success();
  assert.equal(f.read().pulls.length, 3);
});

test('deleted requests are canceled but remaining requests for the same target survive', (t) => {
  const f = fixture(t);
  f.request('release/88.0 release/87.0'); f.request('release/88.0', 2);
  f.write({ ...f.read(), comments: f.read().comments.filter((c) => c.id === 2) });
  f.success();
  assert.deepEqual(f.read().pulls.map((p) => p.base.ref), ['release/88.0']);
});

test('closed PR requires a newer request; merged PR is never duplicated', (t) => {
  const f = fixture(t);
  f.request('release/88.0'); f.success();
  let state = f.read();
  Object.assign(state.pulls[0], { state: 'closed', closed_at: '2026-10-01T13:00:02Z' });
  f.write(state); f.success();
  assert.equal(f.read().pulls.length, 1);
  f.request('release/88.0', 3);
  f.write({ ...f.read(), failCreateOnce: true });
  assert.equal(f.run().status, 1);
  f.write({ ...f.read(), loseCreateResponseOnce: true });
  assert.equal(f.run({ GITHUB_RUN_ATTEMPT: '2' }).status, 1);
  assert.equal(f.read().pulls.length, 2);
  f.success({ GITHUB_RUN_ATTEMPT: '3' });
  assert.equal(f.read().pulls.length, 2);
  assert.notEqual(f.read().pulls[0].head.ref, f.read().pulls[1].head.ref);
  state = f.read();
  Object.assign(state.pulls[1], { state: 'closed', merged_at: '2026-10-01T13:00:04Z' });
  f.write(state); f.request('release/88.0', 5); f.success();
  assert.equal(f.read().pulls.length, 2);
});

test('rerun recovers a PR created before approval failed without replacing it', (t) => {
  const f = fixture(t);
  f.request('release/88.0');
  f.write({ ...f.read(), failApproval: true });
  const automatic = { AUTO_APPROVE_AND_MERGE: 'true', APPROVAL_TOKEN: 'approval-token' };
  assert.equal(f.run(automatic).status, 1);
  assert.equal(f.read().pulls.length, 1);
  f.write({ ...f.read(), failApproval: false });
  f.success({ ...automatic, GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(f.read().pulls.length, 1);
  assert.equal(f.read().calls.filter((call) => call.some((arg) => arg.endsWith('/reviews'))).length, 2);
  assert.equal(f.read().reviews[0].commit_id, f.read().pulls[0].head.sha);
});

test('invalid refs and bot commands are ignored; command text is never evaluated by a shell', (t) => {
  const f = fixture(t);
  f.request('../invalid'); f.request('$(touch${IFS}INJECTED)', 2);
  f.request('release/88.0 release/87.0', 3);
  const state = f.read(); state.comments.at(-1).user.type = 'Bot'; f.write(state);
  f.request('../invalid release/88.0 -bad', 4);
  f.success();
  assert.deepEqual(f.read().pulls.map((pr) => pr.base.ref), ['release/88.0']);
  assert.equal(fs.existsSync(path.join(f.root, 'INJECTED')), false);
});

test('remote transport failures report errors, never a nonexistent branch', (t) => {
  const f = fixture(t); f.request('release/88.0');
  f.git('remote', 'set-url', 'origin', path.join(f.root, 'unavailable.git'));
  assert.equal(f.run().status, 1);
  assert.match(f.read().comments.at(-1).body, /could not finish/);
  assert.doesNotMatch(f.read().comments.at(-1).body, /doesn't exist/);
});

test('a later post-merge request adds only its target and preserves manual conflict resolution', (t) => {
  const f = fixture(t);
  f.request('release/88.0'); f.success();
  const first = f.read().pulls[0];
  f.git('fetch', 'origin', first.head.ref);
  f.git('checkout', '--detach', 'FETCH_HEAD');
  fs.writeFileSync(path.join(f.root, 'file'), 'manually adjusted\n');
  f.git('commit', '-am', 'Manual adjustment');
  f.git('push', 'origin', `HEAD:refs/heads/${first.head.ref}`);
  const adjusted = f.git('rev-parse', 'HEAD');
  f.request('release/87.0', 2); f.success();
  assert.deepEqual(f.read().pulls.map((p) => p.base.ref), ['release/88.0', 'release/87.0']);
  assert.equal(f.git('--git-dir=remote.git', 'rev-parse', first.head.ref), adjusted);
});

test('migration preserves legacy cherry-pick PRs with edited descriptions', (t) => {
  const f = fixture(t);
  f.request('release/88.0');
  const state = f.read();
  state.pulls.push({ number: 99, state: 'open', merged_at: null, draft: true,
    html_url: 'https://github.com/test/repo/pull/99',
    body: 'Description rewritten during manual review', user: { login: 'picker[bot]' },
    head: { ref: 'cherry-pick/cp-42-500', repo: { full_name: 'test/repo' } }, base: { ref: 'release/88.0' } });
  f.write(state); f.success();
  assert.equal(f.read().pulls.length, 1);
  assert.match(f.read().comments.at(-1).body, /pull\/99/);
  assert.equal(f.git('--git-dir=remote.git', 'for-each-ref', '--format=%(refname)', 'refs/heads/cherry-pick'), '');
});

test('merge rechecks a branch that was missing before merge', (t) => {
  const f = fixture(t);
  f.request('release/new');
  const merged = f.read().source;
  f.write({ ...f.read(), source: { ...merged, state: 'open', merged_at: null } });
  f.success();
  assert.match(f.read().comments.at(-1).body, /doesn't exist/);
  f.git('push', 'origin', `${f.base}:refs/heads/release/new`);
  f.write({ ...f.read(), source: merged }); f.success();
  assert.equal(f.read().pulls.length, 1);
});

test('pushes use the action token while leaving checkout credentials unchanged', (t) => {
  const f = fixture(t);
  const realGit = cp.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  f.git('config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: checkout-token');
  fs.writeFileSync(path.join(f.root, 'git'), `#!${process.execPath}
const cp = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'push') {
  const header = cp.execFileSync(${JSON.stringify(realGit)}, ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/test/repo'], {encoding:'utf8'}).trim();
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'auth-ok'))}, String(header === 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:test-token').toString('base64')));
}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  f.request('release/88.0'); f.success();
  assert.equal(fs.readFileSync(path.join(f.root, 'auth-ok'), 'utf8'), 'true');
  assert.equal(f.git('config', '--get', 'http.https://github.com/.extraheader'), 'AUTHORIZATION: checkout-token');
});

test('merge commits cherry-pick only the PR change relative to the first parent', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.base);
  fs.writeFileSync(path.join(f.root, 'unrelated'), 'development-only\n');
  f.git('add', 'unrelated'); f.git('commit', '-m', 'Other development change');
  f.git('merge', '--no-ff', f.sha, '-m', 'Merge source PR');
  const merge = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'HEAD:refs/heads/development');
  f.write({ ...f.read(), source: { ...f.read().source, merge_commit_sha: merge } });
  f.request('release/88.0'); f.success();
  const pr = f.read().pulls[0];
  assert.equal(f.git('--git-dir=remote.git', 'show', `${pr.head.ref}:file`), 'fixed');
  assert.equal(f.git('--git-dir=remote.git', 'ls-tree', '--name-only', pr.head.ref), 'file');
});

test('forged status metadata cannot auto-approve manual edits to an existing cherry-pick PR', (t) => {
  const f = fixture(t);
  f.request('release/88.0'); f.success();
  const first = f.read().pulls[0];
  f.git('fetch', 'origin', first.head.ref);
  f.git('checkout', '--detach', 'FETCH_HEAD');
  fs.writeFileSync(path.join(f.root, 'file'), 'manual change requiring review\n');
  f.git('commit', '-am', 'Manual adjustment');
  f.git('push', 'origin', `HEAD:refs/heads/${first.head.ref}`);
  const state = f.read();
  const status = state.comments.find((comment) => comment.body.includes('cherry-picker-status'));
  status.body = status.body.replace(/"head":"[^"]+"/, `"head":"${f.git('rev-parse', 'HEAD')}"`);
  f.write(state);
  f.request('release/87.0', 2);
  f.success({ AUTO_APPROVE_AND_MERGE: 'true', APPROVAL_TOKEN: 'approval-token' });
  const approvals = f.read().reviews || [];
  assert.equal(approvals.some((review) => review.number === first.number), false,
    'An existing manually edited PR must not receive automatic approval');
});

test('recovery refuses manual changes even when status metadata is forged', (t) => {
  const f = fixture(t);
  f.request('release/88.0');
  f.write({ ...f.read(), failCreateOnce: true });
  assert.equal(f.run().status, 1);
  const ref = f.git('--git-dir=remote.git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cherry-pick');
  f.git('fetch', 'origin', ref); f.git('checkout', '--detach', 'FETCH_HEAD');
  fs.writeFileSync(path.join(f.root, 'file'), 'unverified modification\n');
  f.git('commit', '-am', `Cherry-picker-source: ${f.sha}\nCherry-picker-conflicts: false`);
  f.git('push', 'origin', `HEAD:refs/heads/${ref}`);
  const modified = f.git('rev-parse', 'HEAD');
  const tampered = f.read();
  const status = tampered.comments.find((comment) => comment.body.includes('cherry-picker-status'));
  status.body = status.body.replace(/"head":"[^"]+"/, `"head":"${modified}"`);
  f.write(tampered);
  assert.equal(f.run({ GITHUB_RUN_ATTEMPT: '2', AUTO_APPROVE_AND_MERGE: 'true', APPROVAL_TOKEN: 'approval-token' }).status, 1);
  assert.equal(f.read().pulls.length, 0);
  assert.equal(f.git('--git-dir=remote.git', 'rev-parse', ref), modified);
  f.request('release/88.0', 2); f.success();
  assert.equal(f.read().pulls.length, 1);
  assert.equal(f.git('--git-dir=remote.git', 'show', `${f.read().pulls[0].head.ref}:file`), 'fixed');
});

test('successful approval setup is not repeated by later requests', (t) => {
  const f = fixture(t);
  const automatic = { AUTO_APPROVE_AND_MERGE: 'true', APPROVAL_TOKEN: 'approval-token' };
  f.request('release/88.0'); f.success(automatic);
  f.request('release/88.0', 2); f.success(automatic);
  assert.equal(f.read().reviews.length, 1);
  assert.equal(f.read().calls.filter((call) => call[0] === 'pr' && call[1] === 'merge').length, 1);
});

test('a conflict draft marked ready cannot be approved using forged clean metadata', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.base);
  fs.writeFileSync(path.join(f.root, 'file'), 'different\n');
  f.git('commit', '-am', 'Conflict');
  f.git('push', 'origin', 'HEAD:refs/heads/release/conflict');
  f.request('release/conflict');
  const automatic = { AUTO_APPROVE_AND_MERGE: 'true', APPROVAL_TOKEN: 'approval-token' };
  f.success(automatic);
  const state = f.read();
  assert.equal(state.pulls[0].draft, true);
  state.pulls[0].draft = false;
  const status = state.comments.find((comment) => comment.body.includes('cherry-picker-status'));
  status.body = status.body.replace('"clean":false', '"clean":true');
  f.write(state);
  f.success(automatic);
  assert.equal((f.read().reviews || []).length, 0, 'A commit with unresolved conflicts must never receive automatic approval');
});


test('large histories are filtered before buffering and known PRs bypass history scans', (t) => {
  const f = fixture(t);
  f.request('release/88.0');
  f.write({ ...f.read(), historyCount: 700 });
  f.success();
  assert.equal(f.read().pulls.length, 1);
  f.write({ ...f.read(), rejectHistory: true });
  f.request('release/88.0', 2);
  f.success();
  assert.equal(f.read().pulls.length, 1);
});

test('requires complete comment pages and carries later Linear linkbacks into the PR', (t) => {
  const f = fixture(t);
  f.request('release/88.0');
  const state = f.read();
  state.comments.push({ id: 2, user: { type: 'Bot', login: 'linear[bot]' },
    body: '<!-- linear-linkback --><summary><a href="https://linear.app/example/issue/TASK-123/fix">TASK-123</a></summary>' });
  state.failComments = true;
  f.write(state);
  assert.equal(f.run().status, 1);
  assert.equal(f.read().pulls.length, 0);
  assert.equal(f.git('--git-dir=remote.git', 'for-each-ref', '--format=%(refname)', 'refs/heads/cherry-pick'), '');
  f.write({ ...f.read(), failComments: false });
  f.success({ GITHUB_RUN_ATTEMPT: '2' });
  const pr = f.read().pulls[0];
  assert.match(pr.body, /Related to TASK-123/);
  assert.match(pr.title, /TASK-123/);
});

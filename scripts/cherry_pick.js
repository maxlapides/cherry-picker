// Reconcile all requests, with a fresh Git worktree for each target.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requests, branchPrefix } = require('./requests');
const { buildBody, getIdentifiers } = require('./pr_body');
const { buildTitle } = require('./pr_title');

const env = process.env;
const repository = env.GITHUB_REPOSITORY;
const number = env.PR_NUMBER;
const apiRoot = `repos/${repository}`;
const options = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
const exec = (command, args, extra = {}) => cp.execFileSync(command, args, { ...options, ...extra }).trimEnd();
// Override checkout credentials for pushes using the action's write token. Keep
// credentials in the child environment, never in command arguments or Git config.
const gitEnv = { ...env };
if (env.GH_TOKEN) {
  const count = Number(env.GIT_CONFIG_COUNT || 0);
  const key = `http.${env.GITHUB_SERVER_URL || 'https://github.com'}/.extraheader`;
  gitEnv.GIT_CONFIG_COUNT = String(count + 2);
  gitEnv[`GIT_CONFIG_KEY_${count}`] = key;
  gitEnv[`GIT_CONFIG_VALUE_${count}`] = '';
  gitEnv[`GIT_CONFIG_KEY_${count + 1}`] = key;
  gitEnv[`GIT_CONFIG_VALUE_${count + 1}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}`;
}
const git = (...args) => exec('git', args, { env: gitEnv });
function api(endpoint, data, method = 'POST', token = env.GH_TOKEN) {
  return JSON.parse(exec('gh', ['api', endpoint,
    ...(data === undefined ? [] : ['--method', method, '--input', '-'])],
  { env: { ...env, GH_TOKEN: token }, ...(data === undefined ? {} : { input: JSON.stringify(data) }) }));
}
function pages(endpoint) {
  return JSON.parse(exec('gh', ['api', '--paginate', '--slurp', endpoint])).flat();
}
function result(args, cwd) {
  const value = cp.spawnSync('git', args, { ...options, cwd, env: gitEnv });
  if (value.error) throw value.error;
  if (value.signal) throw new Error(`git terminated by ${value.signal}`);
  return value;
}
function metadata(comment) {
  const match = comment.body?.match(/<!-- cherry-picker-status (\{[^\n]*\}) -->/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function findPulls(target, prefix, viewer, knownNumber) {
  const legacy = new RegExp(`^cherry-pick/cp-${number}-[0-9]+$`);
  // gh applies this filter per page. Only matching PR metadata reaches Node;
  // unrelated bodies and repository objects never accumulate in its buffer.
  const filter = `select(.base.ref == ${JSON.stringify(target)}) |
    select(.head.repo.full_name == ${JSON.stringify(repository)}) |
    select((.head.ref | startswith(${JSON.stringify(prefix)})) or
      ((.head.ref | test(${JSON.stringify(legacy.source)})) and .user.login == ${JSON.stringify(viewer)})) |
    {number, html_url, state, merged_at, closed_at, draft,
     head: {ref: .head.ref, sha: .head.sha, repo: {full_name: .head.repo.full_name}},
     base: {ref: .base.ref}, user: {login: .user.login}} | @json`;
  const read = (args) => exec('gh', ['api', ...args]).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (Number.isSafeInteger(knownNumber) && knownNumber > 0) {
    const known = read(['--jq', filter, `${apiRoot}/pulls/${knownNumber}`]);
    if (known.some((pr) => pr.merged_at || pr.state === 'open')) return known;
  }
  return read(['--paginate', '--jq', `.[] | ${filter}`,
    `${apiRoot}/pulls?state=all&base=${encodeURIComponent(target)}&per_page=100`]);
}

function pullMessage(pr, target) {
  if (pr.merged_at) return `The cherry-pick to \`${target}\` was merged: ${pr.html_url}`;
  if (pr.draft) return `The cherry-pick to \`${target}\` is a draft. Please resolve any conflicts and review it: ${pr.html_url}`;
  return `The cherry-pick to \`${target}\` has a pull request: ${pr.html_url}`;
}

async function main() {
  if (!/^[1-9]\d*$/.test(number || '')) throw new Error('pr_number must be a positive integer');
  const source = api(`${apiRoot}/pulls/${number}`);
  const comments = pages(`${apiRoot}/issues/${number}/comments?per_page=100`);
  const targets = requests(comments);
  if (!targets.size) return;
  // Match our own status comments for both GitHub App tokens and user tokens.
  const viewer = JSON.parse(exec('gh', ['api', 'graphql', '-f', 'query={ viewer { login } }'])).data.viewer.login;
  const phase = source.merged_at ? source.merge_commit_sha : 'pending';
  if (source.merged_at && !phase) throw new Error('Merged PR is missing its merge commit');
  if (source.merged_at && env.AUTO_APPROVE_AND_MERGE === 'true' && !env.APPROVAL_TOKEN) {
    throw new Error('gh_token is required when auto_approve_and_merge is enabled');
  }
  function autoMerge(pr, preparation, target) {
    if (pr.merged_at || pr.draft || env.AUTO_APPROVE_AND_MERGE !== 'true') return false;
    // Require the recorded commit and verify its contents independently in Git.
    // Existing PRs without that provenance (or with manual edits) need human review.
    if (!preparation?.clean || pr.head.sha !== preparation.head) return false;
    if (verifyCommit(target, preparation.head, source.merge_commit_sha) !== 'clean') return false;
    api(`${apiRoot}/pulls/${pr.number}/reviews`, { event: 'APPROVE', commit_id: preparation.head }, 'POST', env.APPROVAL_TOKEN);
    exec('gh', ['pr', 'merge', '--repo', repository, '--auto', '--squash',
      '--match-head-commit', preparation.head, String(pr.number)]);
    return true;
  }
  function targetExists(target) {
    const check = result(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${target}`]);
    if (check.status === 2) return false;
    if (check.status !== 0) throw new Error(check.stderr || 'Cannot access target branch');
    return true;
  }
  let failed = false;

  for (const [target, request] of targets) {
    let statusComment = comments.filter((c) => c.user?.login === viewer && metadata(c)?.target === target).at(-1);
    const previous = statusComment && metadata(statusComment);
    let preparation = previous?.phase === phase ? previous.preparation : undefined;
    let pullNumber = previous?.pr;
    let automated = previous?.phase === phase && previous.automated === true;
    const mention = [...new Set([request.user.login, source.user.login])].map((login) => `@${login}`).join(' ');
    function report(status, message) {
      const state = { target, request: request.id, phase, status, preparation, automated, pr: pullNumber };
      const body = `${mention} ${message}\n\n<!-- cherry-picker-status ${JSON.stringify(state)} -->`;
      if (statusComment?.body === body) return;
      statusComment = statusComment
        ? api(`${apiRoot}/issues/comments/${statusComment.id}`, { body }, 'PATCH')
        : api(`${apiRoot}/issues/${number}/comments`, { body });
    }
    try {
      if (!source.merged_at) {
        if (source.state !== 'closed' && !targetExists(target)) {
          report('missing', `The branch \`${target}\` doesn't exist. Please check the branch name and post a new cherry-pick comment.`);
          continue;
        }
        report('waiting', source.state === 'closed'
          ? `This PR was closed without merging; the cherry-pick to \`${target}\` is not scheduled.`
          : `This PR will be cherry-picked to \`${target}\` when it is merged. Requests for other branches are also retained. To cancel this target, delete all comments requesting it before processing starts.`);
        continue;
      }
      const prefix = branchPrefix(number, target);
      const pulls = findPulls(target, prefix, viewer, pullNumber);
      const existing = pulls.find((pr) => pr.merged_at) || pulls.find((pr) => pr.state === 'open');
      if (existing) {
        pullNumber = existing.number;
        if (!automated) automated = autoMerge(existing, preparation, target);
        report('created', pullMessage(existing, target));
        continue;
      }
      const closed = pulls.sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))[0];
      if (closed) pullNumber = closed.number;
      if (closed && Date.parse(request.created_at) <= Date.parse(closed.closed_at)) {
        report('closed', `The cherry-pick to \`${target}\` was closed without merging: ${closed.html_url}. To try again, post a new cherry-pick comment.`);
        continue;
      }
      // A different target's request must not repeatedly retry old failures.
      if (previous?.request === request.id && previous.phase === phase &&
          ['failed', 'empty', 'missing'].includes(previous.status) && Number(env.GITHUB_RUN_ATTEMPT || 1) === 1) continue;
      if (!targetExists(target)) {
        report('missing', `The branch \`${target}\` doesn't exist. Please check the branch name and post a new cherry-pick comment.`);
        continue;
      }
      const head = `${prefix}${request.id}`;
      const title = buildTitle(source.title, target, getIdentifiers(source.body, comments),
        (name) => result(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).status === 0);
      const body = buildBody(source.html_url, source.body, comments);
      const outcome = createBranch(target, head, source.merge_commit_sha, title, preparation, (prepared) => {
        preparation = prepared;
        pullNumber = undefined;
        automated = false;
        report('prepared', `Preparing the cherry-pick to \`${target}\`.`);
      });
      if (outcome === 'empty') {
        report('empty', `The changes are already present on \`${target}\`; there is nothing to cherry-pick.`);
        continue;
      }
      const pr = api(`${apiRoot}/pulls`, { head, base: target, title, body, draft: outcome === 'conflict' });
      pullNumber = pr.number;
      automated = autoMerge(pr, preparation, target);
      report('created', pullMessage(pr, target));
    } catch (error) {
      failed = true;
      console.error(`Cherry-pick to ${target} failed: ${error.message}`);
      try {
        report('failed', `The cherry-pick to \`${target}\` could not finish. Check the workflow logs, then rerun the workflow or post a new cherry-pick comment.`);
      } catch (reportError) { console.error(`Could not report failure: ${reportError.message}`); }
    }
  }
  if (failed) process.exitCode = 1;
}

function replayCommit(sha, worktree) {
  const run = (...args) => exec('git', args, { cwd: worktree, env: gitEnv });
  const parents = run('rev-list', '--parents', '-n', '1', sha).split(' ');
  const picked = result(['-c', 'user.name=Cherry-pick Bot', '-c', 'user.email=noreply@github.com',
    'cherry-pick', '--no-commit', ...(parents.length > 2 ? ['-m', '1'] : []), sha], worktree);
  const conflicts = run('diff', '--name-only', '--diff-filter=U');
  if (picked.status !== 0 && !conflicts) throw new Error(picked.stderr || picked.stdout || 'Cherry-pick failed');
  if (conflicts) run('add', '--all');
  return Boolean(conflicts);
}

// Status comments are editable by collaborators. Reproduce the change in Git
// before trusting a recorded head for approval or interrupted-push recovery.
function verifyCommit(target, head, source) {
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'cherry-pick-verify-'));
  const worktree = path.join(directory, 'worktree');
  try {
    git('fetch', 'origin', `refs/heads/${target}`);
    const targetHead = git('rev-parse', 'FETCH_HEAD');
    git('fetch', 'origin', head);
    const ancestry = git('rev-list', '--parents', '-n', '1', head).split(' ');
    if (ancestry.length !== 2) return null;
    const ancestor = result(['merge-base', '--is-ancestor', ancestry[1], targetHead]);
    if (ancestor.status === 1) return null;
    if (ancestor.status !== 0) throw new Error(ancestor.stderr || 'Cannot verify cherry-pick parent');
    git('fetch', 'origin', source);
    git('worktree', 'add', '--detach', worktree, ancestry[1]);
    const conflicts = replayCommit(source, worktree);
    const comparison = result(['diff', '--cached', '--quiet', head], worktree);
    if (comparison.status === 1) return null;
    if (comparison.status !== 0) throw new Error(comparison.stderr || 'Cannot compare cherry-pick trees');
    return conflicts ? 'conflict' : 'clean';
  } finally {
    if (fs.existsSync(worktree)) git('worktree', 'remove', '--force', worktree);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createBranch(target, head, sha, title, preparation, recordPreparation) {
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'cherry-pick-'));
  const worktree = path.join(directory, 'worktree');
  try {
    git('fetch', 'origin', `refs/heads/${target}`);
    git('worktree', 'add', '--detach', worktree, 'FETCH_HEAD');
    const run = (...args) => exec('git', args, { cwd: worktree, env: gitEnv });
    // Recover a push that succeeded before its PR was created. Never overwrite it.
    const remote = result(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${head}`]);
    if (remote.status === 0) {
      run('fetch', 'origin', `refs/heads/${head}`);
      if (!preparation || run('rev-parse', 'FETCH_HEAD') !== preparation.head) {
        throw new Error(`Existing branch ${head} has unverified changes; post a new cherry-pick comment to try again`);
      }
      const verified = verifyCommit(target, preparation.head, sha);
      if (!verified) throw new Error(`Existing branch ${head} does not match the source cherry-pick`);
      return verified;
    }
    if (remote.status !== 2) throw new Error(remote.stderr || 'Cannot inspect cherry-pick branch');
    run('fetch', 'origin', sha);
    const conflicts = replayCommit(sha, worktree);
    const diff = result(['diff', '--cached', '--quiet'], worktree);
    if (diff.status === 0) return 'empty';
    if (diff.status !== 1) throw new Error(diff.stderr || 'Cannot inspect cherry-pick changes');
    run('-c', 'user.name=Cherry-pick Bot', '-c', 'user.email=noreply@github.com',
      '-c', 'commit.gpgSign=false', 'commit', '--author', run('log', '-1', '--format=%an <%ae>', sha),
      '-m', title, '-m',
      `Cherry-picker-source: ${sha}\nCherry-picker-conflicts: ${Boolean(conflicts)}`);
    recordPreparation({ head: run('rev-parse', 'HEAD'), clean: !conflicts });
    run('push', 'origin', `HEAD:refs/heads/${head}`);
    return conflicts ? 'conflict' : 'clean';
  } finally {
    if (fs.existsSync(worktree)) git('worktree', 'remove', '--force', worktree);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

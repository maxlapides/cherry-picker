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
function api(endpoint, data, method = 'POST') {
  return JSON.parse(exec('gh', ['api', endpoint,
    ...(data === undefined ? [] : ['--method', method, '--input', '-'])],
  data === undefined ? {} : { input: JSON.stringify(data) }));
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
  function autoMerge(pr) {
    if (pr.merged_at || pr.draft || env.AUTO_APPROVE_AND_MERGE !== 'true') return;
    exec('gh', ['pr', 'merge', '--repo', repository, '--auto', '--squash', String(pr.number)]);
    exec('gh', ['pr', 'review', '--repo', repository, '--approve', String(pr.number)],
      { env: { ...env, GH_TOKEN: env.APPROVAL_TOKEN } });
  }
  function branchExists(target) {
    const check = result(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${target}`]);
    if (check.status === 2) return false;
    if (check.status !== 0) throw new Error(check.stderr || 'Cannot access target branch');
    return true;
  }
  let failed = false;

  for (const [target, request] of targets) {
    let statusComment = comments.filter((c) => c.user?.login === viewer && metadata(c)?.target === target).at(-1);
    const previous = statusComment && metadata(statusComment);
    const mention = [...new Set([request.user.login, source.user.login])].map((login) => `@${login}`).join(' ');
    function report(status, message) {
      const state = { target, request: request.id, phase, status };
      const body = `${mention} ${message}\n\n<!-- cherry-picker-status ${JSON.stringify(state)} -->`;
      if (statusComment?.body === body) return;
      statusComment = statusComment
        ? api(`${apiRoot}/issues/comments/${statusComment.id}`, { body }, 'PATCH')
        : api(`${apiRoot}/issues/${number}/comments`, { body });
    }
    try {
      if (!source.merged_at) {
        if (source.state !== 'closed' && !branchExists(target)) {
          report('missing', `The branch \`${target}\` doesn't exist. Please check the branch name and post a new cherry-pick comment.`);
          continue;
        }
        report('waiting', source.state === 'closed'
          ? `This PR was closed without merging; the cherry-pick to \`${target}\` is not scheduled.`
          : `This PR will be cherry-picked to \`${target}\` when it is merged. Requests for other branches are also retained. To cancel this target, delete all comments requesting it before processing starts.`);
        continue;
      }
      const prefix = branchPrefix(number, target);
      const pulls = pages(`${apiRoot}/pulls?state=all&base=${encodeURIComponent(target)}&per_page=100`)
        .filter((pr) => pr.head.repo?.full_name === repository &&
          (pr.head.ref.startsWith(prefix) ||
            (new RegExp(`^cherry-pick/cp-${number}-[0-9]+$`).test(pr.head.ref) &&
             pr.body?.split('\n')[0] === `Generated from ${source.html_url}`)));
      const existing = pulls.find((pr) => pr.merged_at) || pulls.find((pr) => pr.state === 'open');
      if (existing) {
        autoMerge(existing);
        report('created', `The cherry-pick to \`${target}\` ${existing.merged_at ? 'was merged' : 'already has a pull request'}: ${existing.html_url}`);
        continue;
      }
      const closed = pulls.sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))[0];
      if (closed && Date.parse(request.created_at) <= Date.parse(closed.closed_at)) {
        report('closed', `The cherry-pick to \`${target}\` was closed without merging: ${closed.html_url}. To try again, post a new cherry-pick comment.`);
        continue;
      }
      // A different target's request must not repeatedly retry old failures.
      if (previous?.request === request.id && previous.phase === phase &&
          ['failed', 'empty', 'missing'].includes(previous.status) && Number(env.GITHUB_RUN_ATTEMPT || 1) === 1) continue;
      if (!branchExists(target)) {
        report('missing', `The branch \`${target}\` doesn't exist. Please check the branch name and post a new cherry-pick comment.`);
        continue;
      }
      const head = `${prefix}${request.id}`;
      const title = buildTitle(source.title, target, getIdentifiers(source.body, comments),
        (name) => result(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).status === 0);
      const body = buildBody(source.html_url, source.body, comments);
      const outcome = createBranch(target, head, source.merge_commit_sha, title);
      if (outcome === 'empty') {
        report('empty', `The changes are already present on \`${target}\`; there is nothing to cherry-pick.`);
        continue;
      }
      const pr = api(`${apiRoot}/pulls`, { head, base: target, title, body, draft: outcome === 'conflict' });
      report('created', outcome === 'conflict'
        ? `The cherry-pick to \`${target}\` has conflicts. Please resolve them in this draft pull request: ${pr.html_url}`
        : `A new pull request has been opened to cherry-pick to \`${target}\`: ${pr.html_url}`);
      autoMerge(pr);
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

function createBranch(target, head, sha, title) {
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
      const message = run('log', '-1', '--format=%B', 'FETCH_HEAD');
      if (!message.includes(`Cherry-picker-source: ${sha}`)) throw new Error(`Existing branch ${head} does not belong to this attempt`);
      return message.includes('Cherry-picker-conflicts: true') ? 'conflict' : 'clean';
    }
    if (remote.status !== 2) throw new Error(remote.stderr || 'Cannot inspect cherry-pick branch');
    run('fetch', 'origin', sha);
    const parents = run('rev-list', '--parents', '-n', '1', sha).split(' ');
    const picked = result(['-c', 'user.name=Cherry-pick Bot', '-c', 'user.email=noreply@github.com',
      'cherry-pick', '--no-commit', ...(parents.length > 2 ? ['-m', '1'] : []), sha], worktree);
    const conflicts = run('diff', '--name-only', '--diff-filter=U');
    if (picked.status !== 0 && !conflicts) throw new Error(picked.stderr || picked.stdout || 'Cherry-pick failed');
    if (conflicts) run('add', '--all');
    const diff = result(['diff', '--cached', '--quiet'], worktree);
    if (diff.status === 0) return 'empty';
    if (diff.status !== 1) throw new Error(diff.stderr || 'Cannot inspect cherry-pick changes');
    run('-c', 'user.name=Cherry-pick Bot', '-c', 'user.email=noreply@github.com',
      '-c', 'commit.gpgSign=false', 'commit', '-m', title, '-m',
      `Cherry-picker-source: ${sha}\nCherry-picker-conflicts: ${Boolean(conflicts)}`);
    run('push', 'origin', `HEAD:refs/heads/${head}`);
    return conflicts ? 'conflict' : 'clean';
  } finally {
    if (fs.existsSync(worktree)) git('worktree', 'remove', '--force', worktree);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

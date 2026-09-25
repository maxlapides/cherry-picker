const childProcess = require('node:child_process');
const fs = require('node:fs');

const ISSUE_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;

function buildTitle(sourceTitle, targetBranch, identifiers, branchExists) {
  let title = sourceTitle;
  while (true) {
    const prefix = title.match(/^\[([^\]]+)\](.*)$/);
    if (!prefix) break;

    const branch = prefix[1];
    if (![branch, `release/${branch}`, `release-${branch}`].some(branchExists)) break;
    title = prefix[2].trimStart();
  }

  const knownIds = identifiers.filter((id) => ISSUE_ID.test(id));
  const titleId = title.match(/^\[([A-Z][A-Z0-9]*-[0-9]+)\]/)?.[1];
  const primaryId = titleId && knownIds.includes(titleId) ? titleId : knownIds[0];
  if (primaryId && titleId !== primaryId) title = `[${primaryId}] ${title}`;

  const release = targetBranch.replace(/release(\/|-)/g, '').trim();
  return `[${release}] ${title}`;
}

function main(env = process.env) {
  const sourceTitle = childProcess.execFileSync('gh', [
    'pr', 'view', env.PR_NUMBER, '--json', 'title', '--jq', '.title',
  ], { encoding: 'utf8' }).trimEnd();
  const identifiers = (env.LINEAR_IDS || '').split(' ').filter(Boolean);
  const branchExists = (name) => [
    `refs/heads/${name}`, `refs/remotes/origin/${name}`,
  ].some((ref) => childProcess.spawnSync('git', [
    'show-ref', '--verify', '--quiet', ref,
  ]).status === 0);
  const title = buildTitle(sourceTitle, env.TO_BRANCH, identifiers, branchExists);
  fs.appendFileSync(env.GITHUB_OUTPUT, `title=${title}\n`, 'utf8');
}

module.exports = { buildTitle, main };

if (require.main === module) main();

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function requests(comments) {
  const targets = new Map();
  for (const comment of comments) {
    if (comment.user?.type === 'Bot') continue;
    const match = (comment.body || '').trim().split(/\r?\n/, 1)[0].trim().match(/^cherry-pick to[ \t]+([^\s]+)$/);
    if (!match) continue;
    const branch = match[1];
    // Validate as a full ref: --branch would expand special checkout syntax.
    if (spawnSync('git', ['check-ref-format', `refs/heads/${branch}`]).status !== 0 ||
        branch.startsWith('-')) continue;
    const previous = targets.get(branch);
    if (!previous || comment.id > previous.id) targets.set(branch, comment);
  }
  return targets;
}

function branchPrefix(number, target) {
  const hash = createHash('sha256').update(target).digest('hex').slice(0, 24);
  return `cherry-pick/cp-${number}-${hash}-`;
}

module.exports = { requests, branchPrefix };

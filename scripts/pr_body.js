// Build a cherry-pick description from Linear's GitHub linkback comments.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function getIdentifiers(sourceBody, comments) {
  // Preserve our relation lines when cherry-picking a cherry-pick, even before
  // Linear has posted its linkback on that PR.
  const identifiers = new Set(
    Array.from((sourceBody || '').matchAll(/^Related to ([A-Z][A-Z0-9]*-[0-9]+)\s*$/gm),
      (match) => match[1]),
  );
  for (const comment of comments) {
    const body = comment.body || '';
    if (comment.user?.type !== 'Bot' ||
        !['linear[bot]', 'linear-code[bot]'].includes(comment.user?.login) ||
        !body.includes('<!-- linear-linkback -->')) {
      continue;
    }
    // Linear uses HTML summaries for associated issues. References in the
    // embedded issue description must not become associations on the new PR.
    for (const summary of body.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi)) {
      for (const anchor of summary[1].matchAll(/<a\s+(?:[^>]*?\s)?href\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
        const match = anchor[2].match(/^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-[0-9]+)(?=[/?#]|$)/);
        if (match) identifiers.add(match[1].toUpperCase());
      }
    }
  }

  return [...identifiers].sort();
}

function buildBody(sourceUrl, sourceBody, comments) {
  const identifiers = getIdentifiers(sourceBody, comments);
  let body = `Generated from ${sourceUrl}`;
  if (identifiers.length) {
    body += '\n\n' + identifiers.map((id) => `Related to ${id}`).join('\n');
  }
  return body + '\n';
}

function ghJson(...args) {
  return JSON.parse(childProcess.execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }));
}

function main(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const prNumber = env.PR_NUMBER;
  const source = ghJson('api', `repos/${repository}/pulls/${prNumber}`);
  const pages = ghJson('api', '--paginate', '--slurp',
    `repos/${repository}/issues/${prNumber}/comments?per_page=100`);
  const comments = pages.flat();
  const body = buildBody(source.html_url, source.body, comments);
  const identifiers = getIdentifiers(source.body, comments);
  const bodyPath = path.join(env.RUNNER_TEMP, 'cherry-pick-pr-body.md');
  fs.writeFileSync(bodyPath, body, 'utf8');
  fs.appendFileSync(env.GITHUB_OUTPUT, `body_path=${bodyPath}\n`, 'utf8');
  fs.appendFileSync(env.GITHUB_OUTPUT, `linear_ids=${identifiers.join(' ')}\n`, 'utf8');
}

module.exports = { buildBody, getIdentifiers, main };

if (require.main === module) main();

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
  const titleIds = new Set((title.match(/\b[A-Z][A-Z0-9]*-[0-9]+\b/gi) || [])
    .map((id) => id.toUpperCase()));
  if (knownIds.length && !knownIds.some((id) => titleIds.has(id))) {
    title = `[${knownIds[0]}] ${title}`;
  }

  const release = targetBranch.replace(/release(\/|-)/g, '').trim();
  return `[${release}] ${title}`;
}

module.exports = { buildTitle };

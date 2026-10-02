// GitHub transport fixture. All cherry-pick and push operations use real local Git.
const fs = require('node:fs');
const cp = require('node:child_process');
function remoteHead(ref) {
  return cp.execFileSync('git', ['ls-remote', 'origin', `refs/heads/${ref}`], { encoding: 'utf8' }).split(/\s/)[0];
}
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
state.calls.push(args);
let value;
if (args[0] === 'pr') {
  if (state.failApproval && args[1] === 'review') {
    fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
    process.exit(1);
  }
  if (args[1] === 'review') state.reviews = [...(state.reviews || []), { number: Number(args.at(-1)), event: 'APPROVE' }];
  value = {};
} else {
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  if (args.includes('graphql')) value = { data: { viewer: { login: 'picker[bot]' } } };
  else if (args.includes('--input')) {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (endpoint.endsWith('/reviews')) {
      if (state.failApproval) {
        fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
        process.exit(1);
      }
      state.reviews = [...(state.reviews || []), { number: Number(endpoint.split('/').at(-2)), ...data }];
      value = data;
    } else if (endpoint.endsWith('/pulls')) {
      if (state.failCreateOnce) {
        state.failCreateOnce = false;
        fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
        process.exit(1);
      }
      value = { ...data, number: 100 + state.pulls.length, state: 'open', merged_at: null,
        html_url: `https://github.com/test/repo/pull/${100 + state.pulls.length}`, user: { login: 'picker[bot]' },
        head: { ref: data.head, sha: remoteHead(data.head), repo: { full_name: 'test/repo' } }, base: { ref: data.base } };
      state.pulls.push(value);
      if (state.loseCreateResponseOnce) {
        state.loseCreateResponseOnce = false;
        fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
        process.exit(1);
      }
    } else if (args.includes('PATCH')) {
      value = state.comments.find((comment) => comment.id === Number(endpoint.split('/').at(-1)));
      Object.assign(value, data);
    } else {
      value = { ...data, id: 1000 + state.comments.length, user: { login: 'picker[bot]', type: 'Bot' } };
      state.comments.push(value);
    }
  } else if (endpoint.endsWith('/pulls/42')) value = state.source;
  else if (/\/pulls\/\d+$/.test(endpoint)) {
    const pr = state.pulls.find((pr) => pr.number === Number(endpoint.split('/').at(-1)));
    if (!pr) throw new Error(`Unknown pull request: ${endpoint}`);
    value = { ...pr, head: { ...pr.head, sha: remoteHead(pr.head.ref) } };
  } else if (endpoint.includes('/comments?')) {
    if (state.failComments) {
      fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
      process.exit(1);
    }
    // Put requests on different pages to catch pagination regressions.
    value = [state.comments.slice(0, 1), state.comments.slice(1)];
  } else if (endpoint.includes('/pulls?')) {
    if (state.rejectHistory) {
      fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
      process.exit(1);
    }
    const target = new URL(`https://api.github.com/${endpoint}`).searchParams.get('base');
    const history = Array.from({ length: state.historyCount || 0 }, (_, i) => ({
      number: 9000 + i, body: 'x'.repeat(60000),
      head: { ref: `unrelated-${i}`, repo: { full_name: 'test/repo' } }, base: { ref: target },
    }));
    const pulls = [...history, ...state.pulls.filter((pr) => pr.base.ref === target)
      .map((pr) => ({ ...pr, head: { ...pr.head, sha: remoteHead(pr.head.ref) } }))];
    value = [];
    for (let i = 0; i < pulls.length; i += 100) value.push(pulls.slice(i, i + 100));
  } else throw new Error(`Unexpected API call: ${args}`);
}
fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
if (args.includes('--jq')) {
  // Evaluate the action's real filter instead of duplicating its selection policy.
  const filter = args[args.indexOf('--jq') + 1];
  for (const page of (args.includes('--paginate') ? value : [value])) process.stdout.write(cp.execFileSync('jq', ['-r', filter], {
    input: JSON.stringify(page), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
} else process.stdout.write(JSON.stringify(value));

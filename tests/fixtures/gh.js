// GitHub transport fixture. All cherry-pick and push operations use real local Git.
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
state.calls.push(args);
let value;
if (args[0] === 'pr') {
  if (state.failApproval && args[1] === 'review') {
    fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
    process.exit(1);
  }
  value = {};
} else {
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  if (args.includes('graphql')) value = { data: { viewer: { login: 'picker[bot]' } } };
  else if (args.includes('--input')) {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (endpoint.endsWith('/pulls')) {
      if (state.failCreateOnce) {
        state.failCreateOnce = false;
        fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
        process.exit(1);
      }
      value = { ...data, number: 100 + state.pulls.length, state: 'open', merged_at: null,
        html_url: `https://github.com/test/repo/pull/${100 + state.pulls.length}`,
        head: { ref: data.head, repo: { full_name: 'test/repo' } }, base: { ref: data.base } };
      state.pulls.push(value);
    } else if (args.includes('PATCH')) {
      value = state.comments.find((comment) => comment.id === Number(endpoint.split('/').at(-1)));
      Object.assign(value, data);
    } else {
      value = { ...data, id: 1000 + state.comments.length, user: { login: 'picker[bot]', type: 'Bot' } };
      state.comments.push(value);
    }
  } else if (endpoint.endsWith('/pulls/42')) value = state.source;
  else if (endpoint.includes('/comments?')) {
    // Put requests on different pages to catch pagination regressions.
    value = [state.comments.slice(0, 1), state.comments.slice(1)];
  } else if (endpoint.includes('/pulls?')) {
    const target = new URL(`https://api.github.com/${endpoint}`).searchParams.get('base');
    value = [state.pulls.filter((pr) => pr.base.ref === target)];
  } else throw new Error(`Unexpected API call: ${args}`);
}
fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
process.stdout.write(JSON.stringify(value));

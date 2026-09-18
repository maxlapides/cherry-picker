# Pull Request Cherry-Picker

Automates the process of cherry-picking a pull request to another branch. Leave a comment on your pull request such as:

```
cherry-pick to release/1.2.3
```

And let the cherry-picker handle the rest! A new pull request with the changes will be opened and, by default, configured to auto-approve and auto-merge.

If you want the cherry-pick PR to stay open for manual review and merge, set `auto_approve_and_merge: false` when using the action.

## Example

See `example-workflow.yml` for a complete example that you can copy/paste into your project and modify.

## Linear tickets

Cherry-pick PR descriptions carry over tickets from the source PR's Linear bot linkback comments, including tickets linked through the original branch name. Each ticket is listed once as `Related to TEAM-123`. Linear's [relation magic words](https://linear.app/docs/github#magic-words) associate the PR without changing the ticket's status.

The action reads all comment pages using the existing GitHub token; no Linear token is required. Only issue links in the summaries of `linear[bot]` or `linear-code[bot]` linkback comments are copied, not references inside embedded ticket descriptions or other users' comments. Generated `Related to TEAM-123` lines are also preserved when cherry-picking a cherry-pick.

This relies on Linear posting its linkback comment before the action runs. Associations without a linkback or an existing generated relation line cannot be discovered. A failed GitHub lookup stops PR creation rather than silently dropping tickets. Runners need Node.js in addition to the existing `gh`, `jq`, and Git requirements (all are available on GitHub-hosted Ubuntu runners). No npm dependencies are needed.

Run the description tests with `node --test tests/*.test.js`.

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

Cherry-pick PRs preserve the source PR's linked Linear tickets without changing their status. Linked ticket IDs are included in the title when they are not already present, and duplicate references are avoided.

## Multiple targets and retries

List multiple branches separated by spaces in one comment, or post a separate comment for each branch:

```
cherry-pick to release/88.0 release/87.0
```

You can request cherry-picks before or after the source PR merges. Requests made before merge are acknowledged and processed after merge. Keep the command on the first line; any notes can go below it.

- Each target gets its own cherry-pick PR. A failure on one target does not prevent the others from being processed.
- Repeated branches, whether in the same comment or separate comments, reuse an existing open or merged cherry-pick PR. Existing manual edits are preserved.
- Conflicts produce a draft PR for you to resolve. If the changes are already present, the bot reports that no PR is needed.
- To cancel a request before processing starts, delete all comments requesting that target. This does not undo an existing cherry-pick PR.
- If a target branch is missing or an attempt fails, correct the problem and post a new cherry-pick comment or rerun the workflow.
- If a cherry-pick PR was closed without merging, post a new request to try again.

The bot reports the outcome for each target on the source PR.

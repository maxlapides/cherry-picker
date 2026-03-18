# Pull Request Cherry-Picker

Automates the process of cherry-picking a pull request to another branch. Leave a comment on your pull request such as:

```
cherry-pick to release/1.2.3
```

And let the cherry-picker handle the rest! A new pull request with the changes will be opened and, by default, configured to auto-approve and auto-merge.

If you want the cherry-pick PR to stay open for manual review and merge, set `auto_approve_and_merge: false` when using the action.

## Example

See `example-workflow.yml` for a complete example that you can copy/paste into your project and modify.

# Triage commands

Issues and pull requests in this repository can be triaged with Prow-style slash commands, similar to Kubernetes. Write the command at the start of a line in a comment. You can put several commands in one comment, one per line. The bot reacts with 👍 when the commands are applied, and replies if one could not be applied.

## Triage flow

1. Every new issue gets the `needs-triage` label.
2. A maintainer or contributor checks it and comments `/triage accepted`, or `/triage needs-information` if more details are needed from the reporter.
3. Once an issue has `triage/accepted`, contributors can pick it up with `/assign` and open a pull request that references it.

Please wait for `triage/accepted` before starting work. It avoids spending time on a fix or feature that the maintainers would not merge.

## Commands for everyone

| Command | Effect |
| --- | --- |
| `/assign` | Assigns yourself. On issues, only once the issue has `triage/accepted`. |
| `/unassign` | Unassigns yourself. |
| `/close`, `/reopen` | Closes or reopens an issue or pull request you opened. |

## Commands for contributors and maintainers

Contributors are people who already have commits in this repository. They can help triage issues and pull requests opened by others, but not their own.

| Command | Effect |
| --- | --- |
| `/triage accepted` | Adds `triage/accepted` and removes `needs-triage`. |
| `/triage needs-information` | Adds `triage/needs-information` and removes `needs-triage`. |
| `/kind bug\|feature\|enhancement\|task\|question` | Adds the matching `kind/*` label. |
| `/area cli\|connectors\|build\|docs\|packaging` | Adds the matching `component/*` label. |
| `/platform windows\|linux\|macos` | Adds the matching `platform/*` label. |
| `/good-first-issue` | Adds `good first issue`. On issues, needs `triage/accepted` first. |
| `/help` | Adds `help wanted`. On issues, needs `triage/accepted` first. |

## Commands for maintainers

Maintainers are people with write access to this repository. They can use every command above, including on their own issues, and the following ones to correct or manage triage.

| Command | Effect |
| --- | --- |
| `/remove-triage` | Removes the `triage/*` labels and adds `needs-triage` back. |
| `/remove-kind`, `/remove-area`, `/remove-platform` | Removes the matching label, for example `/remove-kind bug`. |
| `/remove-good-first-issue`, `/remove-help` | Removes `good first issue` or `help wanted`. |
| `/keep-open` | Adds `keep-open`, so the stale bot skips the item. `/remove-keep-open` removes it. |
| `/assign @user`, `/unassign @user` | Assigns or unassigns someone else. GitHub only lets you assign people who have commented on the issue or have access to the repository. |
| `/close`, `/reopen` | Closes or reopens any issue or pull request. |

Commands inside code blocks or quoted lines (`> /kind bug`) are ignored, and unknown commands are ignored silently.

## Example

```text
/triage accepted
/kind bug
/area connectors
/good-first-issue
```

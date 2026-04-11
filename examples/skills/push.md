---
name: push
description: Push current branch and print PR URL
triggers: [push, open PR, create PR, push branch]
---
Push the current branch to origin and help the user open a PR.

Steps:
1. `git status --short` — check for uncommitted changes. Warn user if any.
2. `git branch --show-current` — get branch name
3. If branch is main/master: STOP and warn — pushing directly to main is blocked
4. `git push -u origin <branch>` — push with upstream tracking
5. `git remote get-url origin` — get repo URL
6. Parse the remote URL to build a PR creation URL:
   - GitHub: https://github.com/<owner>/<repo>/pull/new/<branch>
   - GitLab: https://gitlab.com/<owner>/<repo>/-/merge_requests/new?merge_request[source_branch]=<branch>
7. Print the PR URL for the user to click

Report: push result (commits pushed, bytes), PR URL.

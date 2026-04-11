---
name: stack
description: Show current git branch stack and status
triggers: [stack, branch stack, git status, current branch]
aliases: [st]
---
Run these commands to show the current state of the git branch:

1. `git status --short --branch` — branch name + ahead/behind + dirty files
2. `git log --oneline --decorate main..HEAD` — commits on current branch since main (skip if on main)
3. `git log --oneline -5` — last 5 commits on current branch

Format the output as a short summary:
- Current branch + upstream status
- How many commits ahead/behind main
- Unstaged / staged file counts
- Recent commit titles

Keep it under 15 lines. Do not show full diffs.

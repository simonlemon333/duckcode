---
name: sync
description: Rebase current branch on top of main (stacked workflow safe)
triggers: [sync, rebase, update branch, pull main]
---
Safely update the current branch with the latest changes from main.

Steps:
1. `git status --short` — confirm working tree is clean
2. If dirty: STOP and tell the user to commit or stash first. Do NOT proceed.
3. `git fetch origin main` — get latest main
4. Remember the current branch name: `git branch --show-current`
5. If NOT on main: `git rebase origin/main` on the current branch
6. If on main: `git pull --ff-only origin main`
7. Report: number of commits replayed, any conflicts

If rebase conflicts occur, STOP and show the user the conflicted files. Do NOT attempt to resolve them automatically.

---
name: commit
description: Generate a commit message for current changes
---
Run `git diff --cached` to see staged changes. If nothing is staged, run `git diff` for unstaged changes.

Generate a conventional commit message:
- Format: `type: short description`
- Types: feat, fix, refactor, chore, docs, test
- Keep the first line under 72 characters
- Add a body if the change is non-trivial

Show the suggested message, then ask if the user wants to commit.

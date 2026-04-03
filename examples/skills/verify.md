---
name: verify
description: Verify the last change actually works
---
Before claiming work is done, verify it:

1. Run the relevant test suite (find it via package.json scripts or test files)
2. Run the type checker if TypeScript (`npx tsc --noEmit`)
3. Run the linter if configured (`npm run lint` or equivalent)
4. If tests don't exist for the change, say so explicitly

Report results clearly: what passed, what failed, what wasn't tested.
Do NOT claim success without running the actual commands.

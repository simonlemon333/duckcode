---
name: verify
description: Verify the last change actually works
---
Before claiming work is done, verify it.

Step 1: Read `package.json` ONCE with file_read to discover scripts and dependencies.
Do NOT run multiple greps to detect test frameworks — just read the file.

Step 2: Based on what you saw in package.json, run the applicable checks:
- Type checker: `npm run typecheck` (if the script exists)
- Tests: `npm test` or `npm run test` (only if a test script exists)
- Linter: `npm run lint` (only if the script exists)

Step 3: If a check's script does NOT exist in package.json, say "not configured" — do not attempt to run it.

Step 4: Report results in a short markdown table. Be honest about what was and wasn't tested.
Do NOT claim success without actually running commands.

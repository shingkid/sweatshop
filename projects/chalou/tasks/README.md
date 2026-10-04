# Approve Chalou task contracts

Create one reviewed `issue-<number>.json` file for each approved Chalou issue.
These contracts belong to Sweatshop, outside the product worker's editable scope.
No product task contracts are supplied initially.
An eligible issue without a contract remains in `waiting-for-contract`.

A contract has exactly these fields:

```json
{
  "version": 1,
  "issueNumber": 123,
  "baseSha": "BASE_COMMIT_SHA",
  "titleHash": "TITLE_SHA256",
  "bodyHash": "BODY_SHA256",
  "allowedPaths": ["src/domain/", "tests/domain/"],
  "acceptancePath": "projects/chalou/acceptance/issue-123.test.mjs",
  "acceptanceHash": "ACCEPTANCE_SHA256"
}
```

This is a template, not a runnable approval.
Replace issue number `123` with the approved issue number in both the filename and JSON.
Replace `BASE_COMMIT_SHA` with the approved 40-character base commit SHA.
Replace the three SHA-256 placeholders with lowercase 64-character hashes of the exact issue title, issue body, and acceptance file bytes, respectively.
Use the empty string for a missing issue body; do not append a newline when hashing issue text.

Restrict `allowedPaths` to the smallest directory prefixes needed by the task.
Each prefix must end in `/` and fall within the project's configured scope.
Protected baseline files remain protected even within an approved prefix.
The acceptance path is relative to the Sweatshop root, not the product repository or this directory.

Review and commit the contract and [acceptance test](../acceptance/README.md) before pinning the controller revision used by the schedule.
The issue must be open and have the configured `ready-for-agent` label.
Changed issue text or acceptance bytes invalidate approval.
See the [operating guide](../../../docs/operating-guide.md) for execution and recovery.

# Operate Sweatshop

Sweatshop runs a shared controller against a selected product repository.
This guide covers project setup, task approval, execution, and recovery.
It describes the deployment procedure; it does not certify a live schedule or a completed product run.

## Trust and directory boundaries

Keep the controller checkout, product checkout, and runtime root in separate directory trees.
None can contain another.
Use a stable canonical product path because runtime identity records bind state to that path.

| Location | Purpose |
| --- | --- |
| `src/` | Shared engine, adapter, sandbox, watchdog, and CLI |
| `projects/<id>/project.json` | Trusted project identity, scope, checks, and limits |
| `projects/<id>/tasks/issue-<number>.json` | Approved immutable task contract |
| `projects/<id>/acceptance/<name>.test.mjs` | Independently authored acceptance test |
| `projects/<id>/checks/` | Project check implementations |
| `<state-root>/<id>/` | Identity binding, task state, workspaces, logs, and artifacts |

The runtime `identity.json` binds the project ID, canonical product checkout, GitHub repository, and account.
A mismatch blocks reuse rather than silently attaching another project to that state.
Do not edit this binding to repurpose a runtime directory.
Create a separate runtime root for an intentionally separate deployment.

Workers can change only the task's approved directory prefixes.
Existing files under protected prefixes remain protected even when their directory is in the editable scope.
For Chalou, `src/domain/` and `tests/domain/` are the project scope, and existing files under `tests/` are protected.
New tests can therefore be added within the approved test scope.

## Prepare a deployment

1. Install Node.js 26 or later, Git, GitHub CLI, and Codex CLI on the execution host.
2. Authenticate the GitHub account named in the project policy and prepare the product checkout with the exact configured `origin` URL.
3. Install the product dependencies needed by its trusted checks.
4. Review and commit the Sweatshop controller, project policy, check scripts, task contracts, and acceptance tests.
5. Run the controller test and syntax checks described in the [README](../README.md#development).
6. Record the approved Sweatshop commit SHA and keep its checkout clean.
7. Run `doctor` with the same project, source checkout, runtime root, and environment that the schedule will use.
8. Run an approved tick and inspect its state and evidence before enabling recurring execution.

Keep the recurring schedule paused during migration.
Configure it to use the approved controller checkout, the selected project, and its pinned revision only after deployment verification.
When changing a controller or project policy, pause execution and review the effect on in-progress state before changing the pinned revision.
Task and configuration fingerprints prevent silently resuming work under changed assumptions.

## Run and inspect a tick

Run commands from the Sweatshop checkout:

```sh
node src/cli.mjs doctor \
    --project projects/chalou/project.json \
    --repo /path/to/chalou \
    --state-root /path/to/runtime
```

Replace `/path/to/chalou` with the source repository root and `/path/to/runtime` with a separate runtime directory.
The doctor checks GitHub identity, repository permissions, remote and base branch, Codex availability, and actual sandbox denials.
It creates runtime identity and probe evidence but does not start a product task.

```sh
node src/cli.mjs tick \
    --project projects/chalou/project.json \
    --repo /path/to/chalou \
    --state-root /path/to/runtime \
    --expected-revision CONTROLLER_SHA
```

Replace `CONTROLLER_SHA` with the approved 40-character controller commit SHA.
The tick refuses a dirty controller or a revision mismatch.
It processes open issues with the project's eligible label in issue-number order.
An issue without an approved contract waits for one.
A full 100-issue intake page blocks the tick because the inventory might be incomplete.

```sh
node src/cli.mjs status \
    --project projects/chalou/project.json \
    --repo /path/to/chalou \
    --state-root /path/to/runtime
```

`status` reads the last tick summary and reports `not-run` if none exists.
It does not perform a fresh GitHub or sandbox check.
Inspect `<state-root>/chalou/last-tick.json`, the issue state, and recorded logs when investigating a result.
A `complete` state means the controller recorded a pull request whose head matched the verified commit.
Check GitHub separately for subsequent changes, review, CI, or merge status.

## Approve a task

1. Write a bounded product issue and settle its title and body.
2. Author an independent acceptance test under the selected project's `acceptance/` directory.
3. Record the approved base commit, issue hashes, acceptance hash, and narrower editable scope in the [task contract](../projects/chalou/tasks/README.md).
4. Review and commit the contract and test in Sweatshop, then approve that controller revision for execution.
5. Apply the project's eligible label to the approved open issue.

Approval covers exact issue and test bytes.
Changing the title, body, acceptance test, task contract, or runtime configuration can block execution or recovery.
Do not manufacture contracts merely to make a waiting issue runnable.

## Checks and verification artifacts

Each `checks` entry defines a unique `name`, executable `command`, argument array `args`, and additional `readablePaths`.
Commands are executed as argument vectors, without shell expansion.
The supported placeholders are `{node}`, `{project}`, `{repo}`, and `{workspace}`.
They resolve to the running Node executable, trusted project directory, source repository, and captured verification workspace.
Additional readable paths must start with `{repo}/` or `{project}/`.
Grant only the dependencies a check requires.

Acceptance tests and project checks receive these environment variables:

| Variable | Value |
| --- | --- |
| `FACTORY_WORKSPACE` | Captured candidate workspace to verify |
| `FACTORY_SOURCE` | Original product repository path |
| `FACTORY_CHANGED_FILES` | JSON array of changed relative file paths |
| `FACTORY_BASELINE_FILES` | JSON array of baseline relative file paths |

Test candidate behavior through `FACTORY_WORKSPACE`.
An environment variable does not grant filesystem access.
Verification runs with sandbox permissions, and tests must not depend on undeclared host files or network access.

The controller checks changed paths and captures candidate bytes in a separate verification artifact.
It runs the independent acceptance test and configured checks against that artifact, then records a commit and evidence.
Publication uses the verified artifact rather than the worker's mutable workspace.
Watchdogs supervise worker and check processes, and recovery requires evidence that an interrupted worker has stopped.

## Recover blocked or interrupted work

1. Pause the schedule before investigation.
2. Preserve task state, worker receipts, logs, and verification artifacts.
3. Read the reported reason and compare the approved contract, controller revision, project policy, and source identity.
4. Inspect GitHub for the recorded branch and verified commit if publication was interrupted.
5. Resolve the cause and explicitly plan any replacement run before changing or removing state.

Interrupted work consumes the existing attempt and elapsed-time budget.
The controller first checks worker termination before retrying interrupted work.
An interrupted publication is reconciled by reading GitHub; it is not blindly republished.
Unknown publication outcomes, multiple matching pull requests, or a head mismatch block completion.
A blocked record is terminal for automatic execution.
Do not delete it to obtain extra attempts or discard uncertainty.

## Add a project

1. Choose a unique lowercase project ID using letters, digits, and internal hyphens.
2. Create `projects/<id>/project.json` from the Chalou policy and update `id`, `repository`, `account`, `remote`, `baseBranch`, and `eligibleLabel`.
3. Set project-specific `allowedPaths` and `protectedPaths` as relative directory prefixes ending in `/`.
4. Add trusted checks under `projects/<id>/checks/` and configure their executable arguments and read access.
5. Create `tasks/` and `acceptance/` directories, then approve contracts only for that project's issues.
6. Review and commit the project files alongside the shared controller revision.
7. Run the deployment procedure with the new project path and source checkout.

A shared runtime root creates a separate `<state-root>/<id>/` directory for each project.
Use the same shared `src/` implementation; do not copy it into the product repository.
Keep task acceptance paths inside their own `projects/<id>/acceptance/` directory.
The built-in limits permit at most two attempts, 30 minutes of elapsed task budget, 10 minutes per worker, two minutes per check, and one started task per tick.
Lower these values when appropriate; increasing them requires changing the controller's validation policy.

## Evidence limits

Controller tests cover the behaviors represented by their fixtures and scenarios.
A passing sandbox probe establishes the exercised denials on that host, not universal isolation guarantees.
A successful product task establishes one checked pull request, not production reliability.
Execution limits do not measure or cap dollar spending.
Human review, product CI, merge decisions, and deployment remain separate responsibilities.

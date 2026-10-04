# Sweatshop

Sweatshop is a reusable AI software factory that turns approved GitHub issues into independently checked pull requests.
Chalou is the first pilot project.
The factory has its own checkout; product code stays in each project's source repository.

The shared `src/` controller owns task state, worker execution, recovery, verification artifacts, and pull request publication.
Each trusted `projects/<id>/project.json` selects a repository, GitHub account, remote, base branch, editable scope, protected scope, and checks.
Approved task contracts and acceptance tests also live under that project directory, outside the worker's control.
Runtime evidence lives under `<state-root>/<id>/`, separately from both the controller and product repositories.

## Run a project

Use Node.js 26 or later, Git, GitHub CLI, and an authenticated Codex CLI with the required sandbox support.
Read the [operating guide](docs/operating-guide.md) before scheduling a run.
From the Sweatshop checkout, check the Chalou setup:

```sh
node src/cli.mjs doctor \
    --project projects/chalou/project.json \
    --repo /path/to/chalou \
    --state-root /path/to/runtime
```

Replace `/path/to/chalou` with the product checkout and `/path/to/runtime` with a separate runtime directory.
`doctor` validates the configured GitHub identity and repository, exercises sandbox enforcement, and checks Codex availability.
A successful result is a setup check, not proof that a product task can complete.

A tick requires a clean controller checkout and an explicitly pinned controller commit:

```sh
node src/cli.mjs tick \
    --project projects/chalou/project.json \
    --repo /path/to/chalou \
    --state-root /path/to/runtime \
    --expected-revision CONTROLLER_SHA
```

Replace `CONTROLLER_SHA` with the approved 40-character Sweatshop commit SHA.
A tick starts at most one task and accepts only eligible issues with a committed [task contract](projects/chalou/tasks/README.md) and [acceptance test](projects/chalou/acceptance/README.md).
No product task contracts are supplied initially.

## Limits and delivery

The policy allows at most two work attempts per task, a 30-minute elapsed task budget, a 10-minute worker timeout, and a two-minute timeout per check.
Projects can lower these limits.
The elapsed budget is checked between stages; it is not an exact wall-clock termination deadline.
These are execution limits, not a dollar spending cap.

The controller publishes a verified commit to `factory/issue-<number>` and reads back the pull request head.
It does not merge pull requests or deploy products.
Automated checks and sandbox probes do not establish production reliability.

## Development

Run the shared controller checks from this repository:

```sh
npm test
```

```sh
npm run check
```

See the [operating guide](docs/operating-guide.md#add-a-project) to add a second project without copying the controller.

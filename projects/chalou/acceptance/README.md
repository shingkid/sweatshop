# Author Chalou acceptance tests

Write independent Node.js tests as single `*.test.mjs` files in this directory.
Use filenames containing only letters, digits, underscores, and hyphens before `.test.mjs`.
For example, the contract for issue 123 can reference `projects/chalou/acceptance/issue-123.test.mjs`.
No product acceptance tests are supplied initially.

Acceptance tests express the approved behavior and remain outside the product worker's editable scope.
Review them independently of the candidate implementation.
A meaningful test must reject a known incorrect result as well as accept the requested behavior.
Do not weaken acceptance merely to make an attempt pass.

The controller runs each selected file with `node --test` in a sandbox against a captured candidate artifact.
Resolve candidate modules and files from `process.env.FACTORY_WORKSPACE`, rather than the working directory of the authoring shell or `FACTORY_SOURCE`.
`FACTORY_CHANGED_FILES` and `FACTORY_BASELINE_FILES` contain JSON arrays of relative paths.
Access to other files and the network is restricted by the verification sandbox.

Keep each acceptance test self-contained.
The contract hashes the selected test file; importing unreviewed external helpers would weaken that approval boundary.
Project-wide checks belong in `../checks/` and are configured in `../project.json`.

Commit the reviewed test with its [task contract](../tasks/README.md) in Sweatshop.
Any change to the test bytes requires a new hash and reviewed controller revision.
A passing acceptance test is one part of verification; all configured project checks must also pass before publication.

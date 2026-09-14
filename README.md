# AI Improves Lives

A community-maintained collection of examples of AI improving people's lives.

See [goals.md](goals.md) for the purpose and [todos.md](todos.md) for next steps.

[Entry criteria](entry-criteria.md) defines what qualifies. [CONTRIBUTING.md](CONTRIBUTING.md) describes the fields, Issue intake, human review, and updates.

Profiles and Impacts live in `data/` as one JSON file per record. Validate with `python3 scripts/catalog.py validate`; run tests with `python3 -m unittest discover -s tests`. GitHub Actions runs both on PRs. Website source will live in `src/`; webpage UX is deferred.

Issue submissions and `/update` JSON comments generate linked PRs through ordinary code. Merged records build into a catalog artifact; public hosting is still to be added. See the repository setup steps in CONTRIBUTING.md to activate the workflows.

---
name: git-commit
description: Commit message rules for pi-extension-settings-tui. Every commit subject must start with a Conventional Commits type (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert), and feat/fix commits are what users see first in CHANGELOG.md. Use whenever writing a git commit message, committing changes, squashing, or choosing how to describe a change in this repo.
---

# Git commit guidelines

## Format

```text
<type>[(scope)][!]: <description>

[optional body: why, not what]

[optional trailers — never Co-Authored-By: Claude or any AI attribution]
```

- **type**: exactly one of the [Conventional Commits](https://www.conventionalcommits.org/) / Angular types below (lowercase).
- **scope** (optional): lowercase area of the codebase, e.g. `schema`, `store`, `dialog`, `adapter`, `release`, `docs`, `deps`.
- **`!`**: marks a breaking change. Also explain the break in the body.
- **description**: imperative mood ("add", not "added"/"adds"), no trailing period. Keep the subject at about 72 characters or fewer.

## Choosing the type

| Type       | Use for | CHANGELOG.md group (git-cliff defaults) |
|------------|---------|------------------------------------------|
| `feat`     | New or changed **user-facing** library behaviour: new fields, options, exports, dialog capabilities | 🚀 Features |
| `fix`      | A **user-facing** bug fix: wrong behaviour, crashes, rendering/mouse/storage bugs | 🐛 Bug Fixes |
| `docs`     | README, `docs/`, AGENTS.md, code comments only | 📚 Documentation |
| `style`    | Formatting/whitespace, no code change | 🎨 Styling |
| `refactor` | Code change with no behaviour change | 🚜 Refactor |
| `perf`     | Performance improvement | ⚡ Performance |
| `test`     | Adding or fixing tests only | 🧪 Testing |
| `build`    | Build system, tsconfig, packaging, dependencies | 💼 Other |
| `ci`       | GitHub Actions workflows, release automation | ⚙️ Miscellaneous Tasks |
| `chore`    | Tooling, git hooks, agent skills, repo maintenance | ⚙️ Miscellaneous Tasks |
| `revert`   | Reverting a previous commit | ◀️ Revert |

Not listed in the changelog: `chore(release): vX.Y.Z` bump commits, `chore(deps…)`, `chore(pr)` and `chore(pull)`.

Rules of thumb:
- If a consumer of the npm package would notice the change, it is `feat` or `fix` (add `!` if it breaks them). Don't hide user-facing changes under `chore` or `refactor`. **`feat` and `fix` must always reach the changelog**, so never classify them as a skipped `chore(...)` scope.
- A user-facing change plus its docs and tests is one `feat` or `fix` commit, not three.
- One logical change per commit. Split unrelated changes into separate commits (stage with `git add <paths>` / `git add -p`); never bundle them into one large commit.
- A commit whose body mentions "security" is grouped under 🛡️ Security.

## Examples

```text
feat(dialog): add collapsible groups to multi-select route
fix(store): reject symlinked .pi directory in project scope
feat(schema)!: rename field.select to field.enum
docs: document session storage adapter
refactor(dialog): extract frame height budgeting
build(deps): bump typescript to 5.9
ci: add tag-triggered npm release workflow
chore(hooks): enforce commit message prefixes
chore(release): v0.6.0
```

## Enforcement

`.githooks/commit-msg` rejects any subject that doesn't match
`^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(scope\))?!?: <description>`. Merge, revert, `fixup!`, `squash!` and `amend!` commits are let through. `npm install` runs the `prepare` script, which sets `git config core.hooksPath .githooks`; run that command manually if hooks aren't active.

- Only force past the hook (`git commit --no-verify`) when the user explicitly asks for it. Never do it on your own to get around a rejection. Fix the message instead.
- Changelog: `CHANGELOG.md` is generated from these subjects by git-cliff (see `cliff.toml` and the `release` skill). Never hand-edit it. A good subject line is the changelog entry.

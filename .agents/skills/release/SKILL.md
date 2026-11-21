---
name: release
description: Cut a new npm release of pi-extension-settings-tui by bumping the version (major, minor, or patch), regenerating CHANGELOG.md with git-cliff, committing, tagging vX.Y.Z, and pushing to GitHub so .github/workflows/release.yml publishes it via npm Trusted Publishing. Use when the user runs /release major, /release minor, /release patch (optionally with --watch or "watch"), or asks to cut/ship/publish a release.
---

# /release

Releases are published by GitHub Actions (`.github/workflows/release.yml`) when a `vX.Y.Z` tag is pushed. **Never run `npm publish` locally.** Invoking this skill is the user's explicit authorization to create and push the release tag.

## Arguments

- **Bump type** (required): `major`, `minor`, or `patch`. If missing or anything else, ask the user which one — do not guess.
- **Watch mode** (optional): enabled if the arguments contain `--watch` or the word `watch`. Otherwise fire-and-forget.

Examples: `/release patch`, `/release minor --watch`, `/release major watch`.

## Steps

### 1. Preflight

```bash
git rev-parse --abbrev-ref HEAD   # must be: main
git status --porcelain             # must be empty
git fetch origin --tags
git status -sb                     # must not be behind origin/main
```

- Not on `main`, dirty tree, or behind `origin/main` → stop and tell the user. Do not stash, reset, or pull on their behalf without asking.
- Ahead of `origin/main` is fine (those commits ship with the release); mention them.

### 2. Verify

Run the full offline verification from AGENTS.md; stop on any failure and report the output:

```bash
npm run clean && npm run typecheck && npm test && npm pack --dry-run
```

### 3. Bump version (package.json + package-lock.json in sync)

```bash
npm version <major|minor|patch> --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
```

Make sure the tag `v$VERSION` does not already exist locally or on origin (`git rev-parse -q --verify "refs/tags/v$VERSION"`, `git ls-remote --tags origin "v$VERSION"`). If it does, stop.

### 3b. Regenerate CHANGELOG.md (git-cliff, config in `cliff.toml`)

Always regenerate the **whole** file. Never use `--prepend`/`--unreleased` and never hand-edit `CHANGELOG.md`. Full regeneration rebuilds every `vX.Y.Z` tag from git history, so a release that was tagged without updating the changelog is backfilled here automatically.

```bash
GITHUB_TOKEN=$(gh auth token 2>/dev/null) npx git-cliff --tag "v$VERSION" -o CHANGELOG.md
grep -n "^## \[$VERSION\]" CHANGELOG.md   # must match
git diff --stat CHANGELOG.md
```

- `--tag` labels the not-yet-tagged commits as `v$VERSION`. Each section lists every commit since the previous tag (minus `chore(release)` bumps), grouped by Conventional Commit type, with PR links when commits came from PRs.
- `GITHUB_TOKEN` is optional. With it, git-cliff resolves PR numbers and titles through the GitHub API; without it, commits are still listed.
- Show the user the new `## [$VERSION]` section. If older sections changed too, a previous release was missing an entry; say so.

### 4. Commit and tag

Follow the existing convention (`chore(release): vX.Y.Z`, annotated tag):

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): v$VERSION" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git tag -a "v$VERSION" -m "v$VERSION"
```

(Use the commit attribution trailer given in the current session's instructions, if any, instead of the generic one above.)

### 5. Push

```bash
git push origin main
git push origin "v$VERSION"
```

Push the tag explicitly (not `--tags`) so stale local tags are never published.

### 6a. Without watch — fire and forget

Report: the new version, the tag pushed, and the Actions URL
(`https://github.com/championswimmer/pi-extension-settings-tui/actions/workflows/release.yml`). Done.

### 6b. With watch — confirm the release landed

1. **GitHub Action.** The run may take a few seconds to register after the push:

   ```bash
   gh run list --workflow release.yml --limit 5 --json databaseId,headBranch,status,conclusion,url
   ```

   Pick the run whose `headBranch` is `v$VERSION` (retry a few times, ~5s apart, if not there yet), then:

   ```bash
   gh run watch <databaseId> --exit-status
   ```

   Run this in the background (it can take a few minutes) and wait for the completion notification instead of polling. If it fails, show `gh run view <databaseId> --log-failed` (tail of it) and stop — do not retry or re-tag automatically.

2. **npm registry.** After the action succeeds, confirm the publish is visible (registry propagation can lag briefly; retry up to ~6 times, ~10s apart):

   ```bash
   npm view pi-extension-settings-tui@$VERSION version
   npm view pi-extension-settings-tui dist-tags
   ```

   Succeeds when the first command prints `$VERSION` and (for non-prerelease versions) `latest` points at it.

3. Report: version, run URL + conclusion, npm `latest` dist-tag, and the GitHub Release URL (`gh release view "v$VERSION" --json url -q .url`).

## Failure recovery (only with user confirmation)

If the workflow fails after the tag was pushed, fix forward with a new patch release rather than moving the tag. Deleting/re-pushing a tag (`git push origin :refs/tags/vX.Y.Z`) is only acceptable if npm never received the version, and only after the user explicitly agrees.

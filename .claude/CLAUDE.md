# NanoClaw Fork Instructions

This fork has the Telegram channel skill installed.

## Update Workflow

When bringing in upstream updates:

```bash
git fetch upstream
git rebase upstream/main
git merge telegram/main    # Re-merge the Telegram skill
npm install && npm run build && npm test
systemctl --user restart nanoclaw
git push origin dev --force
```

After the rebase, re-disable any upstream workflows that require secrets:

```bash
for f in fork-sync-skills bump-version update-tokens merge-forward-skills; do
  [ -f .github/workflows/$f.yml ] && git mv .github/workflows/$f.yml .github/workflows/$f.yml.disabled
done
```

Commit if any were re-enabled by upstream, then push.

## Installed Skills

- **Telegram** - merged from `telegram/main` remote (https://github.com/qwibitai/nanoclaw-telegram)

## Remotes

- `origin` - your fork (shrwnsan/nanoclaw)
- `upstream` - main repo (qwibitai/nanoclaw)
- `telegram` - Telegram channel skill (qwibitai/nanoclaw-telegram)

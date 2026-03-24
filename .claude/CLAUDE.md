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

## Installed Skills

- **Telegram** - merged from `telegram/main` remote (https://github.com/qwibitai/nanoclaw-telegram)

## Remotes

- `origin` - your fork (shrwnsan/nanoclaw)
- `upstream` - main repo (qwibitai/nanoclaw)
- `telegram` - Telegram channel skill (qwibitai/nanoclaw-telegram)

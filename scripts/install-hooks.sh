#!/usr/bin/env bash
# INSTALL THE GIT HOOKS. `.git/hooks` is per-clone and not version controlled, which is
# exactly why this script is: a hook that only exists on the laptop where somebody once
# pasted it is worth nothing. Run it after a fresh clone, and re-run it any time to
# overwrite with the current version.
#
#   scripts/install-hooks.sh
#
# pre-commit — the check gate (scripts/check-gate.sh), skipped for markdown-only commits.
# pre-push   — the drop guard (scripts/drop-guard-pre-push.sh): private/trunk never leaves
#              this machine, and a push of it becomes a squash-to-main.sh drop instead.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hooks="$root/.git/hooks"

if [ -e "$hooks/pre-commit" ] && ! grep -q 'timeline-studio check gate' "$hooks/pre-commit"; then
  echo "✗ $hooks/pre-commit exists and is not this one — merge by hand rather than losing it." >&2
  exit 1
fi

cat > "$hooks/pre-commit" <<'HOOK'
#!/usr/bin/env bash
# timeline-studio check gate — installed by scripts/install-hooks.sh
#
# WHY PRE-COMMIT AND NOT PRE-PUSH. Pre-push here is the publish guard: a trunk push turns
# into a squash-to-main drop, so by the time it runs you are already shipping.
# squash-to-main.sh builds its commit with `git commit-tree`, which is plumbing and does
# not fire this hook, so publishing does not pay for the suite twice.
#
# Skipped when every staged path is markdown. Deliberate override: git commit --no-verify
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
staged="$(git diff --cached --name-only --diff-filter=ACMR)"
[ -z "$staged" ] && exit 0
if ! printf '%s\n' "$staged" | grep -qvE '\.md$'; then
  echo "· markdown only, skipping the check gate"
  exit 0
fi
exec "$root/scripts/check-gate.sh"
HOOK
chmod +x "$hooks/pre-commit"
echo "✓ installed $hooks/pre-commit"

cp "$root/scripts/drop-guard-pre-push.sh" "$hooks/pre-push"
chmod +x "$hooks/pre-push"
echo "✓ installed $hooks/pre-push"

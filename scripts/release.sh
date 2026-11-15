#!/usr/bin/env bash
# Check, bump, commit and tag a release locally; never pushes. scripts/release.sh X.Y.Z [--dry-run] [-m msg]
set -euo pipefail

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok  %s\n' "$*"; }

version='' dry=0 message=''
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    -m) shift; message=${1:-} ;;
    -*) die "unknown flag $1" ;;
    *) [ -z "$version" ] || die "one version only"; version=$1 ;;
  esac
  shift
done
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh X.Y.Z [--dry-run] [-m message]"
tag="v$version"
cd "$(git rev-parse --show-toplevel)"

echo "checks for $tag"
[ "$(git branch --show-current)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean (git status)"
ok "on a clean main"

git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "main and origin/main differ: push or pull first ($(git rev-list --left-right --count HEAD...origin/main | tr '\t' ' ') ahead/behind)"
ok "main is even with origin"

git rev-parse --quiet --verify "refs/tags/$tag" > /dev/null && die "tag $tag exists locally (git tag -d $tag if it was never pushed)"
[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || die "tag $tag is already on origin"
ok "$tag is new"

current=$(jq -r .version package.json)
[ "$current" != "$version" ] || die "package.json is already $version"
[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n 1)" = "$version" ] || die "$version is not after $current"
ok "$current -> $version"

# The npmjs.com trusted publisher names this file; a rename breaks publishing.
[ -f .github/workflows/publish.yml ] || die ".github/workflows/publish.yml is missing (npm's trusted publisher names it)"
ok "publish.yml is in place"

echo "tests"
log=$(mktemp -t hookshot-release)
pnpm -s typecheck > "$log" 2>&1 || die "pnpm typecheck failed (see $log)"
pnpm -s test > "$log" 2>&1 || die "pnpm test failed (see $log)"
ok "typecheck and the full suite pass"

if [ "$dry" = 1 ]; then
  echo "dry run: all checks pass; nothing changed"
  exit 0
fi

npm pkg set "version=$version"
git commit --quiet -m "build(release): bump version to $version" -- package.json
git tag -a "$tag" -m "${message:-$tag}"
ok "committed $(git rev-parse --short HEAD) and tagged $tag"

cat <<EOF

Push in this order; the tag push starts the release and the npm publish:
  git push origin main
  git push origin $tag
EOF

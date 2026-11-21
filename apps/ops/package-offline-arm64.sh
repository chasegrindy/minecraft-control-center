#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ $# -ne 1 || ! $1 =~ ^[0-9][a-z0-9.-]{0,47}$ ]]; then
  printf 'Podaj identyfikator gotowego wydania MCC.\n' >&2
  exit 2
fi

id=$1
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
releases="$project/releases"
input="$releases/mcc-$id"
release="mcc-$id.tar.gz"
name="mcc-$id-linux-arm64-offline"
destination="$releases/$name"
node_release=v24.22.3
node_dist="node-$node_release-linux-arm64"
node_sha=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c

command -v npm >/dev/null
test ! -e "$destination"
test ! -L "$destination"
work=$(mktemp -d)
sealed=
cleanup() {
  rm -rf -- "$work"
  if [[ -n "$sealed" ]]; then rm -rf -- "$sealed"; fi
}
trap cleanup EXIT

(cd "$input" && sha256sum -c "$release.sha256")
mkdir -p "$work/payload/runtime/bin"
tar -xzf "$input/$release" -C "$work/payload" --no-same-owner --no-same-permissions
curl --fail --silent --show-error --location --max-time 90 \
  --output "$work/$node_dist.tar.xz" "https://nodejs.org/dist/$node_release/$node_dist.tar.xz"
printf '%s  %s\n' "$node_sha" "$work/$node_dist.tar.xz" | sha256sum -c -
tar -xJf "$work/$node_dist.tar.xz" -C "$work" --no-same-owner --no-same-permissions \
  "$node_dist/bin/node" "$node_dist/LICENSE"
install -m 0755 "$work/$node_dist/bin/node" "$work/payload/runtime/bin/node"
install -m 0644 "$work/$node_dist/LICENSE" "$work/payload/runtime/LICENSE"
printf '%s\n' "$node_dist" > "$work/payload/runtime/VERSION"

cd "$work/payload"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$work/npm-cache"
npm ls --omit=dev --depth=0
if [[ -n $(find node_modules -name '*.node' -print -quit) ]]; then
  printf 'Zależność zawiera skompilowany moduł. Przygotuj ją osobno dla ARM64.\n' >&2
  exit 1
fi

sealed=$(mktemp -d "$releases/.arm64-offline.XXXXXXXX")
tar -czf "$sealed/$name.tar.gz" apps dist node_modules ops runtime package.json package-lock.json release.json
(cd "$sealed" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
mv -T -n -- "$sealed" "$destination"
if [[ -d "$sealed" ]]; then
  printf 'Paczka offline o tym identyfikatorze już istnieje.\n' >&2
  exit 1
fi
sealed=
printf '%s\n' "$destination/$name.tar.gz"

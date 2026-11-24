#!/usr/bin/env bash
set -euo pipefail
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
tag="android-v${version}-${ANDROID_VERSION_CODE}"
mapfile -t apks < <(find src-tauri/gen/android/app/build/outputs/apk -name '*universal*release*.apk')
[[ ${#apks[@]} -eq 1 ]]
apk=src-tauri/gen/android/app/build/email-os-android-release.apk
cp "${apks[0]}" "$apk"
scripts/android/verify-release.sh "$apk" "$version" "$ANDROID_VERSION_CODE" "$ANDROID_RELEASE_CERT_SHA256"
# Inspect all releases, including drafts, before changing any remote state.
gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" --slurp > src-tauri/gen/android/app/build/releases.json
set +e
python3 - "$tag" "$ANDROID_VERSION_CODE" src-tauri/gen/android/app/build/releases.json <<'PY'
import json, re, sys
pages = json.load(open(sys.argv[3]))
for release in (r for page in pages for r in page):
    match = re.fullmatch(r'android-v.+-(\d+)', release['tag_name'])
    if not match: continue
    code = int(match[1])
    if not release['draft'] and code >= int(sys.argv[2]):
        print('Published release already has this or a higher code'); sys.exit(3)
    if code == int(sys.argv[2]) and release['tag_name'] != sys.argv[1]:
        raise SystemExit('Version code belongs to another release')
PY
status=$?
set -e
if [[ $status == 3 ]]; then exit 0; fi
[[ $status == 0 ]] || exit "$status"
previous=$(python3 - src-tauri/gen/android/app/build/releases.json <<'PY'
import json, re, sys
releases = [r for page in json.load(open(sys.argv[1])) for r in page if not r['draft'] and re.fullmatch(r'android-v.+-\d+', r['tag_name'])]
print(max(releases, key=lambda r: int(r['tag_name'].rsplit('-', 1)[1]))['tag_name'] if releases else '140d4e0103c0178afee10ca864fdd7ec344960bf')
PY
)
git merge-base --is-ancestor "$previous" "$GITHUB_SHA"
# Existing tags must resolve to the exact checked-out commit.
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  [[ $(git rev-list -n 1 "$tag") == "$GITHUB_SHA" ]]
else
  gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs" \
    -f "ref=refs/tags/$tag" -f "sha=$GITHUB_SHA" >/dev/null
fi
notes=src-tauri/gen/android/app/build/release-notes.md
{
  printf 'Commit: %s\nVersion: %s (%s)\nSize: %s bytes\nSHA-256: %s\n\n' "$GITHUB_SHA" "$version" "$ANDROID_VERSION_CODE" "$(stat -c %s "$apk")" "$(sha256sum "$apk" | cut -d' ' -f1)"
  # Digests only: the certificate DN names the owner and stays out of public notes.
  "$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$apk" | grep -v 'certificate DN:'
  printf '\n## Changes\n\n'
  git log --format='- %s (%h)' "$previous..$GITHUB_SHA"
} > "$notes"
if gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null | grep -qx true; then
  # The checked tag and current draft allow retrying a partially uploaded build.
  gh release upload "$tag" "$apk" --clobber
  gh release edit "$tag" --notes-file "$notes"
else
  gh release create "$tag" "$apk" --draft --title "$tag" --notes-file "$notes" --verify-tag
fi
gh release edit "$tag" --draft=false

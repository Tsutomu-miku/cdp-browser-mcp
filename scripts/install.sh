#!/bin/sh
set -eu

fail() {
  printf 'cdp-browser-mcp: %s\n' "$*" >&2
  exit 1
}

prefix_help() {
  printf '%s\n' \
    'No sudo is run. Choose a writable npm prefix, for example:' \
    '  curl -fsSL https://raw.githubusercontent.com/Tsutomu-miku/cdp-browser-mcp/main/scripts/install.sh -o install.sh && NPM_CONFIG_PREFIX="$HOME/.local" sh install.sh' \
    'Then add $HOME/.local/bin to your shell and MCP client PATH.' >&2
}

for command in node npm curl; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
done
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) process.exit(1);
' || fail 'Node.js 22.12+ is required.'

prefix=${NPM_CONFIG_PREFIX:-$(npm config get prefix)}
case "$prefix" in
  /*) ;;
  *) fail 'npm prefix must be an absolute path. Set NPM_CONFIG_PREFIX.' ;;
esac
export NPM_CONFIG_PREFIX="$prefix"
for destination in "$prefix/lib/node_modules" "$prefix/bin"; do
  parent=$destination
  while [ ! -e "$parent" ]; do
    parent=$(dirname "$parent")
  done
  if [ ! -d "$parent" ] || [ ! -w "$parent" ]; then
    prefix_help
    fail "npm installation directory is not writable: $parent"
  fi
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/cdp-browser-mcp-install.XXXXXX")
trap 'rm -rf "$work_dir"' 0
trap 'exit 1' HUP INT TERM
repository=https://github.com/Tsutomu-miku/cdp-browser-mcp
version=${VERSION:-latest}
if [ "$version" = latest ]; then
  if ! curl -fsSL --output "$work_dir/release.json" \
    https://api.github.com/repos/Tsutomu-miku/cdp-browser-mcp/releases/latest; then
    fail 'Cannot resolve latest GitHub Release. You can use git clone to build from source instead; see CONTRIBUTING.md.'
  fi
  version=$(node -e '
    const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof release.tag_name !== "string" || !release.tag_name) throw Error("Release tag_name is missing");
    console.log(release.tag_name);
  ' "$work_dir/release.json") || fail 'Invalid GitHub Release metadata. You can use git clone to build from source instead; see CONTRIBUTING.md.'
fi
case "$version" in
  v[0-9]*) ;;
  *) fail 'VERSION must be latest or a release tag such as v0.2.0.' ;;
esac
case "$version" in
  *[!a-zA-Z0-9._+-]*) fail 'Release tag contains unsupported characters.' ;;
esac
package_version=${version#v}
archive="$work_dir/cdp-browser-mcp-$package_version.tgz"
url="$repository/releases/download/$version/cdp-browser-mcp-$package_version.tgz"
printf 'Downloading %s\n' "$url"
if ! curl -fsSL --output "$archive" "$url"; then
  fail "Release tgz is unavailable: $url. You can use git clone to build from source instead; see CONTRIBUTING.md. No source build was attempted."
fi

# npm installs this local archive and its runtime dependencies, never the registry namesake.
if ! npm install --global --prefix "$prefix" --omit=dev "$archive"; then
  prefix_help
  fail 'npm local tgz installation failed; see the npm error above.'
fi
installed_version=$("$prefix/bin/cdp-browser-mcp" --version) || fail 'Installed command failed --version.'
[ "$installed_version" = "$package_version" ] || fail "Installed version $installed_version does not match $package_version."
printf 'Installed cdp-browser-mcp %s in %s/bin.\n' "$installed_version" "$prefix"
printf 'Add %s/bin to your shell and MCP client PATH, then use this configuration (choose a unique agent ID):\n' "$prefix"
cat <<'JSON'
{
  "mcpServers": {
    "browser": {
      "command": "cdp-browser-mcp",
      "args": ["mcp", "--agent", "agent-a"]
    }
  }
}
JSON

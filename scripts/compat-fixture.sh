#!/usr/bin/env bash
# Parameterized AGENT-255 compatibility fixture setup. This helper only owns
# scratch profile creation and command orchestration; callers own every DSH,
# plugin, and (for legacy) runtime-probe input.
set -euo pipefail

say() { printf '[compat-fixture] %s\n' "$*"; }
die() { printf '[compat-fixture] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  compat-fixture.sh MODE --dsh-command PATH [--dsh-arg ARG ...]
    --dsh-version VERSION --plugin-input ABSOLUTE_PATH
    --plugin-input-kind source|tarball
    [--legacy-source-ref COMMIT_ISH]
    [--legacy-expected-sha256 64_HEX]
    [--scratch-base DIRECTORY]
    [--runtime-command PATH [--runtime-arg ARG ...]]

Modes:
  supported-strict         Fresh strict profile; installation must succeed.
  outside-range-negative   Fresh strict profile; only peer mismatch may fail as expected.
  legacy-runtime-only      Fresh non-strict profile for explicit Better Sidebar 0.16.1;
                           requires an explicit runtime command and is unsupported.

This helper does not discover or download a plugin artifact and does not infer a
DSH command/version. Pass a real tarball/source and launcher explicitly.
EOF
}

[ "$#" -gt 0 ] || { usage >&2; exit 1; }
MODE="$1"
shift
case "$MODE" in
  supported-strict|outside-range-negative|legacy-runtime-only) ;;
  *) usage >&2; die "unknown mode: $MODE" ;;
esac

DSH_COMMAND=()
RUNTIME_COMMAND=()
DSH_VERSION=""
PLUGIN_INPUT=""
PLUGIN_INPUT_KIND=""
LEGACY_SOURCE_REF=""
LEGACY_EXPECTED_SHA256=""
SCRATCH_BASE="/tmp"
LEGACY_PACKAGE_NAME="dsh-better-sidebar"
LEGACY_PACKAGE_VERSION="0.16.1"
LEGACY_CANONICAL_COMMIT="f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1"

verify_legacy_package_identity() {
  local metadata="$1"
  local label="$2"
  local name="${metadata%%$'\n'*}"
  local version="${metadata#*$'\n'}"

  [ "$name" = "$LEGACY_PACKAGE_NAME" ] \
    || die "$label name mismatch: expected $LEGACY_PACKAGE_NAME, got ${name:-unknown}"
  [ "$version" = "$LEGACY_PACKAGE_VERSION" ] \
    || die "$label version mismatch: expected $LEGACY_PACKAGE_VERSION, got ${version:-unknown}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dsh-command)
      [ "$#" -ge 2 ] || die "--dsh-command requires a value"
      [ "${#DSH_COMMAND[@]}" -eq 0 ] || die "--dsh-command may be specified only once"
      DSH_COMMAND=("$2")
      shift 2
      ;;
    --dsh-arg)
      [ "$#" -ge 2 ] || die "--dsh-arg requires a value"
      [ "${#DSH_COMMAND[@]}" -gt 0 ] || die "--dsh-command must precede --dsh-arg"
      DSH_COMMAND+=("$2")
      shift 2
      ;;
    --dsh-version)
      [ "$#" -ge 2 ] || die "--dsh-version requires a value"
      DSH_VERSION="$2"
      shift 2
      ;;
    --plugin-input)
      [ "$#" -ge 2 ] || die "--plugin-input requires a value"
      PLUGIN_INPUT="$2"
      shift 2
      ;;
    --plugin-input-kind)
      [ "$#" -ge 2 ] || die "--plugin-input-kind requires a value"
      PLUGIN_INPUT_KIND="$2"
      shift 2
      ;;
    --legacy-source-ref)
      [ "$#" -ge 2 ] || die "--legacy-source-ref requires a value"
      LEGACY_SOURCE_REF="$2"
      shift 2
      ;;
    --legacy-expected-sha256)
      [ "$#" -ge 2 ] || die "--legacy-expected-sha256 requires a value"
      LEGACY_EXPECTED_SHA256="$2"
      shift 2
      ;;
    --scratch-base)
      [ "$#" -ge 2 ] || die "--scratch-base requires a value"
      SCRATCH_BASE="$2"
      shift 2
      ;;
    --runtime-command)
      [ "$#" -ge 2 ] || die "--runtime-command requires a value"
      [ "${#RUNTIME_COMMAND[@]}" -eq 0 ] || die "--runtime-command may be specified only once"
      RUNTIME_COMMAND=("$2")
      shift 2
      ;;
    --runtime-arg)
      [ "$#" -ge 2 ] || die "--runtime-arg requires a value"
      [ "${#RUNTIME_COMMAND[@]}" -gt 0 ] || die "--runtime-command must precede --runtime-arg"
      RUNTIME_COMMAND+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "${#DSH_COMMAND[@]}" -gt 0 ] || die "--dsh-command is required; no DSH launcher is inferred"
[ -n "$DSH_VERSION" ] || die "--dsh-version is required; no external package version is inferred"
[ -n "$PLUGIN_INPUT" ] || die "--plugin-input is required; pass an existing tarball or source directory"
[ -n "$PLUGIN_INPUT_KIND" ] || die "--plugin-input-kind is required; choose source or tarball"
case "$PLUGIN_INPUT" in
  /*) ;;
  *) die "--plugin-input must be an absolute path: $PLUGIN_INPUT" ;;
esac
[ -e "$PLUGIN_INPUT" ] || die "explicit plugin input does not exist: $PLUGIN_INPUT"
case "$PLUGIN_INPUT_KIND" in
  source) [ -d "$PLUGIN_INPUT" ] || die "--plugin-input-kind source requires a directory: $PLUGIN_INPUT" ;;
  tarball) [ -f "$PLUGIN_INPUT" ] || die "--plugin-input-kind tarball requires a file: $PLUGIN_INPUT" ;;
  *) die "unknown --plugin-input-kind: $PLUGIN_INPUT_KIND (expected source or tarball)" ;;
esac
[ -d "$SCRATCH_BASE" ] || die "--scratch-base must be an existing directory: $SCRATCH_BASE"

for argument in "${DSH_COMMAND[@]}"; do
  case "$argument" in
    --force|--force=*|--legacy-peer-deps|--legacy-peer-deps=*|--ignore-peer-dependencies|--ignore-peer-dependencies=*|--strict-peer-dependencies=false|--no-strict-peer-dependencies)
      die "peer bypass flag is forbidden: $argument"
      ;;
  esac
done

if [ "$MODE" = "legacy-runtime-only" ]; then
  if [ "$PLUGIN_INPUT_KIND" = "source" ]; then
    [ -n "$LEGACY_SOURCE_REF" ] || die "--legacy-source-ref is required for legacy source input"
    case "$LEGACY_SOURCE_REF" in
      -*) die "legacy source ref cannot be resolved: $LEGACY_SOURCE_REF" ;;
    esac
    INPUT_ROOT="$(cd "$PLUGIN_INPUT" && pwd -P)" \
      || die "legacy source input is not a Git worktree: $PLUGIN_INPUT"
    GIT_ROOT="$(git -C "$PLUGIN_INPUT" rev-parse --show-toplevel 2>/dev/null)" \
      || die "legacy source input is not a Git worktree: $PLUGIN_INPUT"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)" \
      || die "legacy source input is not a Git worktree: $PLUGIN_INPUT"
    [ "$INPUT_ROOT" = "$GIT_ROOT" ] \
      || die "legacy source input must be the Git worktree root: $PLUGIN_INPUT"
    RESOLVED_LEGACY_REF="$(git -C "$PLUGIN_INPUT" rev-parse --verify "${LEGACY_SOURCE_REF}^{commit}" 2>/dev/null)" \
      || die "legacy source ref cannot be resolved: $LEGACY_SOURCE_REF"
    [ "$RESOLVED_LEGACY_REF" = "$LEGACY_CANONICAL_COMMIT" ] \
      || die "legacy source ref mismatch: expected $LEGACY_CANONICAL_COMMIT, got $RESOLVED_LEGACY_REF"
    LEGACY_HEAD="$(git -C "$PLUGIN_INPUT" rev-parse --verify HEAD 2>/dev/null)" \
      || die "legacy source HEAD cannot be resolved"
    [ "$LEGACY_HEAD" = "$LEGACY_CANONICAL_COMMIT" ] \
      || die "legacy source HEAD mismatch: expected $LEGACY_CANONICAL_COMMIT, got $LEGACY_HEAD"
    [ -z "$(git -C "$PLUGIN_INPUT" status --porcelain=v1 --untracked-files=all)" ] \
      || die "legacy source is dirty: tracked, index, and untracked state must all be clean"
  else
    [ -n "$LEGACY_EXPECTED_SHA256" ] \
      || die "--legacy-expected-sha256 is required for legacy tarball input"
    [[ "$LEGACY_EXPECTED_SHA256" =~ ^[[:xdigit:]]{64}$ ]] \
      || die "--legacy-expected-sha256 must be exactly 64 hexadecimal characters"
    LEGACY_ACTUAL_SHA256="$(node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$PLUGIN_INPUT")" \
      || die "could not calculate SHA-256 for legacy tarball: $PLUGIN_INPUT"
    [ "$LEGACY_ACTUAL_SHA256" = "$LEGACY_EXPECTED_SHA256" ] \
      || die "legacy tarball SHA-256 mismatch: expected $LEGACY_EXPECTED_SHA256, got $LEGACY_ACTUAL_SHA256"
    LEGACY_METADATA="$(tar -xOf "$PLUGIN_INPUT" package/package.json 2>/dev/null | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { const p=JSON.parse(s); process.stdout.write(`${String(p.name ?? "")}\n${String(p.version ?? "")}`) } catch { process.exit(2) } })')" \
      || die "legacy tarball must contain a readable package/package.json: $PLUGIN_INPUT"
    verify_legacy_package_identity "$LEGACY_METADATA" "legacy tarball package"
  fi
fi

SCRATCH="$(mktemp -d "$SCRATCH_BASE/dsh-compat-${MODE}.XXXXXX")"
cleanup() {
  local code=$?
  rm -rf "$SCRATCH"
  exit "$code"
}
trap cleanup EXIT

INSTALL_INPUT="$PLUGIN_INPUT"
if [ "$MODE" = "legacy-runtime-only" ] && [ "$PLUGIN_INPUT_KIND" = "source" ]; then
  INSTALL_INPUT="$SCRATCH/legacy-source"
  mkdir -p "$INSTALL_INPUT"
  git -C "$PLUGIN_INPUT" archive "$LEGACY_CANONICAL_COMMIT" | tar -x -C "$INSTALL_INPUT" \
    || die "could not archive canonical legacy source commit: $LEGACY_CANONICAL_COMMIT"
  LEGACY_METADATA="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); const p=JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8")); process.stdout.write(`${String(p.name ?? "")}\n${String(p.version ?? "")}`)' "$INSTALL_INPUT")" \
    || die "archived legacy source must contain a readable package.json"
  verify_legacy_package_identity "$LEGACY_METADATA" "archived legacy package"
fi

if [ "$MODE" = "legacy-runtime-only" ]; then
  [ "${#RUNTIME_COMMAND[@]}" -gt 0 ] || die "--runtime-command is required for legacy runtime evidence; this repository does not infer how to launch or probe DSH"
  [ "$DSH_VERSION" = "0.1.1-rc.3" ] || die "legacy runtime lane requires the explicitly supplied DSH version to be 0.1.1-rc.3"
fi

export DSH_HOME="$SCRATCH/home"
export COMPAT_WORKSPACE="$SCRATCH/workspace"
export COMPAT_PROFILE="$DSH_HOME/profiles/web"
export COMPAT_PLUGIN_INPUT="$INSTALL_INPUT"
mkdir -p "$COMPAT_PROFILE" "$COMPAT_WORKSPACE"

cat > "$COMPAT_PROFILE/package.json" <<'EOF'
{
  "name": "dsh-compat-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$COMPAT_PROFILE/cordis.patch.yml"

if [ "$MODE" = "legacy-runtime-only" ]; then
  STRICT_PEERS=false
else
  STRICT_PEERS=true
fi
cat > "$COMPAT_PROFILE/pnpm-workspace.yaml" <<EOF
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
strictPeerDependencies: $STRICT_PEERS

allowBuilds:
  node-pty: true
  protobufjs: true
EOF

# Do not inherit npm peer-bypass switches from the invoking shell.
unset npm_config_force NPM_CONFIG_FORCE npm_config_legacy_peer_deps NPM_CONFIG_LEGACY_PEER_DEPS
unset npm_config_ignore_peer_dependencies NPM_CONFIG_IGNORE_PEER_DEPENDENCIES

set +e
VERSION_OUTPUT="$("${DSH_COMMAND[@]}" --version 2>&1)"
VERSION_STATUS=$?
set -e
if [ "$VERSION_STATUS" -ne 0 ]; then
  printf '%s\n' "$VERSION_OUTPUT" >&2
  die "explicit DSH command could not be resolved or started: ${DSH_COMMAND[*]}"
fi
case "$VERSION_OUTPUT" in
  *"$DSH_VERSION"*) ;;
  *) die "explicit DSH command version mismatch: expected $DSH_VERSION, got ${VERSION_OUTPUT:-empty output}" ;;
esac

INSTALL_LOG="$SCRATCH/install.log"
set +e
"${DSH_COMMAND[@]}" plugin --profile web add "file:$INSTALL_INPUT" >"$INSTALL_LOG" 2>&1
INSTALL_STATUS=$?
set -e

case "$MODE" in
  supported-strict)
    if [ "$INSTALL_STATUS" -ne 0 ]; then
      cat "$INSTALL_LOG" >&2
      die "could not resolve or install the explicit DSH/plugin inputs under strict peer dependencies"
    fi
    cat "$INSTALL_LOG"
    say "SUPPORTED_STRICT: explicit inputs installed in a fresh strict scratch profile"
    ;;
  outside-range-negative)
    if [ "$INSTALL_STATUS" -eq 0 ]; then
      cat "$INSTALL_LOG"
      die "outside-range negative unexpectedly succeeded under strict peer dependencies"
    fi
    if ! grep -Eq '(^|[^[:alnum:]_])ERR_PNPM_PEER_DEP_ISSUES([^[:alnum:]_]|$)' "$INSTALL_LOG"; then
      cat "$INSTALL_LOG" >&2
      die "outside-range failure did not report ERR_PNPM_PEER_DEP_ISSUES"
    fi
    cat "$INSTALL_LOG"
    say "EXPECTED_FAIL: ERR_PNPM_PEER_DEP_ISSUES rejected by strict peer dependencies"
    ;;
  legacy-runtime-only)
    export COMPAT_LANE="LEGACY_RUNTIME_REGRESSION_ONLY"
    export COMPAT_SUPPORT_STATUS="UNSUPPORTED"
    say "LEGACY_RUNTIME_REGRESSION_ONLY"
    say "UNSUPPORTED: excluded from the supported compatibility matrix"
    if [ "$PLUGIN_INPUT_KIND" = "source" ]; then
      export COMPAT_LEGACY_IDENTITY="git:$LEGACY_CANONICAL_COMMIT"
    else
      export COMPAT_LEGACY_IDENTITY="sha256:$LEGACY_ACTUAL_SHA256"
    fi
    export LEGACY_IDENTITY="$COMPAT_LEGACY_IDENTITY"
    say "LEGACY_IDENTITY=$LEGACY_IDENTITY"
    if [ "$INSTALL_STATUS" -ne 0 ]; then
      cat "$INSTALL_LOG" >&2
      die "could not resolve or install the explicit legacy DSH/plugin inputs"
    fi
    cat "$INSTALL_LOG"
    if ! "${RUNTIME_COMMAND[@]}"; then
      die "explicit legacy runtime probe failed"
    fi
    say "LEGACY_RUNTIME_REGRESSION_ONLY completed; result remains UNSUPPORTED"
    ;;
esac

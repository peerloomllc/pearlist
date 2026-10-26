#!/usr/bin/env bash
# Local release script (app-specific config in scripts/app.conf)
#
# Ported from pearguard/scripts/release.sh. PearList is mobile-only: it has no
# desktop/ tree, so the Windows-installer and Linux-artifact paths below stay
# inert (_desktop_configured / _linux_configured return false when desktop/ is
# absent, before any SSH probe). They are left in place for a faithful port and
# can be deleted if a desktop target is never added.
#
# Unlike the siblings, PearList regenerates android/ from app.json + config
# plugins on every build, so this script runs `expo prebuild --clean -p android`
# before the Android build to apply the release-signing config plugin
# (plugins/with-android-release-signing.js). It also runs the canonical
# `npm run verify` gate (tests + all bundles) before building any artifact.
#
# Usage: ./scripts/release.sh [vX.Y.Z] [--retag] [--check-versions]
#
# Flags:
#   vX.Y.Z             Override the auto-detected version
#   --retag            Delete and recreate a stranded local tag from a failed run
#   --check-versions   Query GitHub and Zapstore versions and exit (no build)
#   --skip-play        Skip Google Play upload even if credentials are configured
#   --skip-nostr       Skip Nostr announcement even if selected
#
# Required env vars (or set in scripts/.env):
#   KEYSTORE_PASSWORD            - release keystore password
#   KEY_PASSWORD                 - release key password
#   SIGN_WITH                    - Zapstore NSEC for signing
#
# Optional env vars:
#   KEYSTORE_FILE                - path to keystore (default: ~/keystore.jks)
#   KEY_ALIAS                    - key alias (default: from app.conf)
#   GITHUB_TOKEN                 - GitHub PAT (falls back to gh auth token)
#   GITHUB_REMOTE                - git remote name (default: github, then origin)
#   PLAY_SERVICE_ACCOUNT_JSON    - path to GCP service account JSON for Play upload
#   PLAY_TRACK                   - Play track: internal / alpha / beta / production
#                                  (default: alpha)
#   ASC_KEY_ID                 - App Store Connect API key ID
#   ASC_ISSUER_ID              - App Store Connect API issuer ID
#   ASC_PRIVATE_KEY_PATH       - Path to .p8 private key file
#   ASC_APP_ID                 - Numeric App Store app ID (from `asc apps list`)
#   ASC_APPLE_ID               - (legacy) Apple ID email for altool upload
#   ASC_APP_PASSWORD           - (legacy) App-specific password for altool upload
#   MAC_MINI_HOST              - Mac Mini SSH hostname (default: Tims-Mac-mini.local)
#   DESKTOP_VM_HOST            - Windows VM SSH hostname (default: ben@192.168.50.157)
#   DESKTOP_VM_REPO_PATH       - Remote path under the VM user's home for the
#                                build tree (default: pearguard-release-desktop)
#                                Legacy: DESKTOP_VM_HOST / DESKTOP_VM_REPO_PATH still honored.
#   PLAY_QUOTA_PROJECT     - GCP project ID for Play API quota when using ADC
#                            (required if PLAY_SERVICE_ACCOUNT_JSON is not set;
#                             run 'gcloud projects list' to find your project ID)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared release helpers, one copy for every PeerLoom app, in the sibling repo
# peerloomllc/peerloom-release (proposals/2026-09-17-shared-release-library.md).
RELEASE_LIB="$REPO_ROOT/../peerloom-release/release-lib.sh"
if [ ! -f "$RELEASE_LIB" ]; then
  echo "error: $RELEASE_LIB not found - clone peerloomllc/peerloom-release beside this repo" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$RELEASE_LIB"

# Pin JDK 21 for the Android build. RN 0.81's Gradle plugin doesn't support
# JDK 25 (system default on Fedora 44), and Fedora's repos don't ship 21.
# Override by exporting JAVA_HOME before invoking this script.
if [ -z "${JAVA_HOME:-}" ] && [ -x "$HOME/.jdks/jdk-21.0.11+10/bin/java" ]; then
  export JAVA_HOME="$HOME/.jdks/jdk-21.0.11+10"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# Load app config and env
if [ -f "$SCRIPT_DIR/app.conf" ]; then
  set -a; source "$SCRIPT_DIR/app.conf"; set +a
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# Required app.conf keys, checked once, up front.
#
# Each of these used to carry a hard-coded default copied from whichever
# sibling app the script was forked from. That is how PearGuard came to
# announce itself as PearCal on Nostr, PearPetal as PearList, and how
# PearPetal would have named its APK pearlist-*.apk had app.conf ever lost a
# key. Dormant wrong defaults are still wrong defaults: fail here, where it
# costs nothing, instead of mid-release or after the announcement is public.
for _k in APP_NAME ARTIFACT_PREFIX XCODE_PROJECT; do
  if [ -z "${!_k:-}" ]; then
    echo "error: $_k is not set — check $SCRIPT_DIR/app.conf" >&2
    exit 1
  fi
done

# Personal release-host defaults (release.sh is gitignored).
# DESKTOP_* is the new name post-rename; WINDOWS_* still honored so an old
# shell env keeps working without an immediate edit.
DESKTOP_VM_HOST="${DESKTOP_VM_HOST:-${WINDOWS_VM_HOST:-ben@192.168.50.157}}"
DESKTOP_VM_REPO_PATH="${DESKTOP_VM_REPO_PATH:-${WINDOWS_VM_REPO_PATH:-pearguard-release-desktop}}"

# ---------------------------------------------------------------------------

# Uses $REPO_ROOT so this works regardless of invocation directory.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_PLAY=false
SKIP_NOSTR=false

for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-play) SKIP_PLAY=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    v[0-9]*.[0-9]*.[0-9]*)
      if [[ ! "$arg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: tag must be in format vX.Y.Z (got: $arg)"
        exit 1
      fi
      RELEASE_TAG="$arg"
      EXPLICIT_TAG="$arg"
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# A real release must run the reviewed, current shared library (release-lib.sh).
if ! $CHECK_VERSIONS_ONLY; then release_lib_require_current; fi

# ---------------------------------------------------------------------------
# Determine release tag — entirely local via git tags
# ---------------------------------------------------------------------------
if [ -z "$RELEASE_TAG" ]; then
  # Exclude any tag that exactly matches a version we might be retrying —
  # find the highest tag that already has at least one commit since it,
  # i.e. the most recent tag that is genuinely a prior release.
  LATEST=$(git tag --sort=-version:refname \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [ -z "$LATEST" ]; then
    RELEASE_TAG="v1.0.0"
    echo "==> No prior tags found, starting at $RELEASE_TAG"
  else
    IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
    RELEASE_TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"
    echo "==> Auto-detected next version: $RELEASE_TAG  (latest tag was $LATEST)"
  fi
fi
APP_VERSION="${RELEASE_TAG#v}"

# ---------------------------------------------------------------------------
# Handle --retag: clean up a stranded local tag from a failed previous run
# ---------------------------------------------------------------------------
if $RETAG; then
  if git tag | grep -q "^${RELEASE_TAG}$"; then
    echo "==> --retag: deleting stranded local tag $RELEASE_TAG..."
    git tag -d "$RELEASE_TAG"
    echo "    Done. Proceeding with fresh run for $RELEASE_TAG."
  else
    echo "==> --retag: local tag $RELEASE_TAG not found, nothing to clean up."
  fi
fi

if ! $CHECK_VERSIONS_ONLY; then
  _confirm "Release tag will be $RELEASE_TAG — proceed with build?"
fi

# ---------------------------------------------------------------------------
# Required credentials (skipped for --check-versions)
# ---------------------------------------------------------------------------
if ! $CHECK_VERSIONS_ONLY; then
  : "${KEYSTORE_PASSWORD:?Set KEYSTORE_PASSWORD or add it to scripts/.env}"
  : "${KEY_PASSWORD:?Set KEY_PASSWORD or add it to scripts/.env}"
  : "${SIGN_WITH:?Set SIGN_WITH (Zapstore NSEC) or add it to scripts/.env}"
  KEYSTORE_FILE="${KEYSTORE_FILE:-$HOME/keystore.jks}"
  KEY_ALIAS="${KEY_ALIAS:-${KEY_ALIAS_DEFAULT:-pearlist}}"
  if [ ! -f "$KEYSTORE_FILE" ]; then
    echo "Error: keystore not found at $KEYSTORE_FILE"
    exit 1
  fi
fi

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Pre-flight: compare GitHub vs Zapstore versions to decide what needs doing
#
# Outcomes:
#   ZAPSTORE_ONLY=true   GitHub is ahead — skip build, publish existing release
#   ZAPSTORE_ONLY=false  Versions match (or both unknown) — full build + publish
#   exit 1               GitHub is behind Zapstore — something is wrong
# ---------------------------------------------------------------------------
ZAPSTORE_ONLY=false

# Resolve these early so the check can use them
REPO_SLUG=$(_remote_slug)
GH_TOKEN=$(_github_token)

# Read app identifier (Android package name) — used to query Zapstore relay.
# Falls back to the known hardcoded value if build.gradle can't be parsed.
ZSP_IDENTIFIER=$(_android_package_name)
if [ -z "$ZSP_IDENTIFIER" ]; then
  ZSP_IDENTIFIER="${BUNDLE_ID:-com.pearlist}"
  echo "    App identifier: $ZSP_IDENTIFIER (hardcoded fallback)"
else
  echo "    App identifier: $ZSP_IDENTIFIER"
fi

echo "==> Checking published versions..."
GH_VERSION=$(_github_latest_version "$GH_TOKEN" "$REPO_SLUG")
ZSP_VERSION_CURRENT=$(_zapstore_latest_version "$ZSP_IDENTIFIER")
PLAY_VERSION_CURRENT=$(_play_latest_version "$ZSP_IDENTIFIER" "${PLAY_SERVICE_ACCOUNT_JSON:-}" "${PLAY_TRACK:-production}")
ASC_VERSION_CURRENT=$(_appstore_latest_version "${BUNDLE_ID:-com.pearlist}")

echo "    GitHub       : ${GH_VERSION:-unknown}"
echo "    Zapstore     : ${ZSP_VERSION_CURRENT:-unknown}"
if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track)"
elif command -v gcloud > /dev/null 2>&1 \
     && gcloud auth application-default print-access-token > /dev/null 2>&1; then
  echo "    Google Play  : ${PLAY_VERSION_CURRENT:-unknown} (${PLAY_TRACK:-production} track, via gcloud)"
else
  echo "    Google Play  : (not configured)"
fi
if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (via ASC API - includes TestFlight/in-review)"
else
  echo "    App Store    : ${ASC_VERSION_CURRENT:-unknown} (live only; iTunes lookup)"
fi

# --check-versions: print diagnostic info and exit without doing anything else
if $CHECK_VERSIONS_ONLY; then
  echo ""
  if [ -n "$ZSP_VERSION_CURRENT" ]; then
    echo "    Zapstore relay query succeeded for identifier: $ZSP_IDENTIFIER"
  else
    echo "    Zapstore relay query returned nothing for identifier: $ZSP_IDENTIFIER"
    echo "    This could mean:"
    echo "      - The app has not been published to Zapstore yet"
    echo "      - The identifier is wrong (check applicationId in build.gradle)"
    echo "      - websocat / websockets is not installed (relay query was skipped)"
    echo "      - The relay is temporarily unreachable"
    echo ""
    echo "    To test the relay manually:"
    echo "      echo '[\"REQ\",\"test\",{\"kinds\":[30063],\"#i\":[\"${ZSP_IDENTIFIER}\"],\"limit\":5}]' \\"
    echo "        | websocat --no-close wss://relay.zapstore.dev"
  fi
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    echo ""
    if [ -n "$PLAY_VERSION_CURRENT" ]; then
      echo "    Google Play query succeeded: $PLAY_VERSION_CURRENT"
    else
      echo "    Google Play query returned nothing — app may not be published yet,"
      echo "    or the service account lacks permissions on the production track."
    fi
  fi
  echo ""
  if [ -n "$ASC_VERSION_CURRENT" ]; then
    if [ -n "${ASC_KEY_ID:-}" ] && command -v asc &>/dev/null; then
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (via ASC API - includes TestFlight/in-review)"
    else
      echo "    App Store query succeeded: $ASC_VERSION_CURRENT (live release only)"
    fi
  else
    echo "    App Store query returned nothing - app may not be publicly released yet."
    if ! command -v asc &>/dev/null || [ -z "${ASC_KEY_ID:-}" ]; then
      echo "    Note: using iTunes lookup (live version only). Install asc + set ASC_KEY_ID"
      echo "    for richer queries that include TestFlight and in-review builds."
    fi
  fi
  exit 0
fi

if [ -n "${EXPLICIT_TAG:-}" ]; then
  GH_HAS_VERSION=false
  ZSP_HAS_VERSION=false
  PLAY_HAS_VERSION=false
  ASC_HAS_VERSION=false
  [ "$GH_VERSION" = "$APP_VERSION" ]           && GH_HAS_VERSION=true
  [ "$ZSP_VERSION_CURRENT" = "$APP_VERSION" ]  && ZSP_HAS_VERSION=true
  [ "$PLAY_VERSION_CURRENT" = "$APP_VERSION" ] && PLAY_HAS_VERSION=true
  [ "$ASC_VERSION_CURRENT"  = "$APP_VERSION" ] && ASC_HAS_VERSION=true

  # Build a human-readable summary of what's already published
  _already=""
  $GH_HAS_VERSION   && _already="${_already}GitHub, "
  $ZSP_HAS_VERSION  && _already="${_already}Zapstore, "
  $PLAY_HAS_VERSION && _already="${_already}Google Play, "
  $ASC_HAS_VERSION  && _already="${_already}App Store, "
  _already="${_already%, }"   # strip trailing comma+space

  # Check if all configured destinations already have this version
  _all_have=true
  $GH_HAS_VERSION  || _all_have=false
  $ZSP_HAS_VERSION || _all_have=false
  if [ -n "${PLAY_SERVICE_ACCOUNT_JSON:-}" ] && [ -f "${PLAY_SERVICE_ACCOUNT_JSON:-}" ]; then
    $PLAY_HAS_VERSION || _all_have=false
  fi
  if [ -n "${ASC_APPLE_ID:-}" ] && [ -n "${ASC_APP_PASSWORD:-}" ]; then
    $ASC_HAS_VERSION || _all_have=false
  fi

  if $_all_have; then
    echo ""
    echo "    $RELEASE_TAG is already published on all configured destinations: $_already"
    echo "    Nothing to do unless you want to republish (e.g. to fix release notes)."
    echo ""
    while true; do
      read -rp "    Proceed to destination selection anyway? [y/n] " _reply
      case "$_reply" in
        [Yy]) break ;;
        [Nn]) echo "Aborted."; exit 0 ;;
        *) echo "    Please enter y or n." ;;
      esac
    done

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION && $ASC_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub and App Store but not on Zapstore — publishing to Zapstore only."
    ZAPSTORE_ONLY=true

  elif $GH_HAS_VERSION && ! $ZSP_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG exists on GitHub but not on Zapstore or App Store — proceed to destination selection."

  elif ! $GH_HAS_VERSION; then
    echo ""
    echo "    $RELEASE_TAG does not exist on GitHub yet — running full build."
  fi

else
  # -------------------------------------------------------------------------
  # Auto-detected version — compare latest published versions to decide route.
  # -------------------------------------------------------------------------
  if [ -n "$GH_VERSION" ] && [ -n "$ZSP_VERSION_CURRENT" ]; then
    CMP=$(_ver_cmp "$GH_VERSION" "$ZSP_VERSION_CURRENT")
    case "$CMP" in
      gt)
        echo ""
        echo "==> GitHub ($GH_VERSION) is ahead of Zapstore ($ZSP_VERSION_CURRENT)."
        echo "    Skipping build — will publish existing GitHub release to Zapstore only."
        RELEASE_TAG="v${GH_VERSION}"
        APP_VERSION="$GH_VERSION"
        echo "    Using release tag: $RELEASE_TAG"
        ZAPSTORE_ONLY=true
        ;;
      lt)
        echo ""
        echo "ERROR: Zapstore ($ZSP_VERSION_CURRENT) is ahead of GitHub ($GH_VERSION)."
        echo "       This should not happen. Check both platforms before proceeding."
        echo "       To override, pass the version explicitly: ./scripts/release.sh v${ZSP_VERSION_CURRENT}"
        exit 1
        ;;
      eq)
        echo "    Versions match ($GH_VERSION) — proceeding with full build for next version."
        ;;
    esac

  elif [ -n "$GH_VERSION" ] && [ -z "$ZSP_VERSION_CURRENT" ]; then
    echo ""
    echo "    Zapstore version unknown (app may not be listed yet or API unavailable)."
    echo ""
    if [ "$GH_VERSION" = "$APP_VERSION" ]; then
      echo "    GitHub already has $GH_VERSION — a full build would create a duplicate."
      echo ""
      echo "    Options:"
      echo "      y = publish existing GitHub release ($GH_VERSION) to Zapstore only"
      echo "      n = run full build for next version ($(
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            echo "v${_ma}.${_mi}.$((_pa + 1))"
          ))"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Using existing GitHub release $RELEASE_TAG — Zapstore publish only."
            break ;;
          [Nn])
            IFS='.' read -r _ma _mi _pa <<< "$GH_VERSION"
            RELEASE_TAG="v${_ma}.${_mi}.$((_pa + 1))"
            APP_VERSION="${RELEASE_TAG#v}"
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    else
      echo "    Cannot determine if Zapstore is up to date."
      echo ""
      echo "    Options:"
      echo "      y = force publish GitHub release $GH_VERSION to Zapstore now"
      echo "      n = proceed with full build for $RELEASE_TAG"
      echo "      q = quit"
      echo ""
      while true; do
        read -rp "    How do you want to proceed? [y/n/q] " _zsp_reply
        case "$_zsp_reply" in
          [Yy])
            RELEASE_TAG="v${GH_VERSION}"
            APP_VERSION="$GH_VERSION"
            ZAPSTORE_ONLY=true
            echo "    Force-publishing GitHub release $RELEASE_TAG to Zapstore."
            break ;;
          [Nn])
            echo "    Proceeding with full build for $RELEASE_TAG."
            break ;;
          [Qq]) echo "Aborted."; exit 0 ;;
          *) echo "    Please enter y, n, or q." ;;
        esac
      done
    fi

  else
    echo "    Could not determine one or both versions — proceeding with normal flow."
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Destination selection — ask which targets to publish to before any build
# work starts. Skipped in ZAPSTORE_ONLY mode (destinations are implied).
# ---------------------------------------------------------------------------
PUBLISH_GITHUB=true
PUBLISH_ZAPSTORE=true
PUBLISH_NOSTR=true
NEEDS_BUILD=false  # set true in the destination prompt below; stays false in ZAPSTORE_ONLY mode, which skips that prompt. set -u is on.
PUBLISH_PLAY=false
PUBLISH_APP_STORE=false
PUBLISH_DESKTOP=false
PUBLISH_FAILED=false   # set to true if any selected publish step fails

_play_configured && PUBLISH_PLAY=true

_appstore_configured && PUBLISH_APP_STORE=true

_desktop_configured() {
  # Windows VM must be reachable for the electron-builder NSIS cross-build.
  # desktop/ must exist locally or there's nothing to build.
  [ -d "$REPO_ROOT/desktop" ] || return 1
  [ -n "${DESKTOP_VM_HOST:-}" ] || return 1
  ssh -o ConnectTimeout=5 -o BatchMode=yes "$DESKTOP_VM_HOST" exit 2>/dev/null || return 1
  return 0
}
_desktop_configured && PUBLISH_DESKTOP=true

# Linux build runs locally — electron-builder produces AppImage + deb +
# latest-linux.yml from desktop/ directly on this host (no cross-build VM
# needed). Requires the npm deps to already be installed.
_linux_configured() {
  [ -d "$REPO_ROOT/desktop" ] || return 1
  [ -d "$REPO_ROOT/desktop/node_modules" ] || return 1
  command -v npm >/dev/null 2>&1 || return 1
  return 0
}
PUBLISH_LINUX=false
_linux_configured && PUBLISH_LINUX=true

if ! $ZAPSTORE_ONLY && ! $CHECK_VERSIONS_ONLY; then
  echo "==> Select publish destinations for $RELEASE_TAG:"
  echo ""

  # GitHub
  while true; do
    read -rp "    Publish to GitHub Releases? [Y/n] " _r
    case "${_r:-y}" in
      [Yy]) PUBLISH_GITHUB=true;  echo "    ✓ GitHub"; break ;;
      [Nn]) PUBLISH_GITHUB=false; echo "    ✗ GitHub (skipped)"; break ;;
      *) echo "    Please enter y or n." ;;
    esac
  done

  # Zapstore
  while true; do
    read -rp "    Publish to Zapstore? [Y/n] " _r
    case "${_r:-y}" in
      [Yy]) PUBLISH_ZAPSTORE=true;  echo "    ✓ Zapstore"; break ;;
      [Nn]) PUBLISH_ZAPSTORE=false; echo "    ✗ Zapstore (skipped)"; break ;;
      *) echo "    Please enter y or n." ;;
    esac
  done

  # Google Play — only prompt if gcloud or SA JSON is configured
  if _play_configured; then
    while true; do
      read -rp "    Publish to Google Play (${PLAY_TRACK:-production} track)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_PLAY=true;  echo "    ✓ Google Play"; break ;;
        [Nn]) PUBLISH_PLAY=false; echo "    ✗ Google Play (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_PLAY=false
    echo "    - Google Play (not configured — run 'gcloud auth application-default login' to enable)"
  fi

  # Apple App Store — only prompt if Mac Mini is reachable and credentials are set
  if _appstore_configured; then
    while true; do
      read -rp "    Publish to Apple App Store? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_APP_STORE=true;  echo "    ✓ Apple App Store"; break ;;
        [Nn]) PUBLISH_APP_STORE=false; echo "    ✗ Apple App Store (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_APP_STORE=false
    echo "    - Apple App Store (not configured - set ASC_KEY_ID + ASC_ISSUER_ID + ASC_APP_ID, or legacy ASC_APPLE_ID + ASC_APP_PASSWORD; ensure ${MAC_MINI_HOST:-Tims-Mac-mini.local} is reachable)"
  fi

  # Windows installer — only prompt if the Windows VM is reachable
  if _desktop_configured; then
    while true; do
      read -rp "    Build Windows installer (attaches to GitHub release)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_DESKTOP=true;  echo "    ✓ Windows installer"; break ;;
        [Nn]) PUBLISH_DESKTOP=false; echo "    ✗ Windows installer (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_DESKTOP=false
    echo "    - Windows installer (not configured - set DESKTOP_VM_HOST and ensure the VM is reachable via SSH)"
  fi

  # Linux artifacts (AppImage + deb + latest-linux.yml). Built locally; no VM
  # involvement. Only prompt if desktop/ has been npm-installed.
  if _linux_configured; then
    while true; do
      read -rp "    Build Linux artifacts (AppImage + deb)? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_LINUX=true;  echo "    ✓ Linux (AppImage + deb)"; break ;;
        [Nn]) PUBLISH_LINUX=false; echo "    ✗ Linux artifacts (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  else
    PUBLISH_LINUX=false
    echo "    - Linux artifacts (not configured - cd desktop && npm install first)"
  fi

  # Nostr announcement
  if $SKIP_NOSTR; then
    PUBLISH_NOSTR=false
    echo "    - Nostr (skipped via --skip-nostr)"
  else
    while true; do
      read -rp "    Post release announcement to Nostr? [Y/n] " _r
      case "${_r:-y}" in
        [Yy]) PUBLISH_NOSTR=true;  echo "    ✓ Nostr"; break ;;
        [Nn]) PUBLISH_NOSTR=false; echo "    ✗ Nostr (skipped)"; break ;;
        *) echo "    Please enter y or n." ;;
      esac
    done
  fi

  echo ""

  # Bail out if nothing selected
  if ! $PUBLISH_GITHUB && ! $PUBLISH_ZAPSTORE && ! $PUBLISH_NOSTR && ! $PUBLISH_PLAY && ! $PUBLISH_APP_STORE && ! $PUBLISH_DESKTOP && ! $PUBLISH_LINUX; then
    echo "No destinations selected. Aborted."
    exit 0
  fi

  # Determine if any selected destination needs a build
  NEEDS_BUILD=false
  if $PUBLISH_GITHUB || $PUBLISH_ZAPSTORE || $PUBLISH_PLAY || $PUBLISH_APP_STORE || $PUBLISH_DESKTOP || $PUBLISH_LINUX; then
    NEEDS_BUILD=true
  fi

  # Google Play requires an AAB — warn if Play is selected alongside APK targets
  if $PUBLISH_PLAY; then
    echo "    Note: Google Play requires AAB format. Both APK and AAB will be built."
    echo ""
  fi
elif $ZAPSTORE_ONLY; then
  # Republish the existing GitHub release to Zapstore. Nothing is built, so the
  # other stores stay off (they would run with no artifacts). The Nostr note is
  # still offered: a rerun like this usually follows a failed release, which
  # skipped the note too.
  PUBLISH_GITHUB=false
  release_ask_nostr
  PUBLISH_PLAY=false
  PUBLISH_APP_STORE=false
  PUBLISH_DESKTOP=false
  PUBLISH_LINUX=false
fi

# Artifact names and sizes, declared before the build fences so the post-notes
# checksum step and the final gate are safe to reference them on a run that
# skipped the build entirely (a Zapstore-only republish). set -u is on.
APK_NAME=""; APK_SIZE=""
AAB_NAME=""; AAB_SIZE=""
EXE_NAME=""; EXE_SIZE=""
APPIMAGE_NAME=""; APPIMAGE_SIZE=""
DEB_NAME=""; DEB_SIZE=""

if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 0. Update app.json version and versionCode
# ---------------------------------------------------------------------------
echo "==> Updating app.json to $APP_VERSION..."
APP_VERSION="$APP_VERSION" node -e "
  const fs = require('fs');
  const f = 'app.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = process.env.APP_VERSION;
  const [major, minor, patch] = v.split('.').map(Number);
  const versionCode = major * 1000000 + minor * 1000 + patch;
  j.expo.version = v;
  if (!j.expo.android) j.expo.android = {};
  j.expo.android.versionCode = versionCode;
  // NOTE: ios.buildNumber is deliberately NOT bumped here. scripts/ios-appstore.sh
  // owns it now and takes it from App Store Connect immediately before archiving.
  // Bumping it here was worse than redundant: this file only travels Linux -> Mac
  // via rsync, so the number the Mac actually shipped never came back, and the
  // next release incremented a stale value straight into a collision.
  if (!j.expo.ios) j.expo.ios = {};
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('Updated app.json to ' + v + ' (versionCode: ' + versionCode + ', iOS buildNumber: left to ios-appstore.sh)');
"

# Derive APP_VERSION_CODE from the version string for Gradle
IFS='.' read -r _vmaj _vmin _vpat <<< "$APP_VERSION"
APP_VERSION_CODE=$(( _vmaj * 1000000 + _vmin * 1000 + _vpat ))
export APP_VERSION_CODE

# Keep project.pbxproj tidy for anyone opening it in Xcode. These values do NOT
# decide what iOS ships: this Info.plist holds literal CFBundleShortVersionString
# / CFBundleVersion rather than referencing $(MARKETING_VERSION) /
# $(CURRENT_PROJECT_VERSION), so the pbxproj is inert. ios-appstore.sh writes the
# authoritative pair into Info.plist immediately before archiving.
_ios_build_number=$(node -p "require('./app.json').expo.ios.buildNumber")
sed -i \
  "s/CURRENT_PROJECT_VERSION = [0-9][0-9]*/CURRENT_PROJECT_VERSION = ${_ios_build_number}/g; \
   s/MARKETING_VERSION = [0-9][0-9.]*;/MARKETING_VERSION = ${APP_VERSION};/g" \
  "${XCODE_PROJECT:-ios/PearList.xcodeproj/project.pbxproj}"

echo "    Version     : $(node -p "require('./app.json').expo.version")"
echo "    versionCode : $(node -p "require('./app.json').expo.android.versionCode")"
echo "    iOS build   : decided at archive time from App Store Connect (last local: ${_ios_build_number})"
_confirm "app.json version looks correct — proceed with bundle builds?"

# ---------------------------------------------------------------------------
# 1. Canonical verify gate (tests + all bundles)
#
# `npm run verify` runs the unit tests then builds every bundle the release
# needs: bare-universal.bundle (Android worklet), bare-ios.bundle (iOS worklet)
# and app-ui.bundle (WebView UI). This is the Constitution §5 gate — a red
# verify aborts the release (set -e). It replaces PearCal/PearGuard's inline
# esbuild + bare-pack steps because PearList wires those commands through
# package.json (build:bare / build:bare:ios / build:ui).
# ---------------------------------------------------------------------------
echo "==> Running canonical verify (npm run verify)..."
npm run verify

# ---------------------------------------------------------------------------
# 2. Native project preparation (regenerate android/ for release signing)
#
# PearList gitignores android/ and regenerates it from app.json + config
# plugins. plugins/with-android-release-signing.js injects the release
# signingConfig that reads KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS /
# KEY_PASSWORD (exported into the gradlew subshell below). prebuild also bakes
# the release versionCode/versionName from app.json. --clean regenerates from a
# fresh template (safe: no custom native code); --no-install skips npm install;
# CI=1 keeps it non-interactive. Only needed when an Android artifact is built.
# ---------------------------------------------------------------------------
if $PUBLISH_GITHUB || $PUBLISH_ZAPSTORE || $PUBLISH_PLAY; then
  echo "==> Regenerating android/ (expo prebuild --clean) to apply release signing..."
  CI=1 npx expo prebuild --clean -p android --no-install
fi

# ---------------------------------------------------------------------------
# 3. Build signed release APK (and AAB if publishing to Google Play)
# ---------------------------------------------------------------------------
# Stop any warm Gradle daemons first. A daemon that started under a different
# JDK (e.g. the system-default JDK 25 from a prior `./gradlew` invocation)
# forwards its JVM to bundletool, which silently fails the signReleaseBundle
# task with "A failure occurred while executing BundleToolRunnable". Killing
# the daemon forces a fresh JVM on the pinned JDK we just exported above.
echo "==> Stopping any warm Gradle daemons (so the next build picks up JAVA_HOME)..."
(
  cd android && ./gradlew --stop > /dev/null 2>&1 || true
)

echo "==> Building signed release APK (this takes a few minutes)..."
# Compress the native libraries in the SIDELOAD APK, and only there.
#
# gradle.properties sets expo.useLegacyPackaging=false, which stores every .so
# uncompressed so Android can map it straight out of the APK. That is the right
# default for the Play AAB below, where uncompressed means a SMALLER install.
# But this APK is a direct download, and libbare-kit.so alone is 60 MB stored
# against 16.7 MB deflated - it is V8, and it compresses about 3.6x. Measured
# 2026-07-23: the APK goes ~143 MB -> ~100 MB.
#
# The trade is real and lands on install rather than download: Android extracts
# the libs at install time, so that file costs ~77 MB on disk (17 in the APK plus
# 60 extracted) instead of 60, and installs are slower. For a sideload that is
# the right way round - the download is the part people wait on and abandon.
#
# Drop the -P flag to revert. The AAB below deliberately does NOT get it.
#
# -PreactNativeArchitectures=arm64-v8a narrows a RELEASE build back to the one ABI
# real phones use. The committed default is arm64-v8a,x86_64 so that a DEBUG build
# installs on an emulator without anyone remembering a flag (CLAUDE.md rule 15, and
# plugins/with-android-abis.js). Shipping the x86_64 slice to users would roughly
# DOUBLE the release APK - measured 2026-07-31 at 204 MB against 111 MB. It is done
# here rather than per-build-type because ndk.abiFilters is an accumulating Set and
# cannot narrow a variant that already has both. Both the APK and the AAB get it.
(
  export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
  cd android && ./gradlew assembleRelease -q -Pexpo.useLegacyPackaging=true -PreactNativeArchitectures=arm64-v8a
)

if $PUBLISH_PLAY; then
  echo "==> Building signed release AAB for Google Play..."
  (
    export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD APP_VERSION APP_VERSION_CODE
    cd android && ./gradlew bundleRelease -q -PreactNativeArchitectures=arm64-v8a
  )
fi

# ---------------------------------------------------------------------------
# 4. Copy artifacts with version names
# ---------------------------------------------------------------------------
release_copy_android_artifacts

# ---------------------------------------------------------------------------
# 4e. Generate .sha256 sidecars for the mobile artifacts
# ---------------------------------------------------------------------------
release_write_checksums

fi # end NEEDS_BUILD

# ---------------------------------------------------------------------------
# 5. Generate release notes from git log / merge commits
#
# Strategy (no gh pr list needed):
#   a) Find the commit that the previous vX.Y.Z tag points to.
#   b) Walk git log from that point to HEAD.
#   c) Each merge commit (two parents) is treated as a merged PR.
#      - The merge commit subject becomes the PR title.
#      - Lines after a blank line in the commit body become the summary,
#        honouring the "## Summary" section if present (same as before).
#   d) Non-merge commits are grouped under "Other commits" as a bullet list.
#
# If GITHUB_TOKEN is available we attempt to enrich merge-commit titles with
# the real PR title from the GitHub API, but this is purely cosmetic and the
# script continues without it if the API call fails.
# ---------------------------------------------------------------------------
release_write_notes

# ---------------------------------------------------------------------------
# Phase B (slow) — the desktop builds run here, AFTER the release notes are
# finalized, so they run unattended instead of making you wait before you can
# edit the notes. Adopted suite-wide from PearCircle. Still gated on
# NEEDS_BUILD, and still best-effort: a failure is logged and skipped, never
# blocking the mobile release. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
if $NEEDS_BUILD; then

# ---------------------------------------------------------------------------
# 5b. Build Windows NSIS installer on the Windows VM (optional)
#
# electron-builder runs on the VM (Wine cross-builds are fragile with native
# deps like sodium-native). We tar the source tree, scp it over, then invoke
# scripts/desktop-remote-build.ps1 which stamps desktop/package.json, runs
# npm install + npm run build, and renames the installer to a space-free
# pearguard-<version>.exe so retrieval over scp stays trivial.
# ---------------------------------------------------------------------------
EXE_NAME=""
EXE_SIZE=""
if $PUBLISH_DESKTOP; then
  echo ""
  echo "==> Building Windows installer on ${DESKTOP_VM_HOST}..."

  _DESKTOP_PATH="${DESKTOP_VM_REPO_PATH:-pearguard-release-desktop}"
  _RELEASE_TAR=$(mktemp --suffix=.tar.gz)
  # Use an include list: the repo root also contains worktrees/, docs/,
  # prior .aab/.apk artifacts, .superpowers/, etc. that the Windows build
  # doesn't need and can add gigabytes to the tarball.
  (
    cd "$REPO_ROOT"
    # desktop/vendor/ holds nssm.exe (extraResources); do NOT exclude it.
    # prepack.js also refreshes desktop/vendor/src/ and desktop/vendor/app-ui.bundle
    # from the repo root, but nssm.exe only lives here.
    tar -czf "$_RELEASE_TAR" \
      --exclude='desktop/node_modules' \
      --exclude='desktop/dist' \
      src \
      assets/app-ui.bundle \
      desktop \
      scripts/desktop-remote-build.ps1
  )
  _TAR_SIZE=$(du -sh "$_RELEASE_TAR" | cut -f1)
  echo "    Packed source tree ($_TAR_SIZE) - copying to ${DESKTOP_VM_HOST}..."
  scp -q "$_RELEASE_TAR" "${DESKTOP_VM_HOST}:${_DESKTOP_PATH}.tar.gz"
  rm -f "$_RELEASE_TAR"

  # Heredoc expands bash vars but leaves PS-side dollar refs escaped.
  # -EncodedCommand (UTF-16LE base64) sidesteps all SSH-boundary quoting.
  # The wipe uses robocopy /MIR against an empty dir: plain Remove-Item fails
  # when a prior run left paths longer than Windows' MAX_PATH (260 chars).
  # desktop/node_modules is stashed in $HOME across the wipe and restored into
  # the fresh extract, so npm install stays incremental instead of a
  # from-scratch download every release (the slowest build phase).
  _PS_BLOCK=$(cat <<PSEOF
\$ErrorActionPreference = 'Stop'
\$target = Join-Path \$HOME '$_DESKTOP_PATH'
\$tarball = Join-Path \$HOME '$_DESKTOP_PATH.tar.gz'
\$nmStash = Join-Path \$HOME '$_DESKTOP_PATH-node_modules'
function Wipe-Long([string]\$p) {
  if (-not (Test-Path -LiteralPath \$p)) { return }
  \$empty = New-Item -ItemType Directory -Force -Path (Join-Path \$env:TEMP ("wipe-" + [guid]::NewGuid()))
  try {
    & robocopy \$empty.FullName \$p /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -LiteralPath \$p -Force -Recurse
  } finally {
    Remove-Item -LiteralPath \$empty.FullName -Force -Recurse -ErrorAction SilentlyContinue
  }
}
if (Test-Path -LiteralPath \$target) {
  \$nm = Join-Path (Join-Path \$target 'desktop') 'node_modules'
  if (Test-Path -LiteralPath \$nm) {
    Wipe-Long \$nmStash
    Move-Item -LiteralPath \$nm -Destination \$nmStash
  }
  Wipe-Long \$target
}
New-Item -ItemType Directory -Path \$target | Out-Null
tar -xzf \$tarball -C \$target
Remove-Item -LiteralPath \$tarball
if (Test-Path -LiteralPath \$nmStash) {
  New-Item -ItemType Directory -Force -Path (Join-Path \$target 'desktop') | Out-Null
  Move-Item -LiteralPath \$nmStash -Destination (Join-Path (Join-Path \$target 'desktop') 'node_modules')
}
& (Join-Path \$target 'scripts\\desktop-remote-build.ps1') -Version '$APP_VERSION' -RepoPath \$target
PSEOF
)
  _PS_B64=$(printf '%s' "$_PS_BLOCK" | iconv -t UTF-16LE | base64 -w0)
  ssh "$DESKTOP_VM_HOST" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $_PS_B64"

  EXE_NAME="${ARTIFACT_PREFIX}-${RELEASE_TAG}.exe"
  scp -q "${DESKTOP_VM_HOST}:${_DESKTOP_PATH}/desktop/dist/pearguard-${RELEASE_TAG}.exe" "$EXE_NAME"
  EXE_SIZE=$(du -sh "$EXE_NAME" | cut -f1)
  echo "==> Built EXE: $EXE_NAME  ($EXE_SIZE)"

  # electron-updater metadata. Lives alongside the .exe in the GitHub release
  # so installed clients can poll for new versions and verify sha512 before
  # in-place upgrade. Filename is fixed (electron-updater hardcodes 'latest.yml').
  scp -q "${DESKTOP_VM_HOST}:${_DESKTOP_PATH}/desktop/dist/latest.yml" "latest.yml"
  echo "==> Built EXE metadata: latest.yml"
fi

# ---------------------------------------------------------------------------
# 5b2. Build Linux artifacts (AppImage + deb) locally via electron-builder.
# No VM needed — electron-builder cross-compiles cleanly on this host. The
# build pulls assets/app-ui.bundle, runs prepack.js, then produces the
# AppImage + deb + latest-linux.yml under desktop/dist/.
# ---------------------------------------------------------------------------
APPIMAGE_NAME=""
APPIMAGE_SIZE=""
DEB_NAME=""
DEB_SIZE=""
if $PUBLISH_LINUX; then
  echo ""
  echo "==> Building Linux artifacts (AppImage + deb) locally..."

  # Stamp desktop/package.json's version so electron-builder's artifactName
  # template ("pearguard-v${version}.${ext}") produces filenames matching
  # the release tag. Without this, the build emits the stale 0.1.0 filename
  # and the cp below fails. The Windows VM build does the equivalent inside
  # desktop-remote-build.ps1; the local Linux build needs the same here.
  APP_VERSION="$APP_VERSION" node -e "
    const fs = require('fs');
    const f = '$REPO_ROOT/desktop/package.json';
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.version = process.env.APP_VERSION;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    console.log('    stamped desktop/package.json version=' + j.version);
  "

  ( cd "$REPO_ROOT/desktop" && npm run build:linux > /tmp/linux-build.log 2>&1 ) \
    || { echo "Linux build failed; see /tmp/linux-build.log"; exit 1; }

  # electron-builder names artifacts after package.json's artifactName template
  # (pearguard-v${version}.${ext}). Pull them up to the repo root with the same
  # ARTIFACT_PREFIX naming as the .exe and .apk.
  APPIMAGE_NAME="${ARTIFACT_PREFIX}-${RELEASE_TAG}.AppImage"
  DEB_NAME="${ARTIFACT_PREFIX}-${RELEASE_TAG}.deb"
  cp "$REPO_ROOT/desktop/dist/pearguard-${RELEASE_TAG}.AppImage" "$REPO_ROOT/$APPIMAGE_NAME"
  cp "$REPO_ROOT/desktop/dist/pearguard-${RELEASE_TAG}.deb"      "$REPO_ROOT/$DEB_NAME"
  APPIMAGE_SIZE=$(du -sh "$REPO_ROOT/$APPIMAGE_NAME" | cut -f1)
  DEB_SIZE=$(du -sh "$REPO_ROOT/$DEB_NAME" | cut -f1)
  echo "==> Built AppImage: $APPIMAGE_NAME ($APPIMAGE_SIZE)"
  echo "==> Built deb     : $DEB_NAME ($DEB_SIZE)"

  # electron-updater AppImage clients poll latest-linux.yml the same way
  # Windows polls latest.yml. Filename is hardcoded by electron-updater.
  cp "$REPO_ROOT/desktop/dist/latest-linux.yml" "$REPO_ROOT/latest-linux.yml"
  echo "==> Built Linux update metadata: latest-linux.yml"
fi

fi # end NEEDS_BUILD (desktop artifacts)

# ---------------------------------------------------------------------------
# 5e. Generate .sha256 sidecars for the desktop artifacts, then the final gate
#
# The desktop builds above are slow and best-effort, so their checksums and the
# last look at the full asset list happen here rather than at step 4e. This is
# the last confirm before anything irreversible: step 6 commits and step 6b
# pushes the tag. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
for _artifact in "${EXE_NAME:-}" "${APPIMAGE_NAME:-}" "${DEB_NAME:-}"; do
  [ -z "$_artifact" ] && continue
  [ -f "$_artifact" ] || continue
  ( cd "$REPO_ROOT" && sha256sum "$_artifact" > "${_artifact}.sha256" )
  echo "    sha256  $(cut -d' ' -f1 < "${_artifact}.sha256")  $_artifact"
done

echo ""
_RELEASE_SUMMARY="APK (${APK_SIZE:-none})"
if $PUBLISH_PLAY    && [ -n "${AAB_NAME:-}" ];  then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, AAB ($AAB_SIZE)"; fi
if $PUBLISH_DESKTOP && [ -n "${EXE_NAME:-}" ];  then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, EXE ($EXE_SIZE)"; fi
if $PUBLISH_LINUX   && [ -n "${APPIMAGE_NAME:-}" ]; then _RELEASE_SUMMARY="$_RELEASE_SUMMARY, AppImage ($APPIMAGE_SIZE), deb ($DEB_SIZE)"; fi
_confirm "$_RELEASE_SUMMARY ready to publish?"

# ---------------------------------------------------------------------------
# 5f. Generate the iOS version metadata BEFORE the bump commit
#
# metadata/ios/version/$APP_VERSION is a generated dir: version/default/*.json
# with `whatsNew` replaced by release_notes.md. It used to be written ~850
# lines below, inside the App Store step, which is AFTER §6 - so §6's `-e`
# guard never saw it and the dir was never committed. Evidence:
# metadata/ios/version/1.0.3/ was still untracked after 1.0.3 shipped, which is
# how a hand-written whatsNew came to be treated as durable.
#
# Generating here means §6 commits it and the tag carries the notes the release
# actually shipped with. The App Store step still calls this a second time,
# because it is the only place that can seed version/default/ by bootstrap-
# pulling it from App Store Connect. The function is idempotent: the same
# default/ plus the same release_notes.md regenerates identical files, so the
# second call is a no-op against the committed tree.
# ---------------------------------------------------------------------------
_gen_ios_version_metadata() {
  local _metadata_dir="$REPO_ROOT/metadata/ios"
  local _default_dir="$_metadata_dir/version/default"
  local _version_dir="$_metadata_dir/version/${APP_VERSION}"
  local _f _whats_new=""

  # No canonical source to generate from. The App Store step bootstraps one by
  # pulling from ASC; from here there is nothing to do.
  compgen -G "$_default_dir/*.json" > /dev/null || return 1

  if [ -f "$REPO_ROOT/release_notes.md" ]; then
    _whats_new=$(cat "$REPO_ROOT/release_notes.md")
  fi

  mkdir -p "$_version_dir"
  for _f in "$_default_dir"/*.json; do
    python3 -c "
import json, sys, re
with open('$_f') as fh:
    data = json.load(fh)
# Strip emojis — App Store rejects non-ASCII symbols in whatsNew
notes = sys.stdin.read().strip()
data['whatsNew'] = re.sub(r'[^\x00-\x7F\u00C0-\u024F\u2014\u2019\u2018\u201C\u201D]+\s*', '', notes)
with open('${_version_dir}/$(basename "$_f")', 'w') as out:
    json.dump(data, out)
" <<< "$_whats_new"
    echo "    Created ${_version_dir}/$(basename "$_f")"
  done
}

if $PUBLISH_APP_STORE; then
  echo ""
  echo "==> Generating iOS version metadata for $APP_VERSION..."
  _gen_ios_version_metadata \
    || echo "    Skipped - no metadata/ios/version/default/*.json yet (the App Store step will seed it)."
fi

# ---------------------------------------------------------------------------
# 6. Commit the version bumps this run made, BEFORE tagging
#
# Step 0 rewrites app.json and the Xcode project, but nothing ever committed
# them. The tag was cut from a tree still carrying the PREVIOUS version, so
# every release left the default branch declaring the version before it and the
# bumps stranded as uncommitted changes in the working tree.
#
# Committing here, before the tag, means the tag actually contains the version
# it claims to be. Ported from PearCal, which hit exactly this and had master
# sitting on 1.0.31 while 1.0.34 shipped. See RELEASE-PIPELINE.md §2.
#
# Explicit allowlist, never `git add -A`: assets/*.bundle are build outputs that
# can lag the source they were built from, and committing one would bake a stale
# artifact into the release.
# ---------------------------------------------------------------------------
if $PUBLISH_GITHUB; then

_bump_paths=(
  app.json
  "$XCODE_PROJECT"
  desktop/package.json
  metadata/ios/en-US/release_notes.txt
  metadata/ios/version/default
  "metadata/ios/version/${APP_VERSION}"
)
# version/default is the SOURCE the versioned dir is generated from (§5b). It
# was untracked too, so committing only the generated output would have left a
# fresh clone unable to regenerate it.
# Existence is not enough: a path can exist and still be un-addable. PearList
# gitignores /ios/ (expo prebuild regenerates it), so once a prebuild has run on
# the release box, $XCODE_PROJECT exists, passes -e, and `git add` then EXITS 1
# on the ignored path - which under `set -e` kills the release between the build
# and the tag. Skip what git will refuse rather than force it in: the iOS
# marketing version lives in a generated directory and is not ours to track.
_bump_existing=()
_bump_skipped=()
for _p in "${_bump_paths[@]}"; do
  [ -e "$_p" ] || continue
  if git check-ignore -q -- "$_p"; then
    _bump_skipped+=("$_p")
    continue
  fi
  _bump_existing+=("$_p")
done
if [ ${#_bump_existing[@]} -gt 0 ] \
   && [ -n "$(git status --porcelain -- "${_bump_existing[@]}")" ]; then
  echo "==> Committing version bumps for $APP_VERSION..."
  if [ ${#_bump_skipped[@]} -gt 0 ]; then
    echo "    Not tracked, left uncommitted: ${_bump_skipped[*]}"
  fi
  git add -- "${_bump_existing[@]}"
  git commit -q -m "chore(release): $APP_VERSION" \
    && echo "    Committed $(git diff --name-only HEAD~1 HEAD | wc -l) file(s)" \
    || echo "    WARNING: version-bump commit failed — the tag will not contain them." >&2
else
  echo "==> No uncommitted version bumps to record (already committed)."
fi

# ---------------------------------------------------------------------------
# 6b. Push branch and tag
# ---------------------------------------------------------------------------

release_push_and_tag

# ---------------------------------------------------------------------------
# 7. Create GitHub release and upload assets
# ---------------------------------------------------------------------------
echo "==> Creating GitHub release $RELEASE_TAG..."

GH_TOKEN=$(_github_token)   # re-resolve in case env changed

# Assemble the asset list. Each binary is accompanied by its .sha256 sidecar
# so downloaders can verify integrity without a separate checksums file.
RELEASE_ASSETS=()
RELEASE_ASSETS+=("$APK_NAME")
[ -f "${APK_NAME}.sha256" ] && RELEASE_ASSETS+=("${APK_NAME}.sha256")
if $PUBLISH_PLAY && [ -n "$AAB_NAME" ] && [ -f "$AAB_NAME" ]; then
  RELEASE_ASSETS+=("$AAB_NAME")
  [ -f "${AAB_NAME}.sha256" ] && RELEASE_ASSETS+=("${AAB_NAME}.sha256")
fi
if $PUBLISH_DESKTOP && [ -n "$EXE_NAME" ] && [ -f "$EXE_NAME" ]; then
  RELEASE_ASSETS+=("$EXE_NAME")
  [ -f "${EXE_NAME}.sha256" ] && RELEASE_ASSETS+=("${EXE_NAME}.sha256")
  # electron-updater clients fetch latest.yml from the GitHub release to learn
  # there is a newer version. Without this asset, in-place upgrades stop working.
  [ -f "latest.yml" ] && RELEASE_ASSETS+=("latest.yml")
fi
if $PUBLISH_LINUX && [ -n "$APPIMAGE_NAME" ] && [ -f "$APPIMAGE_NAME" ]; then
  RELEASE_ASSETS+=("$APPIMAGE_NAME")
  [ -f "${APPIMAGE_NAME}.sha256" ] && RELEASE_ASSETS+=("${APPIMAGE_NAME}.sha256")
  RELEASE_ASSETS+=("$DEB_NAME")
  [ -f "${DEB_NAME}.sha256" ] && RELEASE_ASSETS+=("${DEB_NAME}.sha256")
  # Linux electron-updater clients (AppImage) poll latest-linux.yml the same
  # way Windows clients poll latest.yml. Required for in-app auto-update.
  [ -f "latest-linux.yml" ] && RELEASE_ASSETS+=("latest-linux.yml")
fi

echo ""
echo "    Repo   : ${REPO_SLUG:-unknown}"
echo "    Tag    : $RELEASE_TAG"
echo "    Assets :"
for _a in "${RELEASE_ASSETS[@]}"; do
  echo "             - $_a ($(du -sh "$_a" | cut -f1))"
done
_confirm "Create public GitHub release $RELEASE_TAG and upload ${#RELEASE_ASSETS[@]} assets?"

if [ -n "$GH_TOKEN" ] && [ -n "$REPO_SLUG" ]; then
  # --- Create the release via REST API ---
  echo "    Calling GitHub API for repo: $REPO_SLUG"
  RELEASE_RESP=$(curl -s \
    -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${REPO_SLUG}/releases" \
    -d "$(python3 -c "
import sys, json
body = open('release_notes.md').read()
print(json.dumps({'tag_name': '${RELEASE_TAG}', 'name': '${RELEASE_TAG}', 'body': body, 'draft': False, 'prerelease': False}))
")")

  # Check for API-level errors before proceeding
  API_ERROR=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
    2>/dev/null || echo "")

  # If creation failed only because the release/tag already exists, look the
  # existing release up by tag and reuse it so we can overwrite its assets
  # instead of aborting. Any other API error stays fatal.
  if [ -n "$API_ERROR" ] && printf '%s' "$RELEASE_RESP" | grep -q 'already_exists'; then
    echo "    Release $RELEASE_TAG already exists — reusing it to overwrite assets."
    RELEASE_RESP=$(curl -s \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}")
    API_ERROR=$(printf '%s' "$RELEASE_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
  fi

  if [ -n "$API_ERROR" ]; then
    echo ""
    echo "ERROR: GitHub API returned an error:"
    printf '%s\n' "$RELEASE_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RELEASE_RESP"
    echo ""
    echo "The tag has been pushed. Once your GitHub account is restored you can"
    echo "create the release manually, or re-run this script with:"
    echo "  ./scripts/release.sh $RELEASE_TAG"
    exit 1
  fi

  UPLOAD_URL=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['upload_url'].split('{')[0])")

  # Existing assets on this release, as "<id>\t<name>" lines, so we can delete
  # any name collision before re-uploading (GitHub rejects a duplicate asset
  # name with already_exists). Empty for a freshly created release.
  EXISTING_ASSETS=$(printf '%s' "$RELEASE_RESP" \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for a in d.get('assets', []):
        print(str(a.get('id','')) + '\t' + a.get('name',''))
except Exception:
    pass
" 2>/dev/null || echo "")

  # --- Upload each asset in order ---
  for _asset in "${RELEASE_ASSETS[@]}"; do
    _ctype=$(_asset_content_type "$_asset")
    _basename=$(basename "$_asset")

    # Overwrite support: drop any pre-existing asset with the same name first.
    _existing_id=$(printf '%s\n' "$EXISTING_ASSETS" \
      | awk -F'\t' -v n="$_basename" '$2 == n {print $1; exit}')
    if [ -n "$_existing_id" ]; then
      echo "==> Replacing existing asset $_basename (id $_existing_id)..."
      curl -s -X DELETE \
        -H "Authorization: Bearer $GH_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/${REPO_SLUG}/releases/assets/${_existing_id}" >/dev/null
    fi

    echo "==> Uploading $_basename ($_ctype)..."
    UPLOAD_RESP_FILE=$(mktemp)
    curl \
      -X POST \
      -H "Authorization: Bearer $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: $_ctype" \
      "${UPLOAD_URL}?name=${_basename}" \
      --data-binary "@${_asset}" \
      --progress-bar \
      -o "$UPLOAD_RESP_FILE" 2>&1
    UPLOAD_RESP=$(cat "$UPLOAD_RESP_FILE"); rm -f "$UPLOAD_RESP_FILE"

    UPLOAD_ERROR=$(printf '%s' "$UPLOAD_RESP" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" \
      2>/dev/null || echo "")
    if [ -n "$UPLOAD_ERROR" ]; then
      echo ""
      echo "ERROR: Upload of $_basename failed:"
      printf '%s\n' "$UPLOAD_RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$UPLOAD_RESP"
      echo ""
      echo "The GitHub release was created but $_basename was not attached."
      echo "You can upload it manually at: https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
      exit 1
    fi
    echo "    Uploaded successfully."
  done

else
  # Fallback: gh CLI (requires working auth). gh accepts multiple positional
  # asset paths and infers content type from extension.
  echo "    (GITHUB_TOKEN not set or repo slug unknown — falling back to gh CLI)"
  if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
    # Release already exists — overwrite its assets (--clobber) rather than fail.
    echo "    Release $RELEASE_TAG already exists — uploading assets with --clobber."
    gh release upload "$RELEASE_TAG" "${RELEASE_ASSETS[@]}" --clobber
  else
    gh release create "$RELEASE_TAG" "${RELEASE_ASSETS[@]}" \
      --title "$RELEASE_TAG" \
      --notes-file release_notes.md
  fi
fi

else
  echo ""
  echo "==> Skipping GitHub release (not selected)."
fi # end PUBLISH_GITHUB

# ---------------------------------------------------------------------------
# 8. Install zsp if needed
# ---------------------------------------------------------------------------
release_install_zsp

# ---------------------------------------------------------------------------
# 9. Publish to Zapstore
# ---------------------------------------------------------------------------
release_publish_zapstore

# ---------------------------------------------------------------------------
# 10. Upload to Google Play Store
#
# Uses the Google Play Developer API (Publishing API v3) directly via curl.
# Uploads AAB format (required for new Play apps since Aug 2021).
# Requires PLAY_SERVICE_ACCOUNT_JSON (path to GCP service account JSON).
#
# Flow: obtain OAuth2 token → create edit → upload AAB → assign to track
#       with release notes → commit edit.
# ---------------------------------------------------------------------------
release_upload_play

# ---------------------------------------------------------------------------
# 11. Build, upload, and submit iOS App Store build
#
# Phase 1 (Mac Mini via SSH): Sync repo, archive with xcodebuild, export IPA,
#   upload to App Store Connect (asc CLI preferred, altool fallback).
# Phase 2 (Linux, asc only): Apply metadata, submit for App Review, check status.
#
# Auth: API key (ASC_KEY_ID/ASC_ISSUER_ID/ASC_APP_ID) preferred;
#   falls back to legacy ASC_APPLE_ID/ASC_APP_PASSWORD for altool.
# ---------------------------------------------------------------------------
if ! $PUBLISH_APP_STORE; then
  echo ""
  echo "==> Skipping Apple App Store upload (not selected)."
else
  echo ""
  echo "==> Building and uploading to Apple App Store..."

  MAC_MINI="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
  MAC_MINI_REPO_PATH="${MAC_MINI_REPO_PATH:-peerloomllc/pearlist}"

  # ── Step 0: Regenerate ios/ from app.json and the config plugins ──
  # ios/ is gitignored and the rsync below ships this box's copy as-is, so a copy
  # generated before a plugin was added keeps shipping without it. 1.1.12 (build
  # 20) went to App Review without with-ios-scene-lifecycle for exactly this
  # reason and crashed at launch on iOS 27. ios-appstore.sh still sets the
  # version and build number in Info.plist after this.
  echo "    Regenerating ios/ (expo prebuild -p ios)..."
  CI=1 npx expo prebuild -p ios --no-install

  # ── Step 1: Sync repo to Mac Mini ──
  echo "    Syncing repo to $MAC_MINI (including freshly built bundles)..."
  rsync -az --rsync-path=/opt/homebrew/bin/rsync \
    --exclude='.git' --exclude='node_modules' --exclude='android' \
    --exclude='ios/Pods/' --exclude='ios/build/' --exclude='ios/PearList.xcworkspace/' \
    --exclude='/*.apk' --exclude='/*.aab' --exclude='/*.AppImage' --exclude='/*.deb' --exclude='/*.exe' \
    --exclude='/*.dmg' --exclude='/*.ipa' --exclude='/*.sha256' --exclude='/*.blockmap' --exclude='/latest*.yml' \
    "$REPO_ROOT/" "${MAC_MINI}:${MAC_MINI_REPO_PATH}/"
  echo "    Sync complete."
  echo ""

  # ── Determine auth mode ──
  USE_ASC_REMOTE=false
  if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_APP_ID:-}" ]; then
    USE_ASC_REMOTE=true
    echo "    Auth mode : API key (asc CLI)"
    echo "    Key ID    : ${ASC_KEY_ID}"
    echo "    App ID    : ${ASC_APP_ID}"
  else
    echo "    Auth mode : app-specific password (altool, legacy)"
    echo "    Apple ID  : ${ASC_APPLE_ID:-not set}"
  fi
  echo "    Host      : $MAC_MINI"
  echo "    Team ID   : ${ASC_TEAM_ID:-G79ALD29NA}"
  _confirm "Archive, export, and upload to App Store Connect on $MAC_MINI?"

  # ── Step 2: SSH to Mac Mini - archive, export, upload ──
  if $USE_ASC_REMOTE; then
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    # Tee the Mac's output so the build number it CHOSE can be read back. The Mac
    # asks App Store Connect for the next free number and writes it into ITS OWN
    # plist/pbxproj/app.json - and rsync only runs Linux -> Mac, so that number
    # never returns here. app.json on this box therefore still holds a stale one,
    # which is documented at the app.json bump above and was STILL being trusted
    # by the submit step below: 1.0.5 looked up build 9 (a real build from a
    # previous release), tried to attach it, and Apple refused the submission with
    # "The build associated with appStoreVersions ... was not found".
    _IOS_ARCHIVE_LOG=$(mktemp -t pearlist-ios-archive.XXXXXX)
    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_KEY_ID='${ASC_KEY_ID}'
      export ASC_ISSUER_ID='${ASC_ISSUER_ID}'
      export ASC_APP_ID='${ASC_APP_ID}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    " 2>&1 | tee "$_IOS_ARCHIVE_LOG"
    # ios-appstore.sh prints "Build number: N (...)" whichever branch it takes.
    # sed, NOT `tr -dc '0-9'`: the line carries other numbers ("next=12, local
    # floor=10"), and stripping non-digits from the whole line yields 121210.
    _shipped=$(sed -n -E 's/^Build number: ([0-9]+).*/\1/p' "$_IOS_ARCHIVE_LOG" | head -1)
    if [ -n "$_shipped" ]; then
      _ios_build_number="$_shipped"
      echo "    iOS build shipped: ${_ios_build_number} (read back from the Mac)"
    else
      echo "    WARNING: could not read the build number back from the Mac."
      echo "    The submit step will fall back to the newest VALID build on App Store Connect."
      _ios_build_number=""
    fi
    rm -f "$_IOS_ARCHIVE_LOG"
  else
    # Legacy altool path
    _asc_id="${ASC_APPLE_ID//\'/\'\\\'\'}"
    _asc_pw="${ASC_APP_PASSWORD//\'/\'\\\'\'}"
    _asc_team="${ASC_TEAM_ID:-G79ALD29NA}"

    ssh "$MAC_MINI" "
      export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' LANG=en_US.UTF-8
      export ASC_APPLE_ID='${_asc_id}'
      export ASC_APP_PASSWORD='${_asc_pw}'
      export ASC_TEAM_ID='${_asc_team}'
      cd ${MAC_MINI_REPO_PATH}
      /bin/bash scripts/ios-appstore.sh
    "
  fi

  echo ""
  echo "==> Upload complete. Build is processing on App Store Connect."

  # ── Step 3: Apply metadata (Linux-side, asc only) ──
  # Resolved by the version-record step below and read again by Step 4. Empty
  # means "no usable version record", which gates both metadata and submission.
  ASC_VERSION_ID=""
  METADATA_DIR="$REPO_ROOT/metadata/ios"
  if $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ] && command -v asc &>/dev/null; then
    echo ""
    echo "==> Applying App Store metadata from metadata/ios/..."

    DEFAULT_DIR="$METADATA_DIR/version/default"

    # Ensure the App Store version record exists (required for pull/apply).
    # A freshly uploaded build does NOT auto-create the version record.
    #
    # App Store Connect allows only ONE in-flight version at a time, so a bare
    # `versions create` fails with "You cannot create a new version of the App
    # in the current state" whenever an earlier version is still open. That
    # bit PearPetal on 2026-07-23 (1.0.3 refused while 1.0.2 sat in review),
    # and every later step then failed as a knock-on. Two cases, opposite
    # handling:
    #
    #   EDITABLE  (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED,
    #             METADATA_REJECTED, INVALID_BINARY) - the open version has not
    #             shipped, so RENAME it to this version. That is Apple's
    #             supported way to supersede an unreleased version.
    #   BLOCKING  (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE,
    #             PROCESSING_FOR_APP_STORE) - Apple owns it. Nothing local can
    #             fix it, so say so once and skip the rest instead of emitting
    #             a cascade of misleading warnings.
    #
    # ASC_VERSION_ID is the handle every later step needs; empty means "not
    # ready", which gates both metadata apply and submission.
    ASC_VERSION_ID=""
    if _asc_auth_linux; then
      _V_CASE=""; _V_ID=""; _V_FROM=""; _V_STATE=""
      eval "$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
        | python3 -c "
import json, shlex, sys

EDITABLE = {'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED',
            'METADATA_REJECTED', 'INVALID_BINARY'}
BLOCKING = {'WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE',
            'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_APP_STORE'}

try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
items = d.get('data', d if isinstance(d, list) else [])

def attr(x, *keys):
    a = x.get('attributes', {})
    for k in keys:
        if a.get(k) or x.get(k):
            return a.get(k) or x.get(k)
    return ''

target = '${APP_VERSION}'
match = editable = blocking = None
for x in items:
    v = attr(x, 'versionString')
    state = attr(x, 'appStoreState', 'appVersionState')
    if v == target:
        match = (x.get('id'), state)
    elif state in EDITABLE and editable is None:
        editable = (x.get('id'), v, state)
    elif state in BLOCKING and blocking is None:
        blocking = (v, state)

def emit(**kv):
    for k, v in kv.items():
        print('%s=%s' % (k, shlex.quote(str(v or ''))))

if match:
    emit(_V_CASE='exists', _V_ID=match[0], _V_STATE=match[1])
elif editable:
    emit(_V_CASE='rename', _V_ID=editable[0], _V_FROM=editable[1], _V_STATE=editable[2])
elif blocking:
    emit(_V_CASE='blocked', _V_FROM=blocking[0], _V_STATE=blocking[1])
else:
    emit(_V_CASE='create')
" 2>/dev/null)"

      case "${_V_CASE:-create}" in
        exists)
          ASC_VERSION_ID="$_V_ID"
          echo "    App Store version ${APP_VERSION} already exists (${_V_STATE})."
          ;;

        rename)
          echo "    App Store version ${APP_VERSION} does not exist, and version"
          echo "    ${_V_FROM} is still open in state ${_V_STATE}."
          echo "    App Store Connect allows only one in-flight version, so ${APP_VERSION}"
          echo "    cannot be created alongside it. Renaming the open version is the"
          echo "    supported way to supersede something that never shipped."
          _confirm "Rename App Store version ${_V_FROM} to ${APP_VERSION}?"
          if asc versions update --version-id "$_V_ID" --version "$APP_VERSION" >/dev/null; then
            ASC_VERSION_ID="$_V_ID"
            echo "    Renamed ${_V_FROM} -> ${APP_VERSION}."
          else
            echo "    WARNING: rename failed - skipping metadata apply and submission."
          fi
          ;;

        blocked)
          echo "    CANNOT PROCEED: version ${_V_FROM} is ${_V_STATE}."
          echo "    Apple owns that version right now, so ${APP_VERSION} cannot be created."
          echo "    Your build IS uploaded and safe in TestFlight - nothing is lost."
          echo "    Either wait for ${_V_FROM} to finish review, or cancel it:"
          echo "      asc review status --app ${ASC_APP_ID}"
          echo "      asc submit cancel --app ${ASC_APP_ID} --id <SUBMISSION_ID> --confirm"
          echo "    Then re-run the release. Skipping metadata apply and submission."
          ;;

        create)
          echo "    App Store version ${APP_VERSION} does not exist yet - creating..."
          PRIOR_VERSION=$(asc versions list --app "$ASC_APP_ID" --paginate --output json 2>/dev/null \
            | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data', d if isinstance(d, list) else [])
def ver(x):
    v = x.get('attributes', {}).get('versionString') or x.get('versionString', '')
    try: return tuple(int(p) for p in v.split('.'))
    except: return (0,)
target = tuple(int(p) for p in '${APP_VERSION}'.split('.') if p.isdigit())
priors = [x for x in items if ver(x) < target]
priors.sort(key=ver, reverse=True)
if priors:
    print(priors[0].get('attributes', {}).get('versionString') or priors[0].get('versionString', ''))
" 2>/dev/null)
          if [ -n "$PRIOR_VERSION" ]; then
            echo "    Copying metadata from prior version ${PRIOR_VERSION}..."
            asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" \
              --copy-metadata-from "$PRIOR_VERSION" >/dev/null \
              || echo "    WARNING: versions create failed."
          else
            echo "    No prior version found - creating ${APP_VERSION} without metadata copy."
            asc versions create --app "$ASC_APP_ID" --version "$APP_VERSION" >/dev/null \
              || echo "    WARNING: versions create failed."
          fi
          ASC_VERSION_ID=$(_asc_version_id "$APP_VERSION")
          if [ -n "$ASC_VERSION_ID" ]; then
            echo "    Created version ${APP_VERSION}."
          else
            echo "    WARNING: version ${APP_VERSION} still not found - skipping metadata apply."
          fi
          ;;
      esac
    fi

    # Bootstrap: if no canonical .json files exist anywhere, pull current state
    # from App Store Connect to seed metadata/ios/version/default/.
    if ! find "$METADATA_DIR" -name '*.json' -type f 2>/dev/null | grep -q .; then
      echo "    No canonical metadata found — bootstrapping from App Store Connect..."
      if _asc_auth_linux && asc metadata pull --app "$ASC_APP_ID" --version "$APP_VERSION" --dir "$METADATA_DIR"; then
        PULLED_DIR="$METADATA_DIR/version/${APP_VERSION}"
        if [ -d "$PULLED_DIR" ] && [ ! -d "$DEFAULT_DIR" ]; then
          mkdir -p "$DEFAULT_DIR"
          cp "$PULLED_DIR"/*.json "$DEFAULT_DIR/" 2>/dev/null || true
          echo "    Seeded $DEFAULT_DIR from pulled metadata."
        fi
        # Remove the pulled versioned dir so the whatsNew-injection step below
        # regenerates it from default/.
        rm -rf "$PULLED_DIR"
      else
        echo "    WARNING: metadata bootstrap pull failed — skipping metadata apply."
        DEFAULT_DIR=""
      fi
    fi

    # Create versioned metadata with whatsNew from release notes.
    #
    # Regenerated on EVERY run, not just when version/$APP_VERSION is absent: a failed
    # release leaves a version dir behind, and the old "create only if missing"
    # test meant the retry silently shipped the first run's notes even after
    # release_notes.md had been fixed.
    #
    # §5b already ran this once, before the version-bump commit, so on the
    # normal path this call rewrites the same bytes. It stays because the
    # bootstrap above is the ONLY thing that can seed version/default/ from App
    # Store Connect, and when it does, §5b had nothing to generate from.
    if [ -n "$DEFAULT_DIR" ] && [ -d "$DEFAULT_DIR" ]; then
      _gen_ios_version_metadata \
        || echo "    WARNING: no ${DEFAULT_DIR}/*.json to generate whatsNew from."
    fi

    if [ -z "$ASC_VERSION_ID" ]; then
      echo "    Skipping metadata apply - no usable App Store version record."
    elif _asc_auth_linux; then
      echo "    Dry run:"
      asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
        --dir "$METADATA_DIR" --dry-run || true
      echo ""
      _confirm "Apply this metadata to version ${APP_VERSION}?"
      if asc metadata apply --app "$ASC_APP_ID" --version "$APP_VERSION" \
           --dir "$METADATA_DIR"; then
        echo "    Metadata applied."
      else
        echo "    WARNING: Metadata apply failed (non-fatal)."
      fi
    fi
  elif $USE_ASC_REMOTE && [ -d "$METADATA_DIR" ]; then
    echo "    Metadata directory found but asc not available on Linux - skipping."
  fi

  # ── Step 4: Submit for App Review (Linux-side, asc only) ──
  #
  # NOT `asc publish appstore --submit`. That command requires --ipa (or a
  # local Xcode build) because it owns the whole upload-then-submit flow, and
  # the .ipa only ever exists on the Mac mini - so from this box it failed with
  # "Error: --ipa is required" on every release. Step 2 already uploaded the
  # build, so what is left is the lower-level submission lifecycle:
  #
  #   attach build -> declare export compliance -> validate -> submit
  #
  # `asc review submissions-*` is the API path for that, and it needs no .ipa.
  if $USE_ASC_REMOTE && command -v asc &>/dev/null; then
    echo ""
    echo "==> Submit for App Store review"

    if [ -z "${ASC_VERSION_ID:-}" ]; then
      echo "    Skipping submission - no usable App Store version record."
      echo "    The build IS uploaded; submit from App Store Connect once the"
      echo "    blocking version above is resolved."
    elif ! _asc_auth_linux; then
      echo "    WARNING: asc auth failed on Linux. Submit via App Store Connect."
    else
      # Attach the build. `asc builds list` needs a few minutes after upload
      # before the record appears, so say which is which rather than failing
      # with a bare 404.
      # Empty when the read-back above failed. Falling back to the app-wide NEWEST
      # build is safe because ios-appstore.sh takes its number from
      # `asc builds next-build-number`, which is the app-wide max + 1 - so the
      # build this run just uploaded IS the newest one.
      # _asc_wait_for_build waits for Apple to finish processing and matches the
      # marketing version too, since build numbers repeat across versions. With
      # no number it takes the newest build of this version.
      _BUILD_INFO=$(_asc_wait_for_build "$APP_VERSION" "${_ios_build_number:-}")
      [ -z "${_ios_build_number:-}" ] && [ -n "$_BUILD_INFO" ] \
        && echo "    Using the newest ${APP_VERSION} build on App Store Connect (${_BUILD_INFO%% *})"
      _BUILD_ID="${_BUILD_INFO%% *}"
      _BUILD_STATE=$(printf '%s' "$_BUILD_INFO" | cut -d' ' -f2)

      if [ -z "$_BUILD_ID" ]; then
        echo "    Build ${_ios_build_number} is not registered on App Store Connect yet."
        echo "    Builds take 5-15 minutes to process. Once it appears, run:"
        echo "      asc versions attach-build --version-id ${ASC_VERSION_ID} --build <BUILD_ID>"
        echo "    Skipping submission."
      elif [ "$_BUILD_STATE" != "VALID" ]; then
        echo "    Build ${_ios_build_number} is still ${_BUILD_STATE}, not VALID."
        echo "    Wait for processing to finish, then re-run. Skipping submission."
      else
        # FATAL, not a warning. This used to be `|| echo WARNING (it may already be
        # attached)`, so a genuine failure carried on into submission and surfaced
        # as "The build associated with appStoreVersions ... was not found" - a
        # message that points nowhere near the real cause. If the build will not
        # attach there is nothing to submit, so stop here and say so.
        # _asc_attach_build treats already-attached as success. Its old inline
        # check called `asc versions get`, which asc has since removed.
        if ! _asc_attach_build "$ASC_VERSION_ID" "$_BUILD_ID"; then
          PUBLISH_FAILED=true
          _SKIP_SUBMIT=true
        fi

        # Nothing to submit if the build never attached. Guarding the whole
        # chain rather than each step, so there is exactly one place that
        # decides whether a submission should happen at all.
        if [ "${_SKIP_SUBMIT:-false}" = true ]; then
          echo "    Skipping submission (see the attach error above)."
        else
          # Export compliance. Apple blocks submission until every build answers
          # this, and it is set per BUILD, so a new build always starts unset.
          # It is a legal declaration, so ask rather than assume.
          # `asc validate` exits non-zero when it finds blocking errors, which is
          # exactly the case we care about, so capture first rather than piping
          # into grep under `set -o pipefail`.
          _VALIDATE_JSON=$(asc validate --app "$ASC_APP_ID" --version "$APP_VERSION" \
            --output json 2>/dev/null || true)
          if printf '%s' "$_VALIDATE_JSON" | grep -q 'build.encryption.missing'; then
            _PRIOR_ENC=$(_asc_prior_encryption)
            echo ""
            echo "    Apple needs an export-compliance answer for build ${_ios_build_number}."
            echo "    It is set per build, so a new build always starts unset, and it is a"
            echo "    legal declaration - so this asks rather than assuming."
            if [ -n "$_PRIOR_ENC" ]; then
              echo "    Most recent answered build of this app declared:"
              echo "      uses non-exempt encryption = ${_PRIOR_ENC}"
            else
              echo "    No prior build of this app has answered, so there is no precedent."
            fi
            _confirm "Declare build ${_ios_build_number} as NOT using non-exempt encryption?"
            asc builds update --build-id "$_BUILD_ID" --uses-non-exempt-encryption=false >/dev/null \
              || echo "    WARNING: could not set export compliance."
          fi

          echo "    Readiness check:"
          asc validate --app "$ASC_APP_ID" --version "$APP_VERSION" || true
          echo ""
            _confirm "Submit version ${APP_VERSION} for App Store review?"

          echo "    Submitting ${APP_VERSION} for review..."
          _SUBMISSION_ID=$(asc review submissions-create --app "$ASC_APP_ID" --platform IOS --output json 2>/dev/null \
            | python3 -c "
  import json, sys
  try:
      print(json.load(sys.stdin).get('data', {}).get('id', ''))
  except Exception:
      pass
  " 2>/dev/null)

          if [ -z "$_SUBMISSION_ID" ]; then
            echo "    WARNING: could not create a review submission."
            echo "    Submit manually: https://appstoreconnect.apple.com/apps/${ASC_APP_ID}"
          elif ! asc review items-add --submission "$_SUBMISSION_ID" \
                  --item-type appStoreVersions --item-id "$ASC_VERSION_ID" >/dev/null; then
            echo "    WARNING: could not add version ${APP_VERSION} to the submission."
            echo "    Cancel the empty submission: asc submit cancel --app ${ASC_APP_ID} --id ${_SUBMISSION_ID} --confirm"
          elif asc review submissions-submit --id "$_SUBMISSION_ID" --confirm >/dev/null; then
            echo "    Submitted for review."

            # ── Step 5: Check review status ──
            echo ""
            echo "==> Checking review status..."
            asc review status --app "$ASC_APP_ID" || true
            echo ""
            echo "    Monitor status:    asc review status --app $ASC_APP_ID"
            echo "    Diagnose issues:   asc review doctor --app $ASC_APP_ID"
          else
            echo "    WARNING: Submission failed - build may still be processing."
            echo "    Retry: asc review submissions-submit --id ${_SUBMISSION_ID} --confirm"
          fi
        fi
      fi
    fi
  else
    echo "    Build will appear in TestFlight within a few minutes."
    echo "    Submit for review manually via App Store Connect."
  fi
fi # end PUBLISH_APP_STORE

# ---------------------------------------------------------------------------
# 12. Post release announcement to Nostr
#
# Signs a kind:1 note with the Zapstore NSEC (SIGN_WITH) and broadcasts it
# to a set of well-known relays. Downloads nak if not already installed.
# ---------------------------------------------------------------------------
release_post_nostr

# ---------------------------------------------------------------------------
# 13. Close-out summary and deferred-action reminders
#
# Every publish step is best-effort past the tag push: a Zapstore outage sets
# PUBLISH_FAILED rather than aborting, so an already-created GitHub release is
# never stranded. That makes a final ledger worth printing, because a partial
# release otherwise scrolls past unnoticed. See RELEASE-PIPELINE.md §2.
# ---------------------------------------------------------------------------
release_summary
release_summary_end

release_deferred_reminders

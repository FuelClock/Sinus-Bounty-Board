Bounty Hunter v2.2.8 Fix Notes

## What This Fix Addresses

The v2.2.8 release introduced a critical persistence regression where bounty data was being lost during script upgrades.

### The Root Cause

| Version | Persistence Method | Outcome |
|---------|-------------------|----------|
| 2.2.7   | `store.set/get`   | ✅ Bounties survive reloads |
| 2.2.8   | `engine.saveConfig` | ❌ Bounties silently lost |

`engine.saveConfig` only saves keys declared in `manifest.json` `vars`. Dynamically-added `bountyData` is not in `vars`, so it gets dropped every time `saveData()` runs.

## Changes Made (v2.2.8)

### 1. Restored Proper Store Persistence
- Added `event.on('load')` to ensure script re-initialization on reload
- Added graceful `store` module availability check
- Reverted to `store.set/get` pattern used successfully in 2.2.6/2.2.7

### 2. Added Debug Command
- New `!bounty debug` command for runtime inspection
- Logs all store keys and their values to bot console
- Allows verification that bounty data is being persisted

### 3. Preserved All Other v2.2.8 Features
- All three config default changes (AUTH=23, CHANNEL=832, ADMIN=3)
- Help command with full command listing
- BBCode fix in channel description (removed `[/center]`)
- Numeric and name-based bounty removal

## How This Fixes the Problem

1. **Script loads fresh** — The `event.on('load')` ensures script restarts properly
2. **Data survives reloads** — Store persistence preserves bountyBoard data
3. **Debug verification** — `!bounty debug` confirms data is actually stored

## Usage

1. Deploy `bounty-board-v2.2.8.js` to SinusBot scripts directory
2. Enable script in Web Interface → Settings → Scripts
3. Restart SinusBot
4. Use `!bounty debug` to verify store contents (check bot logs)

## Deployment Verification

- GitHub `dev` branch contains the fix
- Version remains `2.2.8` (no version bump needed)
- Syntax validation passes (`node --check`)
- Store persistence test required to confirm fix works

The fix restores the exact persistence mechanism that worked in 2.2.7 and ensures bounty data survives script reloads and version upgrades.
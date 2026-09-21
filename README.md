# Bounty Hunter v2.3.1

Persistent bounty board plugin for SinusBot. Posts the board in a TeamSpeak channel description and supports claim, uploaded, and completion workflows.

## Features

- Persistent bounty board stored in SinusBot's `store` (survives restarts and reloads).
- Bounties sorted by gold amount, highest first.
- Channel description auto-refreshes (configurable interval, 0 = off).
- Claim flow: claim → upload evidence → complete.
- Poster is notified via chat DM when evidence is uploaded.
- Temporary channel-group file access for the claimant while evidence is pending.
- Case-insensitive player-name matching with prefix support for `remove` and `complete`.
- Optional OKlib integration; falls back to built-in helpers when OKlib is absent.
- Diagnostic commands: `test`, `debug`.
- Admin-only `clear`.

## Setup

1. Copy `A_bountyboard.js` and `manifest.json` into your SinusBot `scripts/` directory.
2. Make sure the `store` module is available (bundled with SinusBot >= 0.9.16).
3. Restart SinusBot (the plugin has `autorun: false` in the manifest — it loads on restart, not hot-reload).
4. Verify the bot is online and the display channel exists.

## Configuration

Set these variables in `manifest.json` or the SinusBot web UI before the first run:

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_NAME` | `bounty` | Command prefix; commands are `!<BOT_NAME> <subcommand>`. |
| `AUTHORIZED_GROUP` | `23` | Server group ID allowed to place/list bounties. |
| `DISPLAY_CHANNEL_ID` | `832` | Channel whose description shows the board. |
| `BOT_ADMIN_GROUP` | `17` | Server group ID with admin rights (clear, uploaded, unclaim). |
| `MAX_ACTIVE_BOUNTIES` | `50` | Cap on active bounties. |
| `AUTO_REFRESH_INTERVAL` | `30` | Channel-description refresh in seconds; `0` disables it. |
| `MIN_REWARD` | `1` | Minimum gold a bounty can require. |
| `MAX_REASON_LENGTH` | `50` | Maximum characters for a bounty reason. |
| `FILE_ACCESS_TIMER_SECONDS` | `300` | How long the claimant keeps file access (seconds). |
| `FILE_ACCESS_GROUP_ID` | `10` | Channel group ID granted to the claimant for evidence uploads. |

## Commands

| Command | Who can use it | What it does |
| --- | --- | --- |
| `!bounty add <player> <gold> [reason]` | Authorized user or admin | Places a bounty on `<player>` for `<gold>` gold. Reason is optional. |
| `!bounty list` | Authorized user or admin | Lists all active bounties in chat. |
| `!bounty remove <number>` | Bounty owner or admin | Removes a bounty by its 1-based ranking in the current list. |
| `!bounty remove <target>` | Bounty owner or admin | Removes a bounty by exact or prefix target name. |
| `!bounty clear` | Admin | Clears all bounties. |
| `!bounty claim <target>` | Authorized user or admin | Claims a bounty you did not post. |
| `!bounty unclaim <target>` | Claimant or admin | Cancels a pending claim on `<target>`. |
| `!bounty uploaded <target>` | Claimant or admin | Marks evidence as uploaded for the pending claim on `<target>`. |
| `!bounty complete <target>` | Bounty owner or admin | Completes/removes the bounty on `<target>` by exact or prefix name. |
| `!bounty help` | Authorized user or admin | Shows the command list. |
| `!bounty test` | Authorized user or admin | Checks bot authorization and version. |
| `!bounty debug` | Authorized user or admin | Dumps store contents to the log for diagnostics. |

## Permissions and ownership

- `add`, `list`, `help`, `test`, and `debug` pass the general authorized/admin gate.
- `remove` and `complete` require the bounty owner or an administrator.
- `clear` is administrator-only.
- `uploaded` and `unclaim` are claimant-scoped (the claimant or an admin).
- A bounty owner cannot claim their own bounty.
- A bounty owner can remove or complete their own bounty; admins can do the same for any bounty.

## Display rules

- Gold is displayed in gold and chest equivalents (1 chest = 500 gold, rounded up).
- The channel description shows the top 15 bounties with total gold.
- The full board is shown in chat when you run `!bounty list`.
- Pending claims show `[CLAIM PENDING]`; claimed bounties show `[CLAIMED]`.

## Persistence

- Bounties are stored in SinusBot's `store` under the `bountyBoard` key.
- Data survives restarts and script reloads.
- Keep the script filename as `A_bountyboard.js` so the store namespace stays stable across updates.

## User workflow (typical)

1. **Admin** sets `DISPLAY_CHANNEL_ID`, `AUTHORIZED_GROUP`, and `BOT_ADMIN_GROUP`, then restarts SinusBot.
2. **Poster** places a bounty: `!bounty add <player> <gold> [reason]`.
3. The board appears in the display channel description, sorted by gold.
4. **Claimant** kills the target and claims: `!bounty claim <target>`.
5. Claimant uploads evidence files to the display channel while access is granted.
6. Claimant marks evidence: `!bounty uploaded <target>`.
7. Poster receives a chat DM with a link to review the evidence and completes the bounty: `!bounty complete <target>`.
8. **Owner or admin** can also remove or clear bounties at any time.

## Troubleshooting

- Board blank after restart — wait for the first auto-refresh or verify `DISPLAY_CHANNEL_ID`.
- Commands not working — check `BOT_NAME`, `AUTHORIZED_GROUP`, and `BOT_ADMIN_GROUP` values.
- Store unavailable — persistence is disabled; bounties reset on restart.
- File access fails — verify `FILE_ACCESS_GROUP_ID` exists in TeamSpeak.
- Prefix differs from `!bounty` — change `BOT_NAME` in the manifest.
- `!bounty clear` listed in help but not working — confirm the plugin version is >= 2.3.1 and reload the script.

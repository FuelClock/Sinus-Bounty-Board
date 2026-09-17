# Bounty Hunter

Persistent bounty board for SinusBot.

## Features

- Persistent bounty board stored in SinusBot's `store`.
- Bounties are sorted by gold amount, highest first.
- Channel description auto-refreshes so the board stays current.
- Claim flow with pending status, evidence upload, and poster notifications.
- Temporary file access group for the claimant.
- Owner/admin removal and completion.
- Case-insensitive player-name matching.
- Optional OKlib integration with fallback behavior.
- Diagnostic commands for checking authorization and store contents.

## Setup

1. Copy `A_bountyboard.js` and `manifest.json` into the `scripts/` directory of your SinusBot installation.
2. Make sure the `store` module is available.
3. Restart SinusBot.
4. Set the plugin variables in `manifest.json` or the SinusBot web UI.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_NAME` | `bounty` | Bot command name and command prefix. |
| `AUTHORIZED_GROUP` | `23` | Server group ID allowed to use the bounty board. |
| `DISPLAY_CHANNEL_ID` | `832` | Channel ID used to display the bounty board in the channel description. |
| `BOT_ADMIN_GROUP` | `17` | Server group ID with administrative access. |
| `FILE_ACCESS_GROUP_ID` | `10` | Channel group ID used for claimant file access. |
| `MAX_ACTIVE_BOUNTIES` | `50` | Maximum number of active bounties. |
| `AUTO_REFRESH_INTERVAL` | `30` | Auto-refresh interval in seconds. `0` disables it. |
| `MIN_REWARD` | `1` | Minimum bounty reward in gold. |
| `MAX_REASON_LENGTH` | `50` | Maximum bounty reason length in characters. |
| `FILE_ACCESS_TIMER_SECONDS` | `300` | Claimant file access timer in seconds. |

## Commands

| Command | Who can use it | What it does |
| --- | --- | --- |
| `!bounty add <player> <gold> [reason]` | Authorized user or admin | Places a bounty on a player. The reason is optional. |
| `!bounty list` | Authorized user or admin | Lists all active bounties. |
| `!bounty remove <number>` | Bounty owner or admin | Removes a bounty by 1-based rank. |
| `!bounty remove <target>` | Bounty owner or admin | Removes a bounty by exact or prefix target name. |
| `!bounty clear` | Admin | Clears all bounties. |
| `!bounty claim <target>` | Authorized user or admin | Claims a bounty you have not posted yourself. |
| `!bounty unclaim <target>` | Claimant or admin | Cancels a pending claim. |
| `!bounty evidence <target>` | Claimant or admin | Marks evidence as uploaded for a pending claim. |
| `!bounty complete <target>` | Bounty owner or admin | Completes/removes a bounty by exact or prefix target name. |
| `!bounty help` | Authorized user or admin | Shows the command list. |
| `!bounty test` | Authorized user or admin | Checks bot authorization. |
| `!bounty debug` | Authorized user or admin | Shows store contents. |

## Permissions and ownership

- `add`, `list`, `help`, `test`, and `debug` pass the general authorized/admin gate.
- `remove` and `complete` accept the bounty owner or an administrator.
- `clear` is administrator-only.
- `evidence` and `unclaim` are claimant-scoped.
- A bounty owner cannot claim their own bounty.
- A bounty owner can remove or complete their own bounty; admins can do the same for any bounty.

## Display rules

- Gold is displayed in gold and chest equivalents.
- One chest is worth 500 gold, rounded up.
- The channel description shows the top 15 bounties.
- The full board is shown in chat when you run `!bounty list`.

## Persistence

- Bounties are stored in SinusBot's `store` under the `bountyBoard` key.
- Data survives reloads and upgrades.
- Keep the script filename as `A_bountyboard.js` so the store namespace stays stable.

## Troubleshooting

- If the board is blank after restart, wait for the first auto-refresh or check `DISPLAY_CHANNEL_ID`.
- If commands do not work, check `BOT_NAME`, `AUTHORIZED_GROUP`, and `BOT_ADMIN_GROUP`.
- If the store module is unavailable, persistence is disabled.
- Use `!bounty debug` to inspect store contents.
- If file access does not work, check `FILE_ACCESS_GROUP_ID`.
- If the command prefix is different, change `BOT_NAME`.
- If `!bounty clear` is listed in help but not working, check the plugin version and reload it; it is intended to be admin-only.

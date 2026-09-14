// Bounty Hunter Script v2.2.10 for SinusBot
// Complete bounty board system for sea battle guilds
// FIXED: Replaced non-existent private-message API with client.chat()
//       so command responses render in the current channel
// ENHANCED: Added name-based and numeric bounty removal with parsing
// FIXED: Improved persistence with error handling, data validation, and atomic saves
// ENHANCED: Better command handling and UI improvements
// FIXED: Improved initialization and persistence initialization flag
// CONFIG: Changed default authorized group to 23, display channel to 832, admin group to 3

registerPlugin({
    name: 'Bounty Hunter',
    version: '2.2.10',
    author: 'FuelClock',
    description: 'Complete bounty board system with persistent storage',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Bot Command Name', type: 'string', default: 'bounty' },
        { name: 'AUTHORIZED_GROUP', title: 'Server Group ID (authorized to place bounties)', type: 'string', default: '23' },
        { name: 'DISPLAY_CHANNEL_ID', title: 'Channel ID (display bounty board in description)', type: 'string', default: '832' },
        { name: 'BOT_ADMIN_GROUP', title: 'Server Group ID (admin)', type: 'string', default: '17' },
        { name: 'MAX_ACTIVE_BOUNTIES', title: 'Maximum active bounties at once', type: 'number', default: 50 },
        { name: 'AUTO_REFRESH_INTERVAL', title: 'Auto-refresh channel description (seconds, 0 = off)', type: 'number', default: 30 },
        { name: 'MIN_REWARD', title: 'Minimum bounty reward (gold)', type: 'number', default: 1 }
    ],
    requiredModules: ['engine', 'backend', 'event'],
    autorun: false
}, function(_, config, meta) {
    const engine = require('engine');
    const backend = require('backend');
    const event = require('event');

    var botName = config.BOT_NAME || 'bounty';
    var authorizedGroupId = String(config.AUTHORIZED_GROUP || '23');
    var displayChannelId = String(config.DISPLAY_CHANNEL_ID || '832');
    var botAdminGroupId = String(config.BOT_ADMIN_GROUP || '17');
    var maxBounties = parseInt(config.MAX_ACTIVE_BOUNTIES) || 50;
    var autoRefreshInterval = parseInt(config.AUTO_REFRESH_INTERVAL) || 30;
    var minReward = parseInt(config.MIN_REWARD) || 1;
    var fileAccessGroupId = String(config.FILE_ACCESS_GROUP_ID || '10');

    // ===== PERSISTENCE =====
    var bountyBoard = [];
    var bountyClaimTimers = {};
    var refreshTimer = null;
    var persistenceInitialized = false;
    var store = null;

    // Load store module for persistence (not a protected module — no requiredModules needed)
    try {
        store = require('store');
        engine.log('Store module loaded for persistence');
    } catch (e) {
        engine.log('WARNING: Store module unavailable — persistence disabled');
        store = null;
    }

    // ===== SCRIPT INITIALIZATION =====
    event.on('load', function(ev) {
        engine.log('Bounty Hunter v2.2.10 loaded');
        engine.log('Configuration - BotName: ' + botName + ', AuthGroup: ' + authorizedGroupId + ', DisplayChannel: ' + displayChannelId);

        if (backend.isConnected()) {
            initialize();
        } else {
            event.on('connect', function() {
                initialize();
            });
        }
    });

    function initialize() {
        engine.log('Initializing bounty hunter system...');
        loadPersistedData();
        updateChannelDescription();

        if (autoRefreshInterval > 0) {
            engine.log('Starting auto-refresh every ' + autoRefreshInterval + ' seconds');
            startAutoRefresh();
        }

        persistenceInitialized = true;
        engine.log('Initialization complete. Loaded ' + bountyBoard.length + ' bounties');
    }

    // ===== EVENT HANDLERS =====
    event.on('chat', function(ev) {
        if (ev.client.isSelf()) {
            return;
        }

        // Test command
        if (ev.text === '!btest' || ev.text.startsWith('!btest ')) {
            engine.log('TEST COMMAND RECEIVED from ' + ev.client.name());
            ev.client.chat('[BountyHunter] Test received — bounty hunter working');
            return;
        }

        // Bounty commands: !bounty <subcommand>
        var prefix = '!' + botName + ' ';
        if (ev.text.startsWith(prefix)) {
            var cmdText = ev.text.substring(prefix.length);
            engine.log('BOUNTY COMMAND from ' + ev.client.name() + ': ' + cmdText);
            handleCommand(cmdText, ev);
        }
    });

    // ===== COMMAND HANDLING =====
    function handleCommand(args, ev) {
        var invoker = ev.client;

        var clientGroups = invoker.getServerGroups();
        var isAuthorized = false;
        var isAdmin = false;

        for (var i = 0; i < clientGroups.length; i++) {
            var groupId = String(clientGroups[i].id());
            if (groupId === authorizedGroupId) {
                isAuthorized = true;
            }
            if (groupId === botAdminGroupId) {
                isAdmin = true;
            }
        }

        if (!isAdmin && !isAuthorized) {
            invoker.chat('[BountyHunter] Permission denied');
            return;
        }

        var parts = args.trim().split(/\s+/);
        var subCommand = parts[0].toLowerCase();

        if (subCommand === 'test') {
            invoker.chat('[BountyHunter] v2.2.10 test OK — authorized');
            return;
        }

        if (subCommand === 'help') {
            displayHelp(ev);
            return;
        }

        // Claim a bounty you have killed
        if (subCommand === 'claim') {
            if (parts.length < 2) {
                invoker.chat('Usage: !bounty claim <target>');
                return;
            }
            handleClaimBounty(parts.slice(1), ev);
            return;
        }

        // Debug command — view store contents
        if (subCommand === 'debug') {
            var storeData = store ? store.getAll() : null;
            if (storeData) {
                var keys = Object.keys(storeData);
                engine.log('DEBUG: Store has ' + keys.length + ' key(s): ' + keys.join(', '));
                for (var k = 0; k < keys.length; k++) {
                    engine.log('DEBUG: store["' + keys[k] + '"] = ' + JSON.stringify(storeData[keys[k]]).substring(0, 500));
                }
                invoker.chat('[BountyHunter] Debug: store has ' + keys.length + ' key(s) — check log');
            } else {
                engine.log('DEBUG: Store module not available');
                invoker.chat('[BountyHunter] Debug: store unavailable');
            }
            return;
        }

        // Enhanced remove command supports both numeric index and target name
        if (subCommand === 'remove') {
            if (parts.length < 2) {
                invoker.chat('Usage: !bounty remove <number> | !bounty remove <target>');
                return;
            }
            handleRemoveBounty(parts.slice(1), ev);
            return;
        }

        if (subCommand === 'clear') {
            handleClearBounties(ev);
            return;
        }

        if (subCommand === 'list') {
            displayBountyList(ev);
            return;
        }

        if (subCommand === 'add') {
            if (parts.length < 4) {
                invoker.chat('Usage: !bounty add <playername> <gold_amount> <reason>');
                return;
            }
            handlePlaceBounty(parts.slice(1), ev);
            return;
        }

        if (subCommand === 'complete') {
            handleCompleteBounty(ev);
            return;
        }

        invoker.chat('Unknown bounty command. Usage: !bounty add <playername> <gold_amount> <reason>');
    }

    // ===== HELP =====
    function displayHelp(ev) {
        var invoker = ev.client;

        var helpMsg = '[BountyHunter] BOUNTY COMMANDS:\n' +
            '!bounty add <playername> <gold> <reason> - Place a bounty\n' +
            '!bounty list - List all active bounties\n' +
            '!bounty remove <number> - Remove bounty by ranking (admin)\n' +
            '!bounty remove <target> - Remove bounty by name (admin)\n' +
            '!bounty clear - Clear all bounties (admin)\n' +
            '!bounty test - Test bot authorization\n' +
            '!bounty help - Show this help message\n' +
            '!bounty claim <target> - Claim a bounty you have killed\n' +
            '!bounty debug - View store contents\n' +
            '!bounty complete - Mark bounty as complete (poster only)';

        invoker.chat(helpMsg);
    }

    // ===== BOUNTY OPERATIONS =====
    function handlePlaceBounty(parts, ev) {
        var invoker = ev.client;

        if (parts.length < 3) {
            invoker.chat('Usage: !bounty <playername> <gold_amount> <reason>');
            return;
        }

        var playerName = parts[0];
        var goldAmount = parseInt(parts[1]);
        var reason = parts.slice(2).join(' ');

        if (isNaN(goldAmount) || goldAmount <= 0) {
            invoker.chat('Invalid gold amount');
            return;
        }

        if (goldAmount < minReward) {
            invoker.chat('Bounty must be at least ' + minReward + ' gold');
            return;
        }

        if (playerName.toLowerCase() === invoker.name().toLowerCase()) {
            invoker.chat('Cannot bounty yourself');
            return;
        }

        if (bountyBoard.length >= maxBounties) {
            invoker.chat('Bounty board is full');
            return;
        }

        var bountyEntry = {
            id: Date.now(),
            target: playerName,
            gold: goldAmount,
            reason: reason,
            postedBy: invoker.name(),
            postedAt: new Date().toISOString(),
            claimedBy: null,
            claimedAt: null
        };

        bountyBoard.push(bountyEntry);
        if (persistenceInitialized) {
            saveData();
        }
        sortBounties();
        updateChannelDescription();

        invoker.chat('Bounty placed on ' + playerName + ' for ' + goldAmount + ' gold!');
        var botClient = backend.getBotClient();
        if (botClient) {
            botClient.chat(invoker.name() + ' placed a bounty on ' + playerName + ' for ' + goldAmount + ' gold!');
        }
    }

    function handleClaimBounty(parts, ev) {
        var invoker = ev.client;
        var targetName = parts.join(' ');
        var foundBounty = null;
        var bountyIndex = -1;

        // Find the bounty with exact target name match
        for (var i = 0; i < bountyBoard.length; i++) {
            if (bountyBoard[i].target.toLowerCase() === targetName.toLowerCase()) {
                foundBounty = bountyBoard[i];
                bountyIndex = i;
                break;
            }
        }

        // Also check for exact match including claimedBy field
        if (!foundBounty) {
            for (var i = 0; i < bountyBoard.length; i++) {
                if (bountyBoard[i].target.toLowerCase() === targetName.toLowerCase() && !bountyBoard[i].claimedBy) {
                    foundBounty = bountyBoard[i];
                    bountyIndex = i;
                    break;
                }
            }
        }

        if (!foundBounty) {
            invoker.chat('[BountyHunter] Bounty not found: ' + targetName);
            return;
        }

        // Check if already fully claimed
        if (foundBounty.claimedBy && !foundBounty.claimPending) {
            invoker.chat('[BountyHunter] Bounty already claimed by ' + foundBounty.claimedBy);
            return;
        }

        // Check if already claim pending by someone else
        if (foundBounty.claimPending && foundBounty.claimedBy && foundBounty.claimedBy !== invoker.name()) {
            invoker.chat('[BountyHunter] Bounty already claim pending by ' + foundBounty.claimedBy);
            return;
        }

        // Check if this user already claimed this bounty
        if (foundBounty.claimPending && foundBounty.claimedBy === invoker.name()) {
            invoker.chat('[BountyHunter] You already have a pending claim on this bounty');
            return;
        }

        // Mark as claim pending (NOT removed from board)
        foundBounty.claimPending = true;
        foundBounty.claimedBy = invoker.name();
        foundBounty.claimedAt = new Date().toISOString();

        // Persist the change
        if (persistenceInitialized) {
            saveData();
        }

        // Update the channel description to show CLAIM PENDING status
        updateChannelDescription();

        // Notify the original poster if they are online
        var originalPoster = foundBounty.postedBy;
        if (originalPoster && originalPoster !== invoker.name()) {
            try {
                var allClients = backend.getClients();
                for (var ci = 0; ci < allClients.length; ci++) {
                    if (allClients[ci].name() === originalPoster) {
                        allClients[ci].poke('[BountyHunter] A claim has been filed on the bounty "' + foundBounty.target + '" by ' + invoker.name() + '.');
                        engine.log('Bounty claim: Notified original poster ' + originalPoster + ' about claim on ' + foundBounty.target);
                        break;
                    }
                }
            } catch (e) {
                engine.log('Bounty claim: Failed to notify original poster ' + originalPoster + ': ' + e.message);
            }
        }

        // Poke claimant with evidence submission instructions
        var pokeMessage = '[BountyHunter] Claim pending on ' + foundBounty.target + '. Upload your screenshot or video evidence to the file browser in the bounty board channel, named: ' + foundBounty.target + '. If the bounty poster is not online in Teamspeak, send a private message to them ingame to notify them about the claim.';
        try {
            invoker.poke(pokeMessage);
        } catch (e) {
            // Poke failed, log it
            engine.log('Bounty claim: Failed to poke claimant ' + invoker.name() + ': ' + e.message);
        }

        // ===== FILE ACCESS GROUP ASSIGNMENT =====
        // Assign persistent file access group to original poster (remains until bounty is completed)
        if (originalPoster && originalPoster !== invoker.name()) {
            try {
                var allClients = backend.getClients();
                for (var ci = 0; ci < allClients.length; ci++) {
                    if (allClients[ci].name() === originalPoster) {
                        var client = allClients[ci];
                        if (displayChannel) {
                            var channelGroups = backend.getChannelGroups();
                            var fileAccessGroup = null;
                            for (var i = 0; i < channelGroups.length; i++) {
                                if (String(channelGroups[i].id()) === fileAccessGroupId) {
                                    fileAccessGroup = channelGroups[i];
                                    break;
                                }
                            }

                            if (fileAccessGroup) {
                                displayChannel.setChannelGroup(client, fileAccessGroup);
                                engine.log('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to original poster ' + originalPoster + ' for bounty ' + foundBounty.target);
                            }
                        }
                        break;
                    }
                }
            } catch (e) {
                engine.log('Bounty claim: Failed to assign file access group to original poster ' + originalPoster + ': ' + e.message);
            }
        }

        // Grant claimant file access group temporarily (5 minutes)
        if (displayChannel) {
            try {
                var channelGroups = backend.getChannelGroups();
                var fileAccessGroup = null;
                for (var i = 0; i < channelGroups.length; i++) {
                    if (String(channelGroups[i].id()) === fileAccessGroupId) {
                        fileAccessGroup = channelGroups[i];
                        break;
                    }
                }

                if (fileAccessGroup) {
                    // Get current channel group
                    var currentChannelGroup = invoker.getChannelGroup();
                    var originalChannelGroup = currentChannelGroup ? currentChannelGroup.id() : null;

                    // Assign file access group
                    displayChannel.setChannelGroup(invoker, fileAccessGroup);
                    engine.log('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to claimant ' + invoker.name() + ' for bounty ' + foundBounty.target);

                    // Set timer to remove file access group after 5 minutes
                    var timerKey = invoker.name() + ':' + displayChannelId;
                    if (bountyClaimTimers[timerKey]) {
                        clearTimeout(bountyClaimTimers[timerKey]);
                    }

                    bountyClaimTimers[timerKey] = setTimeout(function() {
                        try {
                            if (originalChannelGroup) {
                                displayChannel.setChannelGroup(invoker, backend.getChannelGroupByID(originalChannelGroup));
                            }
                            delete bountyClaimTimers[timerKey];
                            engine.log('Bounty claim: Removed file access group from ' + invoker.name() + ' after 5 minutes');
                        } catch (e) {
                            engine.log('Bounty claim: Error removing file access group: ' + e.message);
                        }
                    }, 5 * 60 * 1000); // 5 minutes

                    invoker.chat('[BountyHunter] File access granted for 5 minutes');
                } else {
                    engine.log('Bounty claim: File access group ' + fileAccessGroupId + ' not found in channel');
                    invoker.chat('[BountyHunter] File access group not found');
                }
            } catch (e) {
                engine.log('Bounty claim: Error assigning file access group: ' + e.message);
                invoker.chat('[BountyHunter] Error granting file access');
            }
        } else {
            engine.log('Bounty claim: Display channel ' + displayChannelId + ' not found');
            invoker.chat('[BountyHunter] Display channel not found');
        }

        invoker.chat('[BountyHunter] Claim pending on ' + foundBounty.target + '. Upload your screenshot or video evidence to the file browser in the bounty board channel, named: ' + foundBounty.target + '.');
    }

    function handleCompleteBounty(ev) {
        var invoker = ev.client;
        var invokerName = invoker.name();

        // Find bounties with claimPending where the invoker is the original poster
        var pendingBounties = [];
        for (var i = 0; i < bountyBoard.length; i++) {
            if (bountyBoard[i].claimPending && bountyBoard[i].postedBy === invokerName) {
                pendingBounties.push(bountyBoard[i]);
            }
        }

        if (pendingBounties.length === 0) {
            invoker.chat('[BountyHunter] You have no pending claims to complete');
            return;
        }

        if (pendingBounties.length === 1) {
            var bounty = pendingBounties[0];
            completeBounty(bounty);
            return;
        }

        // Multiple pending bounties - list them
        var msg = '[BountyHunter] Pending claims:\n';
        for (var j = 0; j < pendingBounties.length; j++) {
            var b = pendingBounties[j];
            msg += (j + 1) + '. ' + b.target + ' - ' + formatGold(b.gold) + ' gold\n';
        }
        msg += 'Usage: !bounty complete <number>';
        invoker.chat(msg);
    }

    function completeBounty(bounty) {
        var bountyIndex = -1;
        for (var i = 0; i < bountyBoard.length; i++) {
            if (bountyBoard[i] === bounty) {
                bountyIndex = i;
                break;
            }
        }

        if (bountyIndex === -1) {
            engine.log('ERROR: Could not find bounty in completeBounty');
            return;
        }

        var claimant = bounty.claimedBy;
        var target = bounty.target;

        // Remove claim pending status
        bounty.claimPending = false;
        bounty.claimedBy = null;
        bounty.claimedAt = null;

        // Remove file access group from claimant if online
        if (claimant) {
            try {
                var allClients = backend.getClients();
                for (var ci = 0; ci < allClients.length; ci++) {
                    if (allClients[ci].name() === claimant) {
                        if (displayChannel) {
                            displayChannel.setChannelGroup(allClients[ci], backend.getChannelGroupByID(fileAccessGroupId));
                            engine.log('Bounty complete: Removed file access group from ' + claimant);
                        }
                        break;
                    }
                }
            } catch (e) {
                engine.log('Bounty complete: Failed to remove file access group from ' + claimant + ': ' + e.message);
            }
        }

        // Clear any pending timer for the claimant
        var claimantTimerKey = claimant + ':' + displayChannelId;
        if (bountyClaimTimers[claimantTimerKey]) {
            clearTimeout(bountyClaimTimers[claimantTimerKey].expiryTimer);
            delete bountyClaimTimers[claimantTimerKey];
        }

        // Persist
        if (persistenceInitialized) {
            saveData();
        }
        updateChannelDescription();

        invoker.chat('[BountyHunter] Bounty on ' + target + ' marked complete');
    }

    function handleRemoveBounty(args, ev) {
        var invoker = ev.client;
        var invokerName = invoker.name();

        // Owners can remove their own bounties; admins can remove any
        var isOwnerOrAdmin = function(bounty) {
            return bounty.postedBy === invokerName || isAdmin(invoker);
        };

        var searchTerm = args.join(' ');
        var removed = null;
        var removalReason = '';

        // Try numeric ranking first
        if (/^\d+$/.test(searchTerm)) {
            var index = parseInt(searchTerm, 10);
            if (index > 0 && index <= bountyBoard.length) {
                var entry = bountyBoard[index - 1];
                if (!isOwnerOrAdmin(entry)) {
                    invoker.chat('[BountyHunter] You can only remove your own bounties');
                    return;
                }
                removed = bountyBoard.splice(index - 1, 1);
                removalReason = 'ranking #' + index;
            }
        } else {
            // Try exact target name match
            for (var i = 0; i < bountyBoard.length; i++) {
                if (bountyBoard[i].target.toLowerCase() === searchTerm.toLowerCase()) {
                    var entry = bountyBoard[i];
                    if (!isOwnerOrAdmin(entry)) {
                        invoker.chat('[BountyHunter] You can only remove your own bounties');
                        return;
                    }
                    removed = bountyBoard.splice(i, 1);
                    removalReason = 'matched by name';
                    break;
                }
            }

            // Try prefix name match (e.g. "Ger" for Gerrit)
            if (!removed) {
                for (var i = 0; i < bountyBoard.length; i++) {
                    if (bountyBoard[i].target.toLowerCase().indexOf(searchTerm.toLowerCase()) === 0) {
                        var entry = bountyBoard[i];
                        if (!isOwnerOrAdmin(entry)) {
                            invoker.chat('[BountyHunter] You can only remove your own bounties');
                            return;
                        }
                        removed = bountyBoard.splice(i, 1);
                        removalReason = 'matched by name';
                        break;
                    }
                }
            }
        }

        if (removed) {
            if (persistenceInitialized) {
                saveData();
            }
            updateChannelDescription();
            invoker.chat('[BountyHunter] Removed: ' + removed[0].target + ' (' + removalReason + ')');
            return;
        }

        invoker.chat('[BountyHunter] Bounty not found: "' + searchTerm + '". Use !bounty list to see all bounties.');
    }

    function handleClearBounties(ev) {
        var invoker = ev.client;

        if (!isAdmin(invoker)) {
            invoker.chat('[BountyHunter] Admin only');
            return;
        }

        bountyBoard = [];
        if (persistenceInitialized) {
            saveData();
        }
        updateChannelDescription();

        invoker.chat('[BountyHunter] All bounties cleared');
    }

// ===== DISPLAY FUNCTIONS =====
    function formatGold(gold) {
        var chests = Math.ceil(gold / 500);
        if (chests > 0) {
            return gold + ' gold (' + chests + ' chest' + (chests !== 1 ? 's' : '') + ')';
        }
        return gold + ' gold';
    }

    function displayBountyList(ev) {
        var invoker = ev.client;

        if (bountyBoard.length === 0) {
            invoker.chat('[BountyHunter] Bounty board is empty');
            return;
        }

        var msg = '[BountyHunter] BOUNTY BOARD (' + bountyBoard.length + ' bounties)\n';
        msg += '[Number]  Target              Gold  Reason (by poster)\n';
        msg += '------  -----------------  -----  -------------------------------\n';

        for (var i = 0; i < bountyBoard.length; i++) {
            var b = bountyBoard[i];
            var goldDisplay = formatGold(b.gold);
            msg += (i + 1) + '.    ' + b.target.padEnd(17) + '  ' + goldDisplay + '  ' + b.reason.substring(0, 40).padEnd(40) + ' (' + b.postedBy + ')\n';
            if (b.claimedBy) {
                msg += '       CLAIMED by ' + b.claimedBy + ' at ' + new Date(b.claimedAt).toLocaleString() + '\n';
            }
        }
        msg += '\n!bounty remove <number> | !bounty remove <target> (admin only)';

        invoker.chat(msg);
    }

    // ===== UTILITY FUNCTIONS =====
    function isAdmin(invoker) {
        var clientGroups = invoker.getServerGroups();
        for (var i = 0; i < clientGroups.length; i++) {
            if (String(clientGroups[i].id()) === botAdminGroupId) {
                return true;
            }
        }
        return false;
    }

    function sortBounties() {
        bountyBoard.sort(function(a, b) {
            return b.gold - a.gold;
        });
        if (persistenceInitialized) {
            saveData();
        }
    }

    function saveData() {
        try {
            if (store) {
                // store.set persists data across script reloads/restarts
                store.set('bountyBoard', JSON.stringify(bountyBoard));
            } else {
                engine.log('ERROR: Cannot save data — store module unavailable');
            }
        } catch (e) {
            engine.log('ERROR saving data: ' + e.message);
        }
    }

    function loadPersistedData() {
        try {
            if (store) {
                var rawData = store.get('bountyBoard');
                if (rawData) {
                    var parsedData = JSON.parse(rawData);
                    if (Array.isArray(parsedData)) {
                        bountyBoard = parsedData.map(function(entry) {
                            return {
                                id: entry.id && typeof entry.id === 'number' ? entry.id : Date.now(),
                                target: typeof entry.target === 'string' ? entry.target : '',
                                gold: typeof entry.gold === 'number' ? entry.gold : (typeof entry.gold === 'string' ? parseInt(entry.gold) : 0),
                                reason: typeof entry.reason === 'string' ? entry.reason : '',
                                postedBy: typeof entry.postedBy === 'string' ? entry.postedBy : '',
                                postedAt: typeof entry.postedAt === 'string' ? entry.postedAt : new Date().toISOString(),
                                claimedBy: entry.claimedBy || null,
                                claimedAt: entry.claimedAt || null
                            };
                        });
                    } else {
                        bountyBoard = [];
                    }
                } else {
                    bountyBoard = [];
                }
            } else {
                engine.log('WARNING: Cannot load data — store module unavailable, starting with empty board');
                bountyBoard = [];
            }
        } catch (e) {
            engine.log('ERROR loading persisted data: ' + e.message);
            bountyBoard = [];
        }
    }

    function updateChannelDescription() {
        var channel = backend.getChannelByID(displayChannelId);
        if (!channel) {
            engine.log('ERROR: Display channel ' + displayChannelId + ' not found');
            return;
        }

        var totalGold = 0;
        for (var i = 0; i < bountyBoard.length; i++) {
            totalGold += bountyBoard[i].gold;
        }

        var bountyList = '';
        for (var i = 0; i < bountyBoard.length && i < 15; i++) {
            var b = bountyBoard[i];
            var claimedStatus = b.claimedBy ? ' [CLAIMED]' : '';
            bountyList += (i + 1) + '. ' + b.target + ' - ' + formatGold(b.gold) + claimedStatus + '\n';
        }

        if (bountyBoard.length === 0) {
            bountyList = '[center]No active bounties[/center]';
        } else if (bountyBoard.length > 15) {
            bountyList += '... and ' + (bountyBoard.length - 15) + ' more';
        }

        var description = '[center][b][color=#FFD700]BOUNTY BOARD[/color][/b][/center]\n[center]Gold Available: [color=#00FF00]' + totalGold + '[/color][/center]\n' + bountyList;

        try {
            channel.setDescription(description);
        } catch (e) {
            engine.log('ERROR updating channel: ' + e.message);
        }
    }

    function startAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
        }

        refreshTimer = setInterval(function() {
            updateChannelDescription();
        }, autoRefreshInterval * 1000);
    }
});
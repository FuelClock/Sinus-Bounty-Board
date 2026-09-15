// Bounty Hunter Script v2.3.0 for SinusBot
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
    version: '2.3.0',
    author: 'FuelClock',
    description: 'Complete bounty board system with persistent storage',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Bot Command Name', type: 'string', default: 'bounty' },
        { name: 'AUTHORIZED_GROUP', title: 'Server Group ID (authorized to place bounties)', type: 'string', default: '23' },
        { name: 'DISPLAY_CHANNEL_ID', title: 'Channel ID (display bounty board in description)', type: 'string', default: '832' },
        { name: 'BOT_ADMIN_GROUP', title: 'Server Group ID (admin)', type: 'string', default: '17' },
        { name: 'FILE_ACCESS_GROUP_ID', title: 'Channel Group ID (file access for claim evidence)', type: 'string', default: '10' },
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

    // ===== STORE MODULE =====
    try {
        store = require('store');
        logMessage('Store module loaded for persistence', 3);
    } catch (e) {
        logMessage('WARNING: Store module unavailable — persistence disabled', 2);
        store = null;
    }

    // ===== OKLIB INTEGRATION =====
    var oklib = null;
    var oklibAvailable = false;

    try {
        var loadedOklib = require('OKlib.js');
        if (loadedOklib && loadedOklib.general &&
            typeof loadedOklib.general.checkVersion === 'function' &&
            loadedOklib.general.checkVersion('1.0.6')) {
            oklib = loadedOklib;
            oklibAvailable = true;
        }
    } catch (e) {
        logMessage('WARNING: OKlib could not be loaded: ' + e.message, 2);
    }

    if (!oklibAvailable) {
        logMessage('WARNING: OKlib 1.0.6+ unavailable — using manual implementations', 2);
    } else {
        logMessage('OKlib loaded successfully (v1.0.6+)', 3);
    }

    function logMessage(message, level) {
        if (oklibAvailable && oklib.general && typeof oklib.general.log === 'function') {
            oklib.general.log(message, level || 4);
            return;
        }
        engine.log(message);
    }

    function containsIgnoreCase(value, search) {
        if (oklibAvailable && oklib.comparator && typeof oklib.comparator.containsIgnoreCase === 'function') {
            return oklib.comparator.containsIgnoreCase(String(value || ''), String(search || ''));
        }
        return String(value || '').toLowerCase().indexOf(String(search || '').toLowerCase()) !== -1;
    }

    function equalsIgnoreCase(left, right) {
        return containsIgnoreCase(left, right) && containsIgnoreCase(right, left);
    }

    function startsWithIgnoreCase(value, prefix) {
        value = String(value || '');
        prefix = String(prefix || '');
        return equalsIgnoreCase(value.substring(0, prefix.length), prefix);
    }

    function isMemberOfOne(client, groups) {
        if (oklibAvailable && oklib.client && typeof oklib.client.isMemberOfOne === 'function') {
            return oklib.client.isMemberOfOne(client, groups);
        }

        if (!client || typeof client.getServerGroups !== 'function') {
            return false;
        }

        var groupIds = Array.isArray(groups) ? groups : [groups];
        var clientGroups = client.getServerGroups();
        for (var i = 0; i < clientGroups.length; i++) {
            var clientId = String(clientGroups[i].id());
            for (var j = 0; j < groupIds.length; j++) {
                if (clientId === String(groupIds[j])) {
                    return true;
                }
            }
        }
        return false;
    }

    function searchClients(query, partMatch, caseSensitive, clients) {
        if (oklibAvailable && oklib.client && typeof oklib.client.search === 'function') {
            return oklib.client.search(query, partMatch, caseSensitive, clients);
        }

        var searchPool = Array.isArray(clients) ? clients : backend.getClients();
        var searchTerm = String(query || '');
        var results = [];
        for (var i = 0; i < searchPool.length; i++) {
            var client = searchPool[i];
            var clientName = typeof client.name === 'function' ? client.name() : String(client.name || '');
            var nameMatches = caseSensitive
                ? clientName === searchTerm
                : equalsIgnoreCase(clientName, searchTerm);
            if (partMatch) {
                nameMatches = caseSensitive
                    ? clientName.indexOf(searchTerm) !== -1
                    : containsIgnoreCase(clientName, searchTerm);
            }

            if (nameMatches || String(client.uid ? client.uid() : '').indexOf(searchTerm) !== -1 ||
                String(client.id ? client.id() : '').indexOf(searchTerm) !== -1) {
                results.push(client);
            }
        }
        return results;
    }

    function isAuthorized(invoker) {
        return isMemberOfOne(invoker, [authorizedGroupId]);
    }

    function isAdmin(invoker) {
        return isMemberOfOne(invoker, [botAdminGroupId]);
    }

    if (!oklibAvailable) {
        oklib = {
            general: {
                checkVersion: function() { return false; },
                log: logMessage
            },
            client: {
                search: searchClients,
                isMemberOfOne: isMemberOfOne
            },
            comparator: {
                containsIgnoreCase: containsIgnoreCase
            }
        };
    }

    // ===== SCRIPT INITIALIZATION =====
    event.on('load', function(ev) {
        logMessage('Bounty Hunter v2.3.0 loaded');
        logMessage('Configuration - BotName: ' + botName + ', AuthGroup: ' + authorizedGroupId + ', DisplayChannel: ' + displayChannelId);

        if (backend.isConnected()) {
            initialize();
        } else {
            event.on('connect', function() {
                initialize();
            });
        }
    });

    function initialize() {
        logMessage('Initializing bounty hunter system...');
        loadPersistedData();
        updateChannelDescription();

        if (autoRefreshInterval > 0) {
            logMessage('Starting auto-refresh every ' + autoRefreshInterval + ' seconds');
            startAutoRefresh();
        }

        persistenceInitialized = true;
        logMessage('Initialization complete. Loaded ' + bountyBoard.length + ' bounties');
    }

    // ===== EVENT HANDLERS =====
    event.on('chat', function(ev) {
        if (ev.client.isSelf()) {
            return;
        }

        // Bounty commands: !<botName> <subcommand>
        var prefix = '!' + botName + ' ';
        if (ev.text.startsWith(prefix)) {
            var cmdText = ev.text.substring(prefix.length);
            logMessage('BOUNTY COMMAND from ' + ev.client.name() + ': ' + cmdText, 4);
            handleCommand(cmdText, ev);
        }
    });

    // ===== COMMAND HANDLING =====
    function handleCommand(args, ev) {
        var invoker = ev.client;

        var invokerIsAdmin = isAdmin(invoker);
        var invokerIsAuthorized = isAuthorized(invoker);

        // Diagnostic: log group membership to troubleshoot permission issues
        var invokerGroupIds = [];
        if (invoker && typeof invoker.getServerGroups === 'function') {
            var rawGroups = invoker.getServerGroups();
            for (var gi = 0; gi < rawGroups.length; gi++) {
                invokerGroupIds.push(rawGroups[gi].id());
            }
        }
        logMessage('AUTH CHECK: ' + invoker.name() + ' groups=[' + invokerGroupIds.join(',') + '] authGroup=' + authorizedGroupId + ' adminGroup=' + botAdminGroupId + ' >> authorized=' + invokerIsAuthorized + ' admin=' + invokerIsAdmin, 3);

        if (!invokerIsAdmin && !invokerIsAuthorized) {
            invoker.chat('[BountyHunter] Permission denied');
            return;
        }

        var parts = args.trim().split(/\s+/);
        var subCommand = parts[0].toLowerCase();

        if (subCommand === 'test') {
            invoker.chat('[BountyHunter] v2.3.0 test OK — authorized');
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
                logMessage('DEBUG: Store has ' + keys.length + ' key(s): ' + keys.join(', '), 4);
                for (var k = 0; k < keys.length; k++) {
                    logMessage('DEBUG: store["' + keys[k] + '"] = ' + JSON.stringify(storeData[keys[k]]).substring(0, 500), 4);
                }
                invoker.chat('[BountyHunter] Debug: store has ' + keys.length + ' key(s) — check log');
            } else {
                logMessage('DEBUG: Store module not available', 4);
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
            if (parts.length < 2) {
                invoker.chat('Usage: !bounty complete <target>');
                return;
            }
            handleCompleteBounty(parts.slice(1), ev);
            return;
        }

        invoker.chat('Unknown bounty command. Usage: !bounty add <playername> <gold_amount> <reason>');
    }

    // ===== HELP =====
    function displayHelp(ev) {
        var invoker = ev.client;
        var p = '!' + botName;

        var helpMsg = '[BountyHunter] BOUNTY COMMANDS:\n' +
            p + ' add <playername> <gold> <reason> - Place a bounty\n' +
            p + ' list - List all active bounties\n' +
            p + ' remove <number> - Remove bounty by ranking (admin)\n' +
            p + ' remove <target> - Remove bounty by name (admin)\n' +
            p + ' clear - Clear all bounties (admin)\n' +
            p + ' test - Test bot authorization\n' +
            p + ' help - Show this help message\n' +
            p + ' claim <target> - Claim a bounty you have killed\n' +
            p + ' debug - View store contents\n' +
            p + ' complete <target> - Remove bounty by name';

        invoker.chat(helpMsg);
    }

    // ===== BOUNTY OPERATIONS =====
    function handlePlaceBounty(parts, ev) {
        var invoker = ev.client;

        if (parts.length < 3) {
            invoker.chat('Usage: !bounty add <playername> <gold_amount> <reason>');
            return;
        }

        var playerName = String(parts[0] || '').trim();
        var goldStr = String(parts[1] || '').trim();
        var reason = parts.slice(2).join(' ').trim();

        if (!playerName) {
            invoker.chat('Invalid player name');
            return;
        }

        if (!/^\d+$/.test(goldStr)) {
            invoker.chat('Invalid gold amount — use a positive whole number');
            return;
        }
        var goldAmount = parseInt(goldStr, 10);

        if (goldAmount <= 0) {
            invoker.chat('Invalid gold amount');
            return;
        }

        if (!reason) {
            invoker.chat('Please add a reason for the bounty');
            return;
        }

        if (goldAmount < minReward) {
            invoker.chat('Bounty must be at least ' + minReward + ' gold');
            return;
        }

        if (equalsIgnoreCase(playerName, invoker.name())) {
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
        var displayChannel = backend.getChannelByID(displayChannelId);
        var foundBounty = null;
        var bountyIndex = -1;

        // Find the bounty with exact target name match
        for (var i = 0; i < bountyBoard.length; i++) {
            if (equalsIgnoreCase(bountyBoard[i].target, targetName)) {
                foundBounty = bountyBoard[i];
                bountyIndex = i;
                break;
            }
        }

        // Also check for exact match including claimedBy field
        if (!foundBounty) {
            for (var i = 0; i < bountyBoard.length; i++) {
                if (equalsIgnoreCase(bountyBoard[i].target, targetName) && !bountyBoard[i].claimedBy) {
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
                var posterClients = searchClients(originalPoster, false, false, allClients);
                if (posterClients.length > 0) {
                    var posterPokeMsg = '[BountyHunter] Claim filed on ' + foundBounty.target + '. Check the bounty board files for evidence.';
                    if (posterPokeMsg.length > 80) {
                        posterPokeMsg = posterPokeMsg.substring(0, 80);
                    }
                    posterClients[0].poke(posterPokeMsg);
                    logMessage('Bounty claim: Notified original poster ' + originalPoster + ' about claim on ' + foundBounty.target, 3);
                }
            } catch (e) {
                logMessage('Bounty claim: Failed to notify original poster ' + originalPoster + ': ' + e.message, 2);
            }
        }

        // Poke claimant with evidence submission instructions
        // Send short poke first (within TeamSpeak poke length limit)
        try {
            invoker.poke('[BountyHunter] Claim pending on ' + foundBounty.target + '. Check your DM.');
        } catch (e) {
            logMessage('Bounty claim: Failed to poke claimant ' + invoker.name() + ': ' + e.message, 2);
        }

        // Send full instructions via channel chat
        var dmMessage = '[BountyHunter] Claim instructions for bounty ' + foundBounty.target + ': Upload your screenshot or video evidence to the file browser in the bounty board channel(right click the channel > browse files). If the bounty poster is not online in Teamspeak, send a private message to them ingame to notify them about the claim.';
        try {
            invoker.chat(dmMessage);
        } catch (e) {
            logMessage('Bounty claim: Failed to send DM instructions to ' + invoker.name() + ': ' + e.message, 2);
        }

        // ===== FILE ACCESS GROUP ASSIGNMENT =====
        // Assign persistent file access group to original poster (remains until bounty is completed)
        if (originalPoster && originalPoster !== invoker.name()) {
            try {
                var allClients = backend.getClients();
                var posterClients = searchClients(originalPoster, false, false, allClients);
                if (posterClients.length > 0) {
                    var client = posterClients[0];
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
                            var posterOrigGroup = client.getChannelGroup();
                            foundBounty.posterOriginalGroupId = posterOrigGroup ? posterOrigGroup.id() : null;
                            if (persistenceInitialized) {
                                saveData();
                            }
                            displayChannel.setChannelGroup(client, fileAccessGroup);
                            logMessage('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to original poster ' + originalPoster + ' for bounty ' + foundBounty.target, 3);
                        }
                    }
                }
            } catch (e) {
                logMessage('Bounty claim: Failed to assign file access group to original poster ' + originalPoster + ': ' + e.message, 2);
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
                    foundBounty.claimantOriginalGroupId = originalChannelGroup;
                    if (persistenceInitialized) {
                        saveData();
                    }

                    // Assign file access group
                    displayChannel.setChannelGroup(invoker, fileAccessGroup);
                    logMessage('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to claimant ' + invoker.name() + ' for bounty ' + foundBounty.target, 3);

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
                            logMessage('Bounty claim: Removed file access group from ' + invoker.name() + ' after 5 minutes', 3);
                        } catch (e) {
                            logMessage('Bounty claim: Error removing file access group: ' + e.message, 1);
                        }
                    }, 5 * 60 * 1000); // 5 minutes

                    invoker.chat('[BountyHunter] File access granted for 5 minutes');
                } else {
                    logMessage('Bounty claim: File access group ' + fileAccessGroupId + ' not found in channel', 2);
                    invoker.chat('[BountyHunter] File access group not found');
                }
            } catch (e) {
                logMessage('Bounty claim: Error assigning file access group: ' + e.message, 1);
                invoker.chat('[BountyHunter] Error granting file access');
            }
        } else {
            logMessage('Bounty claim: Display channel ' + displayChannelId + ' not found', 2);
            invoker.chat('[BountyHunter] Display channel not found');
        }

    }

    function revokeClaimAccess(bounty) {
        // Restore the original display-channel group for the poster and claimant
        // so completing/removing a bounty does not leave file-access permissions behind.
        var displayChannel = backend.getChannelByID(displayChannelId);
        if (!displayChannel || !bounty) {
            return;
        }

        // Poster
        if (bounty.postedBy && bounty.posterOriginalGroupId !== undefined && bounty.posterOriginalGroupId !== null) {
            try {
                var posterClients = searchClients(bounty.postedBy, false, false, backend.getClients());
                if (posterClients.length > 0) {
                    displayChannel.setChannelGroup(posterClients[0], backend.getChannelGroupByID(bounty.posterOriginalGroupId));
                    logMessage('Bounty: Restored poster ' + bounty.postedBy + ' to group ' + bounty.posterOriginalGroupId, 3);
                }
            } catch (e) {
                logMessage('Bounty: Failed to restore poster group: ' + e.message, 2);
            }
        }

        // Claimant — clear pending timer and restore
        if (bounty.claimedBy) {
            try {
                var timerKey = bounty.claimedBy + ':' + displayChannelId;
                if (bountyClaimTimers[timerKey]) {
                    clearTimeout(bountyClaimTimers[timerKey]);
                    delete bountyClaimTimers[timerKey];
                }
                if (bounty.claimantOriginalGroupId !== undefined && bounty.claimantOriginalGroupId !== null) {
                    var claimantClients = searchClients(bounty.claimedBy, false, false, backend.getClients());
                    if (claimantClients.length > 0) {
                        displayChannel.setChannelGroup(claimantClients[0], backend.getChannelGroupByID(bounty.claimantOriginalGroupId));
                        logMessage('Bounty: Restored claimant ' + bounty.claimedBy + ' to group ' + bounty.claimantOriginalGroupId, 3);
                    }
                }
            } catch (e) {
                logMessage('Bounty: Failed to restore claimant group: ' + e.message, 2);
            }
        }
    }

    function handleCompleteBounty(args, ev) {
        var invoker = ev.client;
        var invokerName = invoker.name();

        // Owners can complete their own bounties; admins can complete any
        var isOwnerOrAdmin = function(bounty) {
            return bounty.postedBy === invokerName || isAdmin(invoker);
        };

        // !bounty complete without a target does nothing
        if (args.length === 0) {
            invoker.chat('Usage: !bounty complete <target>');
            return;
        }

        var searchTerm = args.join(' ');
        var removed = null;
        var removalReason = '';

        // Try exact target name match first
        for (var i = 0; i < bountyBoard.length; i++) {
            if (equalsIgnoreCase(bountyBoard[i].target, searchTerm)) {
                if (!isOwnerOrAdmin(bountyBoard[i])) {
                    invoker.chat('[BountyHunter] You can only complete your own bounties');
                    return;
                }
                removed = bountyBoard.splice(i, 1);
                removalReason = 'matched by name';
                break;
            }
        }

        // Try prefix name match
        if (!removed) {
            for (var i = 0; i < bountyBoard.length; i++) {
                if (startsWithIgnoreCase(bountyBoard[i].target, searchTerm)) {
                    if (!isOwnerOrAdmin(bountyBoard[i])) {
                        invoker.chat('[BountyHunter] You can only complete your own bounties');
                        return;
                    }
                    removed = bountyBoard.splice(i, 1);
                    removalReason = 'matched by name';
                    break;
                }
            }
        }

        if (removed) {
            revokeClaimAccess(removed[0]);
            if (persistenceInitialized) {
                saveData();
            }
            updateChannelDescription();
            invoker.chat('[BountyHunter] Removed: ' + removed[0].target + ' (' + removalReason + ')');
            return;
        }

        invoker.chat('[BountyHunter] Bounty not found: "' + searchTerm + '". Use !bounty list to see all bounties.');
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
                if (equalsIgnoreCase(bountyBoard[i].target, searchTerm)) {
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
                    if (startsWithIgnoreCase(bountyBoard[i].target, searchTerm)) {
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
            revokeClaimAccess(removed[0]);
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
            if (b.claimPending) {
                msg += '       CLAIM PENDING by ' + b.claimedBy + ' at ' + new Date(b.claimedAt).toLocaleString() + '\n';
            } else if (b.claimedBy) {
                msg += '       CLAIMED by ' + b.claimedBy + ' at ' + new Date(b.claimedAt).toLocaleString() + '\n';
            }
        }
        msg += '\n!bounty remove <number> | !bounty remove <target> (admin only)';

        invoker.chat(msg);
    }

    // ===== UTILITY FUNCTIONS =====
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
                logMessage('ERROR: Cannot save data — store module unavailable', 1);
            }
        } catch (e) {
            logMessage('ERROR saving data: ' + e.message, 1);
        }
    }

    function sanitizeBountyEntry(entry) {
        // Reject malformed entries and sanitize known fields while preserving
        // any unknown/future fields so they are not silently dropped on load.
        if (!entry || typeof entry !== 'object') {
            return null;
        }

        var out = {};
        for (var key in entry) {
            if (entry.hasOwnProperty(key)) {
                out[key] = entry[key];
            }
        }

        out.id = (typeof entry.id === 'number') ? entry.id : Date.now();
        out.target = (typeof entry.target === 'string') ? entry.target : '';
        var goldVal = (typeof entry.gold === 'number') ? entry.gold : parseInt(entry.gold, 10);
        out.gold = isNaN(goldVal) ? 0 : goldVal;
        out.reason = (typeof entry.reason === 'string') ? entry.reason : '';
        out.postedBy = (typeof entry.postedBy === 'string') ? entry.postedBy : '';
        out.postedAt = (typeof entry.postedAt === 'string' && entry.postedAt) ? entry.postedAt : new Date().toISOString();
        out.claimedBy = entry.claimedBy || null;
        out.claimedAt = entry.claimedAt || null;
        out.claimPending = !!entry.claimPending;

        return out;
    }

    function loadPersistedData() {
        try {
            if (store) {
                var rawData = store.get('bountyBoard');
                if (rawData) {
                    var parsedData = JSON.parse(rawData);
                    if (Array.isArray(parsedData)) {
                        var loaded = [];
                        for (var i = 0; i < parsedData.length; i++) {
                            var clean = sanitizeBountyEntry(parsedData[i]);
                            if (clean) {
                                loaded.push(clean);
                            }
                        }
                        bountyBoard = loaded;
                    } else {
                        bountyBoard = [];
                    }
                } else {
                    bountyBoard = [];
                }
            } else {
                logMessage('WARNING: Cannot load data — store module unavailable, starting with empty board', 2);
                bountyBoard = [];
            }
        } catch (e) {
            logMessage('ERROR loading persisted data: ' + e.message, 1);
            bountyBoard = [];
        }
    }

    function updateChannelDescription() {
        var channel = backend.getChannelByID(displayChannelId);
        if (!channel) {
            logMessage('ERROR: Display channel ' + displayChannelId + ' not found', 1);
            return;
        }

        var totalGold = 0;
        for (var i = 0; i < bountyBoard.length; i++) {
            totalGold += bountyBoard[i].gold;
        }

        var bountyList = '';
        for (var i = 0; i < bountyBoard.length && i < 15; i++) {
            var b = bountyBoard[i];
            var claimedStatus = b.claimPending ? ' [CLAIM PENDING]' : (b.claimedBy ? ' [CLAIMED]' : '');
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
            logMessage('ERROR updating channel: ' + e.message, 1);
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
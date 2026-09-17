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
    requiredModules: ['engine', 'backend', 'event', 'store'],
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
    var maxReasonLength = parseInt(config.MAX_REASON_LENGTH) || 50;
    var fileAccessTimerSeconds = parseInt(config.FILE_ACCESS_TIMER_SECONDS) || 300;

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
        logMessage('FATAL: Store module unavailable — persistence disabled. Add "store" to requiredModules in manifest.', 1);
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

        var parts = args.trim().split(/\s+/);
        var subCommand = parts[0].toLowerCase();

        // evidence is claimant-scoped and bypasses the general admin/authorized gate
        if (subCommand === 'evidence') {
            if (parts.length < 2) {
                invoker.chat('Usage: !bounty evidence <target>');
                return;
            }
            handleEvidenceUploaded(parts.slice(1), ev);
            return;
        }

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
            if (parts.length < 3) {
                var missing = [];
                if (parts.length < 2) { missing.push('playername'); }
                if (parts.length < 3) { missing.push('gold amount'); }
                invoker.chat('[BountyHunter] Missing: ' + missing.join(', ') + '. Usage: !bounty add <playername> <gold_amount> [reason]');
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

        if (subCommand === 'unclaim') {
            if (parts.length < 2) {
                invoker.chat('Usage: !bounty unclaim <target>');
                return;
            }
            handleUnclaim(parts.slice(1), ev);
            return;
        }

        invoker.chat('Unknown bounty command. Usage: !bounty add <playername> <gold_amount> [reason]');
    }

    // ===== HELP =====
    function displayHelp(ev) {
        var invoker = ev.client;
        var p = '!' + botName;

        var helpMsg = '[BountyHunter] BOUNTY COMMANDS:\n' +
            p + ' add <playername> <gold> [reason] - Place a bounty\n' +
            p + ' list - List all active bounties\n' +
            p + ' remove <number> - Remove bounty by ranking (bounty owner or admin)\n' +
            p + ' remove <target> - Remove bounty by name (bounty owner or admin)\n' +
            p + ' clear - Clear all bounties (admin)\n' +
            p + ' test - Test bot authorization\n' +
            p + ' help - Show this help message\n' +
            p + ' claim <target> - Claim a bounty you have killed\n' +
            p + ' unclaim <target> - Cancel a pending claim\n' +
            p + ' evidence <target> - Mark evidence as uploaded (claimant)\n' +
            p + ' debug - View store contents\n' +
            p + ' complete <target> - Remove bounty by name';

        invoker.chat(helpMsg);
    }

    // ===== BOUNTY OPERATIONS =====
    function handlePlaceBounty(parts, ev) {
        var invoker = ev.client;

        if (parts.length < 2) {
            invoker.chat('Usage: !bounty add <playername> <gold_amount> [reason]');
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

        if (reason.length > maxReasonLength) {
            invoker.chat('Reason too long (max ' + maxReasonLength + ' chars)');
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
            claimedAt: null,
            evidenceConfirmed: false,
            evidenceConfirmedBy: null,
            evidenceConfirmedAt: null
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
        var foundBounties = [];

        // Find ALL bounties with exact target name match (multiple posters can bounty same target)
        for (var i = 0; i < bountyBoard.length; i++) {
            if (equalsIgnoreCase(bountyBoard[i].target, targetName)) {
                foundBounties.push(bountyBoard[i]);
            }
        }

        if (foundBounties.length === 0) {
            invoker.chat('[BountyHunter] Bounty not found: ' + targetName);
            return;
        }

        // Check each bounty for claim conflicts
        for (var j = 0; j < foundBounties.length; j++) {
            var foundBounty = foundBounties[j];

            // Check if already fully claimed by someone else
            if (foundBounty.claimPending && foundBounty.claimedBy && !equalsIgnoreCase(foundBounty.claimedBy, invoker.name())) {
                invoker.chat('[BountyHunter] Bounty already claim pending by ' + foundBounty.claimedBy + ': ' + foundBounty.target);
                return;
            }

            // Check if this user already claimed this specific bounty
            if (foundBounty.claimPending && equalsIgnoreCase(foundBounty.claimedBy, invoker.name())) {
                invoker.chat('[BountyHunter] You already have a pending claim on ' + foundBounty.target);
                return;
            }
        }

        // Claim ALL matching bounties that the invoker did not post
        var claimableBounties = [];
        for (var k = 0; k < foundBounties.length; k++) {
            var fb = foundBounties[k];
            if (!equalsIgnoreCase(fb.postedBy, invoker.name())) {
                claimableBounties.push(fb);
            }
        }

        if (claimableBounties.length === 0) {
            invoker.chat('[BountyHunter] You cannot claim your own bounty');
            return;
        }

        for (var k = 0; k < claimableBounties.length; k++) {
            var fb = claimableBounties[k];
            fb.claimPending = true;
            fb.claimedBy = invoker.name();
            fb.claimedAt = new Date().toISOString();

            // Assign file access group to poster if display channel available
            if (displayChannel && fb.postedBy && !equalsIgnoreCase(fb.postedBy, invoker.name())) {
                try {
                    var allClients = backend.getClients();
                    var posterClients = searchClients(fb.postedBy, false, false, allClients);
                    if (posterClients.length > 0) {
                        var client = posterClients[0];
                        var channelGroups = backend.getChannelGroups();
                        var fileAccessGroup = null;
                        for (var gi = 0; gi < channelGroups.length; gi++) {
                            if (String(channelGroups[gi].id()) === fileAccessGroupId) {
                                fileAccessGroup = channelGroups[gi];
                                break;
                            }
                        }
                        if (fileAccessGroup) {
                            var posterOrigGroup = client.getChannelGroup();
                            fb.posterOriginalGroupId = posterOrigGroup ? posterOrigGroup.id() : null;
                            if (persistenceInitialized) {
                                saveData();
                            }
                            displayChannel.setChannelGroup(client, fileAccessGroup);
                            logMessage('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to original poster ' + fb.postedBy + ' for bounty ' + fb.target, 3);
                        }
                    }
                } catch (e) {
                    logMessage('Bounty claim: Failed to assign file access group to original poster ' + fb.postedBy + ': ' + e.message, 2);
                }
            }

            if (persistenceInitialized) {
                saveData();
            }
        }

        // Update the channel description to show CLAIM PENDING status
        updateChannelDescription();

        // Poke claimant with evidence submission instructions
        try {
            invoker.poke('[BountyHunter] Claim pending on ' + targetName + '. Check your DM.');
        } catch (e) {
            logMessage('Bounty claim: Failed to poke claimant ' + invoker.name() + ': ' + e.message, 2);
        }

        // Send full instructions via channel chat
        var dmMessage = '[BountyHunter] Claim instructions for bounty ' + targetName + ': Upload your screenshot or video evidence to the file browser in the bounty board channel (right click the channel > browse files). Use !bounty evidence ' + targetName + ' after uploading.';
        try {
            invoker.chat(dmMessage);
        } catch (e) {
            logMessage('Bounty claim: Failed to send DM instructions to ' + invoker.name() + ': ' + e.message, 2);
        }

        // Grant claimant file access group temporarily
        if (displayChannel) {
            try {
                var channelGroups = backend.getChannelGroups();
                var fileAccessGroup = null;
                for (var ci = 0; ci < channelGroups.length; ci++) {
                    if (String(channelGroups[ci].id()) === fileAccessGroupId) {
                        fileAccessGroup = channelGroups[ci];
                        break;
                    }
                }

                if (fileAccessGroup) {
                    var currentChannelGroup = invoker.getChannelGroup();
                    var originalChannelGroup = currentChannelGroup ? currentChannelGroup.id() : null;
                    for (var fi = 0; fi < foundBounties.length; fi++) {
                        foundBounties[fi].claimantOriginalGroupId = originalChannelGroup;
                    }
                    if (persistenceInitialized) {
                        saveData();
                    }

                    displayChannel.setChannelGroup(invoker, fileAccessGroup);
                    logMessage('Bounty claim: Assigned file access group ' + fileAccessGroupId + ' to claimant ' + invoker.name() + ' for ' + targetName, 3);

                    var timerKey = invoker.name() + ':' + displayChannelId;
                    if (bountyClaimTimers[timerKey]) {
                        clearTimeout(bountyClaimTimers[timerKey]);
                    }

                    bountyClaimTimers[timerKey] = setTimeout(function() {
                        try {
                            if (originalChannelGroup) {
                                displayChannel.setChannelGroup(invoker, backend.getChannelGroupByID(originalChannelGroup));
                            }
                        } catch (e) {
                            logMessage('Bounty claim: Error removing file access group: ' + e.message, 1);
                        }
                        delete bountyClaimTimers[timerKey];

                        for (var ri = 0; ri < foundBounties.length; ri++) {
                            var rBounty = foundBounties[ri];
                            if (rBounty && rBounty.claimPending && equalsIgnoreCase(rBounty.claimedBy, invoker.name())) {
                                rBounty.claimPending = false;
                                if (persistenceInitialized) {
                                    saveData();
                                }
                                updateChannelDescription();
                                logMessage('Bounty claim: Pending status expired for ' + invoker.name() + ' after ' + fileAccessTimerSeconds + ' seconds', 3);
                            }
                        }
                    }, fileAccessTimerSeconds * 1000);

                    invoker.chat('[BountyHunter] File access granted for ' + fileAccessTimerSeconds + ' seconds');
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

        // Only the bounty poster or an admin can complete that specific bounty
        var isOwnerOrAdmin = function(bounty) {
            return equalsIgnoreCase(bounty.postedBy, invokerName) || isAdmin(invoker);
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

        // Only the bounty poster or an admin can remove that specific bounty
        var isOwnerOrAdmin = function(bounty) {
            return equalsIgnoreCase(bounty.postedBy, invokerName) || isAdmin(invoker);
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

    function handleEvidenceUploaded(args, ev) {
        var invoker = ev.client;
        var invokerName = invoker.name();
        var targetName = args.join(' ');

        // Find all bounties with matching target
        var foundBounties = [];
        for (var i = 0; i < bountyBoard.length; i++) {
            if (equalsIgnoreCase(bountyBoard[i].target, targetName)) {
                foundBounties.push(bountyBoard[i]);
            }
        }

        if (foundBounties.length === 0) {
            invoker.chat('[BountyHunter] Bounty not found: ' + targetName);
            return;
        }

        // Verify invoker is the claimant on all matching bounties (or admin)
        for (var j = 0; j < foundBounties.length; j++) {
            var fb = foundBounties[j];
            if (!isAdmin(invoker) && !equalsIgnoreCase(fb.claimedBy, invokerName)) {
                invoker.chat('[BountyHunter] You can only confirm your own pending claim');
                return;
            }
            // Reject if not pending
            if (!fb.claimPending) {
                invoker.chat('[BountyHunter] No pending claim on ' + fb.target);
                return;
            }
            // Reject if already confirmed
            if (fb.evidenceConfirmed) {
                invoker.chat('[BountyHunter] Evidence already uploaded for ' + fb.target);
                return;
            }
        }

        // Mark all matching bounties as evidence confirmed
        for (var k = 0; k < foundBounties.length; k++) {
            var cf = foundBounties[k];
            cf.evidenceConfirmed = true;
            cf.evidenceConfirmedBy = invoker.name();
            cf.evidenceConfirmedAt = new Date().toISOString();
            if (persistenceInitialized) {
                saveData();
            }
        }

        // Notify ALL original posters across all matching bounties.
        // Pokes are short and get clipped, so the poke carries only the
        // crucial info and the full details go out as a chat/DM message.
        var notifiedPosters = [];
        for (var pi = 0; pi < foundBounties.length; pi++) {
            var posterName = foundBounties[pi].postedBy;
            if (posterName && !equalsIgnoreCase(posterName, invoker.name()) && notifiedPosters.indexOf(posterName) === -1) {
                try {
                    var allClients = backend.getClients();
                    var posterClients = searchClients(posterName, false, false, allClients);
                    if (posterClients.length > 0) {
                        var evidenceTarget = foundBounties[pi].target;
                        var claimantName = invoker.name();
                        var pokeMsg = '[BountyHunter] Evidence uploaded: ' + evidenceTarget + ' by ' + claimantName;
                        var dmMsg = '[BountyHunter] Evidence uploaded for bounty "' + evidenceTarget + '" by ' + claimantName + '. Please check the bounty board channel files to review the uploaded evidence. Complete payment with ' + claimantName + ' ingame, then use !bounty complete ' + evidenceTarget + ' to complete the bounty.';
                        var notifiedCount = 0;
                        for (var ci = 0; ci < posterClients.length; ci++) {
                            try {
                                posterClients[ci].poke(pokeMsg);
                                posterClients[ci].chat(dmMsg);
                                notifiedCount++;
                            } catch (e) {
                                logMessage('Bounty evidence: Failed to notify poster client: ' + e.message, 2);
                            }
                        }
                        logMessage('Bounty evidence: Notified ' + notifiedCount + ' poster client(s) for ' + posterName + ' about uploaded evidence on ' + evidenceTarget, 3);
                        notifiedPosters.push(posterName);
                    } else {
                        logMessage('Bounty evidence: Poster ' + posterName + ' is not online; confirmation was recorded', 2);
                    }
                } catch (e) {
                    logMessage('Bounty evidence: Failed to resolve poster ' + posterName + ': ' + e.message, 2);
                }
            }
        }

        updateChannelDescription();
        invoker.chat('[BountyHunter] Evidence uploaded for ' + targetName);
    }

    function handleUnclaim(parts, ev) {
        var invoker = ev.client;
        var invokerName = invoker.name();
        var targetName = parts.join(' ');
        var foundBounty = null;

        // Find the bounty with exact target name match
        for (var i = 0; i < bountyBoard.length; i++) {
            if (equalsIgnoreCase(bountyBoard[i].target, targetName)) {
                foundBounty = bountyBoard[i];
                break;
            }
        }

        if (!foundBounty) {
            invoker.chat('[BountyHunter] Bounty not found: ' + targetName);
            return;
        }

        // Only claimant or admin can unclaim
        if (!isAdmin(invoker) && !equalsIgnoreCase(foundBounty.claimedBy, invokerName)) {
            invoker.chat('[BountyHunter] You can only unclaim your own pending bounties');
            return;
        }

        // Unclaim: reset claim status, clear file-access group, and remove timer
        foundBounty.claimPending = false;
        foundBounty.claimedBy = null;
        foundBounty.claimedAt = null;

        revokeClaimAccess(foundBounty);
        foundBounty.posterOriginalGroupId = null;
        foundBounty.claimantOriginalGroupId = null;
        if (persistenceInitialized) {
            saveData();
        }
        updateChannelDescription();
        invoker.chat('[BountyHunter] Unclaimed: ' + foundBounty.target);
    }

    // ===== DISPLAY FUNCTIONS =====

    function formatGold(gold) {
        var chests = Math.ceil(gold / 500);
        if (chests > 0) {
            return gold + ' gold (' + chests + ' chest' + (chests !== 1 ? 's' : '') + ')';
        }
        return gold + ' gold';
    }

    function truncate(value, maxLength) {
        var text = String(value == null ? '' : value);
        return text.length > maxLength ? text.substring(0, maxLength) : text;
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

            if (b.evidenceConfirmed) {
                bountyList += '   EVIDENCE: Uploaded by ' + b.evidenceConfirmedBy + '\n';
            }
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

    function displayBountyList(ev) {
        var invoker = ev.client;
        var p = '!' + botName;

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
            msg += (i + 1) + '.    ' + truncate(b.target, 17) + '  ' + goldDisplay + '  ' + truncate(b.reason || 'No reason', 40) + ' (by ' + b.postedBy + ')\n';
            if (b.evidenceConfirmed) {
                msg += '       EVIDENCE CONFIRMED by ' + b.evidenceConfirmedBy + '\n';
            }
            if (b.claimPending) {
                msg += '       CLAIM PENDING by ' + b.claimedBy + ' at ' + new Date(b.claimedAt).toLocaleString() + '\n';
            } else if (b.claimedBy) {
                msg += '       CLAIMED by ' + b.claimedBy + ' at ' + new Date(b.claimedAt).toLocaleString() + '\n';
            }
        }
        msg += '\n' + p + ' remove <number> | ' + p + ' remove <target> (admin only)';

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
        out.evidenceConfirmed = !!entry.evidenceConfirmed;
        out.evidenceConfirmedBy = entry.evidenceConfirmedBy || null;
        out.evidenceConfirmedAt = entry.evidenceConfirmedAt || null;

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


    function startAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
        }

        refreshTimer = setInterval(function() {
            updateChannelDescription();
        }, autoRefreshInterval * 1000);
    }
});

// Bounty Hunter Script v2.2.3 for SinusBot
// Complete bounty board system for sea battle guilds
// FIXED: Replaced non-existent private-message API with client.chat()
//       so command responses render in the current channel
// ENHANCED: Added name-based and numeric bounty removal with parsing

registerPlugin({
    name: 'Bounty Hunter',
    version: '2.2.4',
    author: 'Guild Admin',
    description: 'Complete bounty board system with persistent storage',
    backends: ['ts3'],
    vars: [
        { name: 'BOT_NAME', title: 'Bot Command Name', type: 'string', default: 'bounty' },
        { name: 'AUTHORIZED_GROUP', title: 'Server Group ID (authorized to place bounties)', type: 'string', default: '3' },
        { name: 'DISPLAY_CHANNEL_ID', title: 'Channel ID (display bounty board in description)', type: 'string', default: '5' },
        { name: 'BOT_ADMIN_GROUP', title: 'Server Group ID (admin)', type: 'string', default: '2' },
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
    var authorizedGroupId = String(config.AUTHORIZED_GROUP || '3');
    var displayChannelId = String(config.DISPLAY_CHANNEL_ID || '5');
    var botAdminGroupId = String(config.BOT_ADMIN_GROUP || '2');
    var maxBounties = parseInt(config.MAX_ACTIVE_BOUNTIES) || 50;
    var autoRefreshInterval = parseInt(config.AUTO_REFRESH_INTERVAL) || 30;
    var minReward = parseInt(config.MIN_REWARD) || 1;

    // ===== PERSISTENCE =====
    var bountyBoard = [];
    var refreshTimer = null;

    // ===== SCRIPT INITIALIZATION =====
    event.on('load', function(ev) {
        engine.log('Bounty Hunter v2.2.3 loaded');
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
            invoker.chat('[BountyHunter] v2.2.3 test OK — authorized');
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

        // Default: place bounty !bounty <player> <gold> <reason>
        handlePlaceBounty(parts, ev);
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
        saveData();
        sortBounties();
        updateChannelDescription();

        invoker.chat('Bounty placed on ' + playerName + ' for ' + goldAmount + ' gold!');

        var botClient = backend.getBotClient();
        if (botClient) {
            botClient.chat(invoker.name() + ' placed a bounty on ' + playerName + ' for ' + goldAmount + ' gold!');
        }
    }

    function handleRemoveBounty(args, ev) {
        var invoker = ev.client;

        if (!isAdmin(invoker)) {
            invoker.chat('[BountyHunter] Admin only');
            return;
        }

        var searchTerm = args.join(' ');

        // Try numeric ranking first
        if (/^\d+$/.test(searchTerm)) {
            var index = parseInt(searchTerm, 10);
            if (index > 0 && index <= bountyBoard.length) {
                var removed = bountyBoard.splice(index - 1, 1);
                saveData();
                updateChannelDescription();
                invoker.chat('[BountyHunter] Removed: ' + removed[0].target + ' (ranking #' + index + ')');
                return;
            }
        }

        // Try exact target name match
        for (var i = 0; i < bountyBoard.length; i++) {
            if (bountyBoard[i].target.toLowerCase() === searchTerm.toLowerCase()) {
                var removed = bountyBoard.splice(i, 1);
                saveData();
                updateChannelDescription();
                invoker.chat('[BountyHunter] Removed: ' + removed[0].target + ' (matched by name)');
                return;
            }
        }

        // Try prefix name match (e.g. "Ger" for Gerrit)
        for (var i = 0; i < bountyBoard.length; i++) {
            if (bountyBoard[i].target.toLowerCase().indexOf(searchTerm.toLowerCase()) === 0) {
                var removed = bountyBoard.splice(i, 1);
                saveData();
                updateChannelDescription();
                invoker.chat('[BountyHunter] Removed: ' + removed[0].target + ' (matched by name)');
                return;
            }
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
        saveData();
        updateChannelDescription();

        invoker.chat('[BountyHunter] All bounties cleared');
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
            msg += (i + 1) + '.    ' + b.target.padEnd(17) + '  ' + b.gold + '     ' + b.reason.substring(0, 40).padEnd(40) + ' (' + b.postedBy + ')\n';
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
        saveData();
    }

    function saveData() {
        try {
            engine.saveConfig({ ...config, bountyData: JSON.stringify(bountyBoard) });
        } catch (e) {
            engine.log('ERROR saving data: ' + e.message);
        }
    }

    function loadPersistedData() {
        try {
            var rawData = config.bountyData;
            if (rawData) {
                bountyBoard = JSON.parse(rawData);
            } else {
                bountyBoard = [];
            }
        } catch (e) {
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
            bountyList += (i + 1) + '. ' + b.target + ' - ' + b.gold + ' gold' + claimedStatus + '\n';
        }

        if (bountyBoard.length === 0) {
            bountyList = '[center]No active bounties[/center]';
        } else if (bountyBoard.length > 15) {
            bountyList += '... and ' + (bountyBoard.length - 15) + ' more';
        }

        var description = '[center][b][color=#FFD700]BOUNTY BOARD[/color][/b][/center]\n[center]Gold Available: [color=#00FF00]' + totalGold + '[/color][/center]\n' + bountyList + '\n[/center]';

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

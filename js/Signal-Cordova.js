/*global $, Whisper, Backbone, textsecure, extension*/
/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';

    function logError(error) {
        console.log('index.html: ', error);
    }

    window.onerror = function(message, script, line, col, error) {
        logError(error);
    };

    var view;

    function render() {
        ConversationController.updateInbox().then(function() {
            try {
                if (view) { view.remove(); }
                var $body = $('body',document).empty();
                if (Whisper.Registration.everDone()) {
                    view = new Whisper.InboxView({window: window});
                    view.$el.prependTo($body);
                    window.openConversation = function(conversation) {
                        if (conversation) {
                            view.openConversation(null, conversation);
                        }
                    };
                    openConversation(getOpenConversation());
                }else {
                    view = new Whisper.PhoneInputView({window:window});
                    view.$el.prependTo($body);
                }
            } catch (e) {
                logError(e);
            }
        });
    }


    window.addEventListener('onreload', render);
    textsecure.startWorker('js/libsignal-protocol-worker.js');
    storage.fetch();
    storage.onready(function() {
        render();
        window.dispatchEvent(new Event('storage_ready'));
        setUnreadCount(storage.get("unreadCount", 0));

        if (Whisper.Registration.isDone()) {
            init();
        }
        if (Whisper.Registration.everDone()) {
            openInbox();
        }
    });
    var SERVER_URL = 'https://textsecure-service-ca.whispersystems.org';
    var SERVER_PORTS = [80, 4433, 8443];
    var ATTACHMENT_SERVER_URL = 'https://whispersystems-textsecure-attachments.s3.amazonaws.com';
    var messageReceiver;
    window.getSocketStatus = function() {
        if (messageReceiver) {
            return messageReceiver.getStatus();
        } else {
            return -1;
        }
    };


    window.getSyncRequest = function() {
        return new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
    };

    function init(firstRun) {
        window.removeEventListener('online', init);
        if (!Whisper.Registration.isDone()) { return; }

        if (messageReceiver) { messageReceiver.close(); }

        var USERNAME = storage.get('number_id');
        var PASSWORD = storage.get('password');
        var mySignalingKey = storage.get('signaling_key');

        // initialize the socket and start listening for messages
        messageReceiver = new textsecure.MessageReceiver(
            SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD, mySignalingKey, ATTACHMENT_SERVER_URL
        );
        messageReceiver.addEventListener('message', onMessageReceived);
        messageReceiver.addEventListener('receipt', onDeliveryReceipt);
        messageReceiver.addEventListener('contact', onContactReceived);
        messageReceiver.addEventListener('group', onGroupReceived);
        messageReceiver.addEventListener('sent', onSentMessage);
        messageReceiver.addEventListener('read', onReadReceipt);
        messageReceiver.addEventListener('error', onError);

        window.textsecure.messaging = new textsecure.MessageSender(
            SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD, ATTACHMENT_SERVER_URL
        );
        if (firstRun === true && textsecure.storage.user.getDeviceId() != '1') {
            if (!storage.get('theme-setting') && textsecure.storage.get('userAgent') === 'OWI') {
                storage.put('theme-setting', 'ios');
            }
            var syncRequest = new textsecure.SyncRequest(textsecure.messaging, messageReceiver);
            syncRequest.addEventListener('success', function() {
                console.log('sync successful');
                storage.put('synced_at', Date.now());
                window.dispatchEvent(new Event('textsecure:contactsync'));
            });
            syncRequest.addEventListener('timeout', function() {
                console.log('sync timed out');
                window.dispatchEvent(new Event('textsecure:contactsync'));
            });
        }
    }

    function onContactReceived(ev) {
        var contactDetails = ev.contactDetails;
        ConversationController.create({
            name: contactDetails.name,
            id: contactDetails.number,
            avatar: contactDetails.avatar,
            color: contactDetails.color,
            type: 'private',
            active_at: Date.now()
        }).save();
    }

    function onGroupReceived(ev) {
        var groupDetails = ev.groupDetails;
        var attributes = {
            id: groupDetails.id,
            name: groupDetails.name,
            members: groupDetails.members,
            avatar: groupDetails.avatar,
            type: 'group',
        };
        if (groupDetails.active) {
            attributes.active_at = Date.now();
        } else {
            attributes.left = true;
        }
        var conversation = ConversationController.create(attributes);
        conversation.save();
    }

    function onMessageReceived(ev) {
        var data = ev.data;
        var message = initIncomingMessage(data.source, data.timestamp);
        message.handleDataMessage(data.message);
    }

    function onSentMessage(ev) {
        var now = new Date().getTime();
        var data = ev.data;

        var message = new Whisper.Message({
            source         : textsecure.storage.user.getNumber(),
            sent_at        : data.timestamp,
            received_at    : now,
            conversationId : data.destination,
            type           : 'outgoing',
            sent           : true,
            expirationStartTimestamp: data.expirationStartTimestamp,
        });

        message.handleDataMessage(data.message);
    }

    function initIncomingMessage(source, timestamp) {
        var now = new Date().getTime();

        var message = new Whisper.Message({
            source         : source,
            sent_at        : timestamp,
            received_at    : now,
            conversationId : source,
            type           : 'incoming',
            unread         : 1
        });

        return message;
    }

    function onError(ev) {
        var e = ev.error;
        console.log(e);
        console.log(e.stack);

        if (e.name === 'HTTPError' && e.code == -1) {
            // Failed to connect to server
            if (navigator.onLine) {
                console.log('retrying in 1 minute');
                setTimeout(init, 60000);
            } else {
                console.log('offline');
                messageReceiver.close();
                window.addEventListener('online', init);
            }
            return;
        }

        if (ev.proto) {
            if (e.name === 'MessageCounterError') {
                // Ignore this message. It is likely a duplicate delivery
                // because the server lost our ack the first time.
                return;
            }
            var envelope = ev.proto;
            var message = initIncomingMessage(envelope.source, envelope.timestamp.toNumber());
            message.saveErrors(e).then(function() {
                ConversationController.findOrCreatePrivateById(message.get('conversationId')).then(function(conversation) {
                    conversation.set({
                        active_at: Date.now(),
                        unreadCount: conversation.get('unreadCount') + 1
                    });

                    var conversation_timestamp = conversation.get('timestamp');
                    var message_timestamp = message.get('timestamp');
                    if (!conversation_timestamp || message_timestamp > conversation_timestamp) {
                        conversation.set({ timestamp: message.get('sent_at') });
                    }
                    conversation.save();
                    conversation.trigger('newmessage', message);
                    conversation.notify(message);
                });
            });
            return;
        }

        throw e;
    }

    function onReadReceipt(ev) {
        var read_at   = ev.timestamp;
        var timestamp = ev.read.timestamp;
        var sender    = ev.read.sender;
        console.log('read receipt ', sender, timestamp);
        Whisper.ReadReceipts.add({
            sender    : sender,
            timestamp : timestamp,
            read_at   : read_at
        });
    }

    // lazy hack
    window.receipts = new Backbone.Collection();

    function onDeliveryReceipt(ev) {
        var pushMessage = ev.proto;
        var timestamp = pushMessage.timestamp.toNumber();
        console.log(
            'delivery receipt from',
            pushMessage.source + '.' + pushMessage.sourceDevice,
            timestamp
        );

        Whisper.DeliveryReceipts.add({
            timestamp: timestamp, source: pushMessage.source
        });
    }

    window.getAccountManager = function() {
        var USERNAME = storage.get('number_id');
        var PASSWORD = storage.get('password');
        var accountManager = new textsecure.AccountManager(
            SERVER_URL, SERVER_PORTS, USERNAME, PASSWORD
        );
        accountManager.addEventListener('registration', function() {
            if (!Whisper.Registration.everDone()) {
                storage.put('safety-numbers-approval', false);
            }
            init(true);
            Whisper.Registration.markDone();
        });
        return accountManager;
    };



}());

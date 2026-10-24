import test from "node:test";
import assert from "node:assert/strict";

import {
    buildChatReadStatesQuery,
    buildChatUnreadCountQuery,
    isChatFullyRead,
    parseChatReadStates
} from "../src/server/databases/imessage/pollers/IncomingReadEventDetector";

test("treats a chat with no unread incoming messages as read", () => {
    const states = parseChatReadStates([{ guid: "iMessage;-;+15551234567", unread_count: 0 }]);
    assert.deepEqual(states, [{ guid: "iMessage;-;+15551234567", read: true }]);
});

test("treats a chat with unread incoming messages as unread", () => {
    const states = parseChatReadStates([{ guid: "iMessage;-;+15551234567", unread_count: 3 }]);
    assert.deepEqual(states, [{ guid: "iMessage;-;+15551234567", read: false }]);
});

test("treats a null unread tally as read rather than guessing unread", () => {
    const states = parseChatReadStates([{ guid: "iMessage;-;+15551234567", unread_count: null }]);
    assert.deepEqual(states, [{ guid: "iMessage;-;+15551234567", read: true }]);
});

test("skips rows with no chat guid", () => {
    const states = parseChatReadStates([
        { guid: null as unknown as string, unread_count: 2 },
        { guid: "iMessage;-;+15551234567", unread_count: 0 }
    ]);
    assert.deepEqual(states, [{ guid: "iMessage;-;+15551234567", read: true }]);
});

test("emits a mix of read and unread instead of one blanket value", () => {
    const states = parseChatReadStates([
        { guid: "chat-read", unread_count: 0 },
        { guid: "chat-unread", unread_count: 1 },
        { guid: "chat-also-read", unread_count: 0 }
    ]);
    assert.deepEqual(states.map(s => s.read), [true, false, true]);
});

/**
 * The live database had 170 chats holding an `is_read = 0` incoming row but only
 * 2 genuinely unread messages. The difference was entirely system events and
 * tapbacks, which Apple never badges but which keep `is_read = 0` forever.
 * Counting them reported 168 chats as unread that the phone showed as read.
 */
test("counts only real messages as unread, excluding system events and tapbacks", () => {
    const sql = buildChatReadStatesQuery().replace(/\s+/g, " ");
    assert.match(sql, /m\.item_type = 0/, "must exclude system events (item_type != 0)");
    assert.match(
        sql,
        /COALESCE\(m\.associated_message_type, 0\) = 0/,
        "must exclude tapbacks and edits (associated_message_type)"
    );
});

test("decides read state from the unread tally, not from a read timestamp", () => {
    const sql = buildChatReadStatesQuery().replace(/\s+/g, " ");
    assert.match(sql, /AS unread_count/, "must aggregate an unread tally");
    assert.match(sql, /m\.is_from_me = 0/, "must only consider incoming messages");
    assert.doesNotMatch(
        sql,
        /date_read > 0/,
        "must not select chats merely for having a read timestamp -- that marked unread chats as read"
    );
});
/**
 * The forward detector fires when one message's read pointer advances, which is
 * not the same as the chat being read. Emitting an unconditional `read: true`
 * cleared the badge while other messages were still unread, and it also meant
 * the poller and the re-sync endpoint disagreed on what "read" means.
 */
test("reports a chat as fully read when nothing is awaiting a read", async () => {
    const db = { query: async () => [{ chat_count: 1, unread_count: 0 }] } as any;
    assert.equal(await isChatFullyRead(db, "iMessage;-;+15551234567"), true);
});

test("reports a chat as not fully read while a message is awaiting a read", async () => {
    const db = { query: async () => [{ chat_count: 1, unread_count: 2 }] } as any;
    assert.equal(await isChatFullyRead(db, "iMessage;-;+15551234567"), false);
});

test("does not report a deleted or missing chat as fully read", async () => {
    assert.equal(
        await isChatFullyRead({ query: async () => [{ chat_count: 0, unread_count: null }] } as any, "chat"),
        false
    );
    assert.equal(await isChatFullyRead({ query: async () => [] } as any, "chat"), false);
});

test("scopes the unread count to the requested chat via a bound parameter", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const db = {
        query: async (sql: string, params: unknown[]) => {
            calls.push([sql, params]);
            return [{ unread_count: 0 }];
        }
    } as any;

    await isChatFullyRead(db, "iMessage;-;+15551234567");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ["iMessage;-;+15551234567"]);
    assert.match(calls[0][0].replace(/\s+/g, " "), /c\.guid = \?/);
});

test("the per-chat unread query uses the same exclusions as the snapshot query", () => {
    const perChat = buildChatUnreadCountQuery().replace(/\s+/g, " ");
    const snapshot = buildChatReadStatesQuery().replace(/\s+/g, " ");

    for (const clause of [
        "m.is_from_me = 0",
        "m.item_type = 0",
        "COALESCE(m.associated_message_type, 0) = 0"
    ]) {
        assert.ok(perChat.includes(clause), `per-chat query must include ${clause}`);
        assert.ok(snapshot.includes(clause), `snapshot query must include ${clause}`);
    }
});

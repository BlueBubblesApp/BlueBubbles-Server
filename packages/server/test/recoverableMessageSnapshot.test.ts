import assert from "node:assert/strict";
import test from "node:test";

import {
    buildRecoverableMessageSnapshot,
    parseRecoverableMessageRows,
    supportsRecoverableMessages,
    type RecoverableMessageEntry,
    type RecoverableMessageRow
} from "../src/server/databases/imessage/snapshot/RecoverableMessageSnapshot";

function row(overrides: Partial<RecoverableMessageRow> = {}): RecoverableMessageRow {
    return { chat_guid: "chat-a", message_guid: "msg-1", chat_has_messages: 1, ...overrides };
}

test("Recently Deleted requires Ventura or later", () => {
    assert.equal(supportsRecoverableMessages(true), true);
    assert.equal(supportsRecoverableMessages(false), false);
});

test("a recoverable row parses into a deleted message entry", () => {
    assert.deepEqual(parseRecoverableMessageRows([row()]), [
        { chatGuid: "chat-a", messageGuid: "msg-1", chatHasMessages: true }
    ]);
});

test("a chat with no surviving messages is marked as such", () => {
    assert.deepEqual(parseRecoverableMessageRows([row({ chat_has_messages: 0 })]), [
        { chatGuid: "chat-a", messageGuid: "msg-1", chatHasMessages: false }
    ]);
});

test("the same message seen through two chat rows collapses once", () => {
    const parsed = parseRecoverableMessageRows([
        row({ chat_has_messages: 0 }),
        row({ chat_guid: "chat-b", chat_has_messages: 1 })
    ]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].chatHasMessages, true);
});

test("rows missing a GUID are skipped rather than failing the poll", () => {
    assert.deepEqual(parseRecoverableMessageRows([{ chat_guid: null, message_guid: null } as any]), []);
});

test("a malformed existence flag is rejected", () => {
    assert.throws(() => parseRecoverableMessageRows([row({ chat_has_messages: 7 })]), /existence flag/);
});

test("an empty chat GUID is rejected rather than silently grouped", () => {
    assert.throws(() => parseRecoverableMessageRows([row({ chat_guid: "" })]), /chat GUID/);
});

test("the snapshot groups deleted messages by chat and sorts them", () => {
    const entries: RecoverableMessageEntry[] = [
        { chatGuid: "chat-b", messageGuid: "m2", chatHasMessages: true },
        { chatGuid: "chat-a", messageGuid: "m3", chatHasMessages: true },
        { chatGuid: "chat-a", messageGuid: "m1", chatHasMessages: true }
    ];

    assert.deepEqual(buildRecoverableMessageSnapshot(entries, 42), {
        schemaVersion: 1,
        complete: true,
        generatedAt: 42,
        chats: [
            { guid: "chat-a", deletedMessageGuids: ["m1", "m3"] },
            { guid: "chat-b", deletedMessageGuids: ["m2"] }
        ]
    });
});

test("an empty Recently Deleted folder is still a complete snapshot", () => {
    assert.deepEqual(buildRecoverableMessageSnapshot([], 7), {
        schemaVersion: 1,
        complete: true,
        generatedAt: 7,
        chats: []
    });
});

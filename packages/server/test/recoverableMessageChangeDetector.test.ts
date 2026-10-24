import assert from "node:assert/strict";
import test from "node:test";

import { RecoverableMessageChangeDetector } from "../src/server/databases/imessage/pollers/RecoverableMessageChangeDetector";
import type { RecoverableMessageEntry } from "../src/server/databases/imessage/snapshot/RecoverableMessageSnapshot";

function entry(messageGuid: string, overrides: Partial<RecoverableMessageEntry> = {}): RecoverableMessageEntry {
    return { chatGuid: "chat-a", messageGuid, chatHasMessages: true, ...overrides };
}

const present = async () => true;

test("seeding an existing Recently Deleted folder emits nothing", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([entry("m1"), entry("m2")]);

    assert.deepEqual(await detector.observe([entry("m1"), entry("m2")], present), []);
});

test("a message entering Recently Deleted is reported deleted", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    assert.deepEqual(await detector.observe([entry("m1")], present), [
        { chatGuid: "chat-a", messageGuid: "m1", deleted: true }
    ]);
});

test("a message leaving Recently Deleted is reported restored", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([entry("m1")]);

    assert.deepEqual(await detector.observe([], present), [{ chatGuid: "chat-a", messageGuid: "m1", restored: true }]);
});

test("a permanently deleted message is not reported as restored", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([entry("m1")]);

    assert.deepEqual(await detector.observe([], async () => false), []);
});

test("a whole-chat delete does not emit a per-message storm", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    const wholeChat = ["m1", "m2", "m3", "m4"].map(guid => entry(guid, { chatHasMessages: false }));
    assert.deepEqual(await detector.observe(wholeChat, present), []);
});

test("a single delete in a chat that still has messages is reported", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    assert.deepEqual(await detector.observe([entry("m1", { chatHasMessages: false }), entry("m2")], present), [
        { chatGuid: "chat-a", messageGuid: "m2", deleted: true }
    ]);
});

test("an unchanged folder never queries the message table", async () => {
    const detector = new RecoverableMessageChangeDetector();
    let lookups = 0;
    detector.seed([entry("m1")]);

    assert.deepEqual(
        await detector.observe([entry("m1")], async () => {
            lookups++;
            return true;
        }),
        []
    );
    assert.equal(lookups, 0);
});

test("a deletion is reported once, not on every later poll", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    assert.equal((await detector.observe([entry("m1")], present)).length, 1);
    assert.deepEqual(await detector.observe([entry("m1")], present), []);
});

test("delete then restore round-trips", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    assert.deepEqual(await detector.observe([entry("m1")], present), [
        { chatGuid: "chat-a", messageGuid: "m1", deleted: true }
    ]);
    assert.deepEqual(await detector.observe([], present), [{ chatGuid: "chat-a", messageGuid: "m1", restored: true }]);
});

test("re-seeding after a restart suppresses the backlog", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);
    await detector.observe([entry("m1")], present);

    const afterRestart = new RecoverableMessageChangeDetector();
    afterRestart.seed([entry("m1")]);
    assert.deepEqual(await afterRestart.observe([entry("m1")], present), []);
});

test("the message GUID carries the chat it was deleted from", async () => {
    const detector = new RecoverableMessageChangeDetector();
    detector.seed([]);

    assert.deepEqual(await detector.observe([entry("m1", { chatGuid: "chat-z" })], present), [
        { chatGuid: "chat-z", messageGuid: "m1", deleted: true }
    ]);
});

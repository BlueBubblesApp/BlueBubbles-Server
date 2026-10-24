import assert from "node:assert/strict";
import test from "node:test";

import { ChatStateChangeDetector } from "../src/server/databases/imessage/pollers/ChatStateChangeDetector";
import type { ChatTransitionEntry } from "../src/server/databases/imessage/snapshot/ChatStateSnapshot";

function entry(guid: string, overrides: Partial<ChatTransitionEntry> = {}): ChatTransitionEntry {
    return {
        guid,
        read: true,
        messageCount: 1,
        readPointer: "100",
        sourceRowIds: [guid],
        ...overrides
    };
}

test("seed suppresses history", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([entry("a", { readPointer: "900719925474099301" })]);
    assert.deepEqual(
        await detector.observe([entry("a", { readPointer: "900719925474099301" })], async () => true),
        []
    );
});

test("pointer regression emits unread without querying message rows", async () => {
    const detector = new ChatStateChangeDetector();
    let readChecks = 0;
    detector.seed([entry("a", { readPointer: "900719925474099399" })]);

    assert.deepEqual(
        await detector.observe([entry("a", { readPointer: "900719925474099301" })], async () => {
            readChecks++;
            return true;
        }),
        [{ guid: "a", read: false }]
    );
    assert.equal(readChecks, 0);
});

test("duplicate-row disappearance does not emit a false unread transition", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([
        entry("dup", { readPointer: "200", sourceRowIds: ["1", "2"] })
    ]);

    assert.deepEqual(
        await detector.observe(
            [entry("dup", { readPointer: "100", sourceRowIds: ["1"] })],
            async () => true
        ),
        []
    );
});

test("incoming message read emits read when the chat pointer is unchanged", async () => {
    const detector = new ChatStateChangeDetector();
    let targetedChecks = 0;

    detector.seed([entry("a", { read: false, readPointer: "100" })]);

    assert.deepEqual(
        await detector.observe([entry("a", { read: true, readPointer: "100" })], async () => {
            targetedChecks++;
            return true;
        }),
        [{ guid: "a", read: true }]
    );
    assert.equal(targetedChecks, 0);
});

test("incoming unread state emits unread when the chat pointer is unchanged", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([entry("a", { read: true, readPointer: "100" })]);

    assert.deepEqual(
        await detector.observe([entry("a", { read: false, readPointer: "100" })], async () => true),
        [{ guid: "a", read: false }]
    );
});

test("pointer advance emits read only after the targeted unread query confirms it", async () => {
    const detector = new ChatStateChangeDetector();
    const checked: string[] = [];
    detector.seed([entry("a", { readPointer: "100" })]);

    assert.deepEqual(
        await detector.observe([entry("a", { readPointer: "101" })], async guid => {
            checked.push(guid);
            return true;
        }),
        [{ guid: "a", read: true }]
    );
    assert.deepEqual(checked, ["a"]);
});

test("pointer advance cannot clear a badge while unread messages remain", async () => {
    const detector = new ChatStateChangeDetector();
    let targetedChecks = 0;
    detector.seed([entry("a", { read: false, readPointer: "100" })]);

    assert.deepEqual(
        await detector.observe([entry("a", { read: false, readPointer: "101" })], async () => {
            targetedChecks++;
            return false;
        }),
        []
    );
    assert.equal(targetedChecks, 0);
});

test("unchanged chats do not query unread message rows", async () => {
    const detector = new ChatStateChangeDetector();
    let readChecks = 0;
    detector.seed([entry("a")]);

    assert.deepEqual(
        await detector.observe([entry("a")], async () => {
            readChecks++;
            return true;
        }),
        []
    );
    assert.equal(readChecks, 0);
});

test("whole-chat deletion wins over read-pointer changes", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([entry("a", { messageCount: 2, readPointer: "100" })]);
    assert.deepEqual(
        await detector.observe([entry("a", { messageCount: 0, readPointer: "101" })], async () => true),
        [{ guid: "a", deleted: true }]
    );
});

test("absent previously non-empty chat emits deletion once", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([entry("a", { messageCount: 5 })]);
    assert.deepEqual(await detector.observe([], async () => true), [{ guid: "a", deleted: true }]);
    assert.deepEqual(await detector.observe([], async () => true), []);
});

test("chat empty from seed never deletes", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([entry("a", { messageCount: 0 })]);
    assert.deepEqual(await detector.observe([], async () => true), []);
});

test("newly appearing chat seeds silently", async () => {
    const detector = new ChatStateChangeDetector();
    detector.seed([]);
    assert.deepEqual(
        await detector.observe([entry("new", { messageCount: 3, readPointer: "400" })], async () => true),
        []
    );
});

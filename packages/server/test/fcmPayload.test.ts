import assert from "node:assert/strict";
import test from "node:test";

import {
    boundFcmDataPayload,
    FCM_MAX_DATA_BYTES,
    fcmDataPayloadBytes,
    type FcmDataPayload
} from "../src/server/services/fcmService/FcmPayload";

function envelope(type: string, data: unknown): FcmDataPayload {
    return { type, data: JSON.stringify(data) };
}

function decode(payload: FcmDataPayload): Record<string, any> {
    return JSON.parse(payload.data);
}

test("counts the final escaped FCM data envelope in UTF-8 bytes", () => {
    const payload = envelope("new-message", { text: '🙂"\\\n'.repeat(300) });

    assert.equal(fcmDataPayloadBytes(payload), Buffer.byteLength(JSON.stringify(payload), "utf8"));
    assert.ok(Buffer.byteLength(payload.data, "utf8") < FCM_MAX_DATA_BYTES);
    assert.ok(fcmDataPayloadBytes(payload) > FCM_MAX_DATA_BYTES);
});

test("accepts an envelope exactly at the 4096-byte boundary", () => {
    const prefix = envelope("event", { text: "" });
    const fixedBytes = fcmDataPayloadBytes(prefix);
    const payload = envelope("event", { text: "x".repeat(FCM_MAX_DATA_BYTES - fixedBytes) });

    assert.equal(fcmDataPayloadBytes(payload), FCM_MAX_DATA_BYTES);
    assert.deepEqual(boundFcmDataPayload(payload), payload);
});

test("compacts an oversized group message without changing canonical text or routing identifiers", () => {
    const message = {
        guid: "message-guid",
        text: "Preserve the complete canonical message",
        dateCreated: 123456789,
        isFromMe: false,
        itemType: 0,
        chats: [
            {
                guid: "iMessage;+;chat-guid",
                displayName: "Large group",
                participants: Array.from({ length: 70 }, (_, i) => ({
                    originalROWID: i,
                    address: `person-${i}-${"界".repeat(18)}@example.com`,
                    service: "iMessage"
                }))
            }
        ]
    };
    const payload = envelope("new-message", message);

    assert.ok(fcmDataPayloadBytes(payload) > FCM_MAX_DATA_BYTES);
    const bounded = boundFcmDataPayload(payload);

    assert.ok(bounded);
    assert.ok(fcmDataPayloadBytes(bounded!) <= FCM_MAX_DATA_BYTES);
    const result = decode(bounded!);
    assert.equal(result.guid, message.guid);
    assert.equal(result.text, message.text);
    assert.equal(result.chats[0].guid, message.chats[0].guid);
    assert.deepEqual(result.chats[0].participants, []);
    assert.equal(bounded!.type, "new-message");
});

test("clears participants before trimming later optional high-volume fields", () => {
    const message = {
        guid: "message-guid",
        text: "hello",
        chats: [{ guid: "chat-guid", participants: [{ address: "x".repeat(4200) }] }],
        payloadData: { retainedWhenParticipantsAreEnough: true }
    };

    const bounded = boundFcmDataPayload(envelope("new-message", message));
    const result = decode(bounded!);

    assert.deepEqual(result.chats[0].participants, []);
    assert.deepEqual(result.payloadData, message.payloadData);
});

test("trims optional message payload fields after participants when still oversized", () => {
    const message = {
        guid: "message-guid",
        text: "hello",
        chats: [{ guid: "chat-guid", participants: [] }],
        attributedBody: "a".repeat(4200),
        messageSummaryInfo: "s".repeat(4200),
        payloadData: "p".repeat(4200)
    };

    const bounded = boundFcmDataPayload(envelope("new-message", message));
    const result = decode(bounded!);

    assert.equal(result.guid, message.guid);
    assert.equal(result.text, message.text);
    assert.equal(result.attributedBody, undefined);
    assert.equal(result.messageSummaryInfo, undefined);
    assert.equal(result.payloadData, undefined);
});

test("uses a minimal message fallback that preserves event and fetch identifiers", () => {
    const message = {
        originalROWID: 314,
        guid: "message-guid",
        text: "hello",
        dateCreated: 123456789,
        isFromMe: false,
        itemType: 0,
        chats: [{ originalROWID: 271, guid: "chat-guid", participants: [], displayName: "g".repeat(5000) }],
        subject: "s".repeat(5000),
        handle: { originalROWID: 42, address: "sender@example.com", service: "iMessage", extra: "x".repeat(5000) },
        unknownOptionalField: "u".repeat(5000)
    };

    const bounded = boundFcmDataPayload(envelope("new-message", message));
    const result = decode(bounded!);

    assert.equal(bounded!.type, "new-message");
    assert.equal(result.originalROWID, message.originalROWID);
    assert.equal(result.guid, message.guid);
    assert.equal(result.text, message.text);
    assert.equal(result.chats[0].originalROWID, message.chats[0].originalROWID);
    assert.equal(result.chats[0].guid, message.chats[0].guid);
    assert.equal(result.handle.address, message.handle.address);
    assert.equal(result.unknownOptionalField, undefined);
    assert.ok(fcmDataPayloadBytes(bounded!) <= FCM_MAX_DATA_BYTES);
});

test("preserves valid small primitive, array, object, and chatless update event shapes", () => {
    const payloads = [
        envelope("event", null),
        envelope("event", "value"),
        envelope("event", 42),
        envelope("event", ["array"]),
        envelope("event", { key: "value" }),
        envelope("updated-message", { guid: "message-guid", text: "updated" })
    ];

    for (const payload of payloads) {
        assert.deepEqual(boundFcmDataPayload(payload), payload);
    }
});

test("fails safe for invalid shapes and impossible lossless message payloads", () => {
    const invalidPayloads: unknown[] = [
        undefined,
        null,
        [],
        { type: "", data: "{}" },
        { type: "event", data: undefined },
        { type: "event", data: "not-json" },
        { type: "new-message", data: JSON.stringify(["array"]) }
    ];

    for (const payload of invalidPayloads) {
        assert.equal(boundFcmDataPayload(payload), null);
    }

    const impossible = envelope("new-message", {
        guid: "message-guid",
        text: "🙂".repeat(2000),
        chats: [{ guid: "chat-guid", participants: [] }]
    });
    assert.equal(boundFcmDataPayload(impossible), null, "canonical text must never be truncated");
});

test("never mutates the source envelope or its serialized canonical object", () => {
    const message = {
        guid: "message-guid",
        text: "hello",
        chats: [{ guid: "chat-guid", participants: [{ address: "x".repeat(4200) }] }]
    };
    const payload = envelope("new-message", message);
    const before = structuredClone(payload);

    boundFcmDataPayload(payload);

    assert.deepEqual(payload, before);
    assert.deepEqual(message.chats[0].participants, [{ address: "x".repeat(4200) }]);
});

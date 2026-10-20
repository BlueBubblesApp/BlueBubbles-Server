import assert from "node:assert/strict";
import test from "node:test";

import {
    boundFcmDataPayload,
    FCM_MAX_DATA_BYTES,
    fcmDataKeyValueBytes,
    fcmDataPayloadBytes,
    type FcmDataPayload
} from "../src/server/services/fcmService/FcmPayload";

function envelope(type: string, data: unknown): FcmDataPayload {
    return { type, data: JSON.stringify(data) };
}

function decode(payload: FcmDataPayload): Record<string, any> {
    return JSON.parse(payload.data);
}

function message(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        originalROWID: 314,
        guid: "message-guid",
        text: "hello",
        subject: null,
        dateCreated: 123456789,
        isFromMe: false,
        itemType: 0,
        attachments: [],
        chats: [
            {
                originalROWID: 271,
                guid: "chat-guid",
                style: 43,
                chatIdentifier: "chat-id",
                isArchived: false,
                displayName: "Group name",
                participants: []
            }
        ],
        ...overrides
    };
}

test("counts the final escaped FCM data envelope in UTF-8 bytes", () => {
    const payload = envelope("new-message", message({ text: '🙂"\\\n'.repeat(300) }));

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

test("accepts small valid new-message and chatless updated-message contracts", () => {
    const newMessage = envelope("new-message", message());
    const updatedMessage = envelope("updated-message", message({ chats: undefined }));

    assert.deepEqual(boundFcmDataPayload(newMessage), newMessage);
    assert.deepEqual(boundFcmDataPayload(updatedMessage), updatedMessage);
});

test("accepts the serializer's null dateCreated", () => {
    const payload = envelope("new-message", message({ dateCreated: null }));

    assert.deepEqual(boundFcmDataPayload(payload), payload);
});

test("rejects small known message events missing their minimum client contract", () => {
    const invalid = [
        envelope("new-message", { guid: "m" }),
        envelope("new-message", { guid: "m", text: "body", chats: [] }),
        envelope("updated-message", { guid: "m" }),
        envelope("new-message", message({ subject: undefined })),
        envelope("new-message", message({ text: undefined })),
        envelope("new-message", message({ dateCreated: undefined })),
        envelope("new-message", message({ isFromMe: undefined })),
        envelope("new-message", message({ itemType: undefined })),
        envelope("new-message", message({ attachments: undefined })),
        envelope("new-message", message({ chats: [{ guid: "chat-guid" }] })),
        envelope("new-message", message({ chats: [{ displayName: "Group name" }] })),
        envelope("updated-message", message({ chats: [{ guid: "chat-guid" }] }))
    ];

    for (const payload of invalid) assert.equal(boundFcmDataPayload(payload), null);
});

test("requires routing chats for every new and group message event, but not updated-message", () => {
    const routingEvents = [
        "new-message",
        "group-name-change",
        "participant-removed",
        "participant-added",
        "participant-left",
        "group-icon-changed",
        "group-icon-removed"
    ];

    for (const type of routingEvents) {
        assert.equal(boundFcmDataPayload(envelope(type, message({ chats: [] }))), null, type);
    }
    assert.ok(boundFcmDataPayload(envelope("updated-message", message({ chats: undefined }))));
});

test("compacts an oversized group message without changing canonical presentation, routing, or dimensions", () => {
    const source = message({
        text: "Preserve the complete canonical message",
        subject: "Preserve the complete subject",
        chats: [
            {
                ...message().chats[0],
                displayName: "Large group",
                participants: Array.from({ length: 70 }, (_, i) => ({
                    originalROWID: i,
                    address: `person-${i}-${"界".repeat(18)}@example.com`,
                    service: "iMessage"
                }))
            }
        ],
        attachments: [
            {
                originalROWID: 7,
                guid: "attachment-guid",
                mimeType: "image/jpeg",
                uti: "public.jpeg",
                transferName: "photo.jpg",
                totalBytes: 1234,
                height: 1080,
                width: 1920,
                metadata: { padding: "x".repeat(4200) }
            }
        ]
    });
    const payload = envelope("new-message", source);

    assert.ok(fcmDataPayloadBytes(payload) > FCM_MAX_DATA_BYTES);
    const bounded = boundFcmDataPayload(payload);

    assert.ok(bounded);
    assert.ok(fcmDataPayloadBytes(bounded!) <= FCM_MAX_DATA_BYTES);
    const result = decode(bounded!);
    assert.equal(result.text, source.text);
    assert.equal(result.subject, source.subject);
    assert.equal(result.chats[0].guid, source.chats[0].guid);
    assert.equal(result.chats[0].displayName, source.chats[0].displayName);
    assert.equal(result.attachments[0].height, source.attachments[0].height);
    assert.equal(result.attachments[0].width, source.attachments[0].width);
    assert.deepEqual(result.chats[0].participants, []);
});

test("compacts a valid oversized chatless updated-message", () => {
    const source = message({
        chats: undefined,
        subject: "Updated subject",
        attachments: [{ guid: "attachment-guid", height: 300, width: 400, metadata: "x".repeat(5000) }]
    });
    const bounded = boundFcmDataPayload(envelope("updated-message", source));

    assert.ok(bounded);
    const result = decode(bounded!);
    assert.equal(result.subject, source.subject);
    assert.equal(result.chats, undefined);
    assert.equal(result.attachments[0].height, 300);
    assert.equal(result.attachments[0].width, 400);
});

test("clears participants before trimming later optional high-volume fields", () => {
    const source = message({
        chats: [{ ...message().chats[0], participants: [{ address: "x".repeat(4200) }] }],
        payloadData: { retainedWhenParticipantsAreEnough: true }
    });

    const result = decode(boundFcmDataPayload(envelope("new-message", source))!);
    assert.deepEqual(result.chats[0].participants, []);
    assert.deepEqual(result.payloadData, source.payloadData);
});

test("trims optional message payload fields after participants when still oversized", () => {
    const source = message({
        attributedBody: "a".repeat(4200),
        messageSummaryInfo: "s".repeat(4200),
        payloadData: "p".repeat(4200)
    });

    const result = decode(boundFcmDataPayload(envelope("new-message", source))!);
    assert.equal(result.guid, source.guid);
    assert.equal(result.text, source.text);
    assert.equal(result.attributedBody, undefined);
    assert.equal(result.messageSummaryInfo, undefined);
    assert.equal(result.payloadData, undefined);
});

test("minimal fallback preserves canonical subject and group displayName", () => {
    const source = message({
        subject: "Important subject",
        chats: [{ ...message().chats[0], displayName: "Family group", participants: [] }],
        handle: { originalROWID: 42, address: "sender@example.com", service: "iMessage", extra: "x".repeat(5000) },
        unknownOptionalField: "u".repeat(5000)
    });

    const bounded = boundFcmDataPayload(envelope("new-message", source));
    const result = decode(bounded!);

    assert.equal(result.subject, source.subject);
    assert.equal(result.chats[0].displayName, source.chats[0].displayName);
    assert.equal(result.handle.address, source.handle.address);
    assert.equal(result.unknownOptionalField, undefined);
    assert.ok(fcmDataPayloadBytes(bounded!) <= FCM_MAX_DATA_BYTES);
});

test("fails safe when complete text or subject semantics cannot fit", () => {
    const cases = [
        envelope("new-message", message({ text: "🙂".repeat(2000) })),
        envelope("new-message", message({ subject: "🙂".repeat(2000) })),
        envelope("updated-message", message({ chats: undefined, text: "🙂".repeat(2000) })),
        envelope("updated-message", message({ chats: undefined, subject: "🙂".repeat(2000) }))
    ];

    for (const payload of cases) assert.equal(boundFcmDataPayload(payload), null);
});

test("sends the minimal form when only JSON re-escaping exceeds the conservative bound", () => {
    // Each newline is two bytes in Firebase's key+value accounting but three
    // bytes once the envelope itself is JSON-encoded.
    const source = message({ text: "\n".repeat(1400), tempGuid: "temp-guid" });
    const payload = envelope("new-message", source);

    assert.ok(fcmDataPayloadBytes(payload) > FCM_MAX_DATA_BYTES);
    assert.ok(fcmDataKeyValueBytes(payload) <= FCM_MAX_DATA_BYTES);
    const bounded = boundFcmDataPayload(payload);

    assert.ok(bounded);
    assert.ok(fcmDataKeyValueBytes(bounded!) <= FCM_MAX_DATA_BYTES);
    const result = decode(bounded!);
    assert.equal(result.text, source.text);
    assert.equal(result.tempGuid, source.tempGuid);
});

test("passes unknown events that fit Firebase's key+value accounting", () => {
    const payload = envelope("event", { note: "\n".repeat(1400) });

    assert.ok(fcmDataPayloadBytes(payload) > FCM_MAX_DATA_BYTES);
    assert.deepEqual(boundFcmDataPayload(payload), payload);
});

test("minimal fallback keeps every field the client reads before fetching more", () => {
    const source = message({
        tempGuid: "temp-guid",
        isFromMe: true,
        itemType: 0,
        dateCreated: 987654321,
        attachments: [
            { guid: "attachment-guid", mimeType: "image/png", transferName: "a.png", height: 1, width: 2 }
        ],
        unknownOptionalField: "u".repeat(5000)
    });

    const result = decode(boundFcmDataPayload(envelope("new-message", source))!);

    assert.equal(result.unknownOptionalField, undefined);
    for (const field of ["guid", "tempGuid", "text", "subject", "dateCreated", "isFromMe", "itemType"]) {
        assert.deepEqual(result[field], source[field], field);
    }
    assert.deepEqual(result.attachments, source.attachments);
    for (const field of ["guid", "style", "chatIdentifier", "displayName"]) {
        assert.equal(result.chats[0][field], source.chats[0][field], field);
    }
});

test("preserves valid small unknown event shapes", () => {
    const payloads = [
        envelope("event", null),
        envelope("event", "value"),
        envelope("event", 42),
        envelope("event", ["array"]),
        envelope("event", { key: "value" })
    ];

    for (const payload of payloads) assert.deepEqual(boundFcmDataPayload(payload), payload);
});

test("fails safe for invalid envelopes and unknown oversized shapes", () => {
    const invalidPayloads: unknown[] = [
        undefined,
        null,
        [],
        { type: "", data: "{}" },
        { type: "event", data: undefined },
        { type: "event", data: "not-json" },
        { type: "new-message", data: JSON.stringify(["array"]) },
        envelope("event", { data: "x".repeat(5000) })
    ];

    for (const payload of invalidPayloads) assert.equal(boundFcmDataPayload(payload), null);
});

test("never mutates source envelopes or canonical objects", () => {
    const source = message({
        chats: [{ ...message().chats[0], participants: [{ address: "x".repeat(4200) }] }],
        attachments: [{ guid: "attachment-guid", height: 10, width: 20, metadata: "x".repeat(4200) }]
    });
    const payload = envelope("new-message", source);
    const beforePayload = structuredClone(payload);
    const beforeSource = structuredClone(source);

    boundFcmDataPayload(payload);

    assert.deepEqual(payload, beforePayload);
    assert.deepEqual(source, beforeSource);
});

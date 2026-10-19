export interface FcmDataPayload {
    [key: string]: string;
    type: string;
    data: string;
}

/** FCM's documented limit for a data message, including every data key and value. */
export const FCM_MAX_DATA_BYTES = 4096;

const MESSAGE_EVENT_TYPES = new Set([
    "new-message",
    "updated-message",
    "group-name-change",
    "participant-removed",
    "participant-added",
    "participant-left",
    "group-icon-changed",
    "group-icon-removed"
]);

const OPTIONAL_MESSAGE_PAYLOAD_FIELDS = ["attributedBody", "messageSummaryInfo", "payloadData", "metadata"];
const MINIMAL_MESSAGE_FIELDS = [
    "originalROWID",
    "guid",
    "tempGuid",
    "text",
    "dateCreated",
    "dateRead",
    "dateDelivered",
    "dateEdited",
    "dateRetracted",
    "isDelivered",
    "isFromMe",
    "hasDdResults",
    "isArchived",
    "itemType",
    "error",
    "handleId",
    "otherHandle",
    "handle",
    "chats",
    "attachments",
    "groupTitle",
    "groupActionType",
    "balloonBundleId",
    "associatedMessageGuid",
    "associatedMessageType",
    "expressiveSendStyleId",
    "threadOriginatorGuid",
    "replyToGuid",
    "hasPayloadData",
    "partCount",
    "wasDeliveredQuietly",
    "didNotifyRecipient"
];

export function fcmDataPayloadBytes(payload: FcmDataPayload): number {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFcmDataPayload(value: unknown): value is FcmDataPayload {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    return (
        keys.length === 2 &&
        keys.includes("type") &&
        keys.includes("data") &&
        typeof value.type === "string" &&
        value.type.length > 0 &&
        typeof value.data === "string"
    );
}

function encode(type: string, data: unknown): FcmDataPayload {
    return { type, data: JSON.stringify(data) };
}

function fits(payload: FcmDataPayload): boolean {
    return fcmDataPayloadBytes(payload) <= FCM_MAX_DATA_BYTES;
}

function isMessagePayload(data: unknown): data is Record<string, any> {
    return isRecord(data) && typeof data.guid === "string" && data.guid.length > 0;
}

function hasRoutingChats(message: Record<string, any>): boolean {
    return (
        Array.isArray(message.chats) &&
        message.chats.length > 0 &&
        message.chats.every(chat => isRecord(chat) && typeof chat.guid === "string" && chat.guid.length > 0)
    );
}

function clearParticipants(message: Record<string, any>): void {
    if (!Array.isArray(message.chats)) return;
    for (const chat of message.chats) {
        if (Array.isArray(chat.participants)) chat.participants = [];
    }
}

function removeOptionalMessagePayloads(message: Record<string, any>): void {
    for (const field of OPTIONAL_MESSAGE_PAYLOAD_FIELDS) delete message[field];
}

function removeOptionalAttachmentPayloads(message: Record<string, any>): void {
    if (!Array.isArray(message.attachments)) return;
    for (const attachment of message.attachments) {
        if (!isRecord(attachment)) continue;
        delete attachment.data;
        delete attachment.blurhash;
        delete attachment.metadata;
    }
}

function pick(source: Record<string, any>, fields: string[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
    }
    return result;
}

function minimalChat(chat: Record<string, any>): Record<string, any> {
    return pick(chat, ["originalROWID", "guid", "style", "chatIdentifier", "isArchived"]);
}

function minimalHandle(handle: unknown): unknown {
    return isRecord(handle)
        ? pick(handle, ["originalROWID", "address", "service", "country", "uncanonicalizedId"])
        : handle;
}

function minimalAttachment(attachment: unknown): unknown {
    return isRecord(attachment)
        ? pick(attachment, [
              "originalROWID",
              "guid",
              "mimeType",
              "uti",
              "transferName",
              "totalBytes",
              "isSticker",
              "hideAttachment",
              "originalGuid",
              "hasLivePhoto"
          ])
        : attachment;
}

function minimalMessage(message: Record<string, any>): Record<string, any> {
    const result = pick(message, MINIMAL_MESSAGE_FIELDS);
    if (Array.isArray(message.chats)) result.chats = message.chats.map(minimalChat);
    if (Object.prototype.hasOwnProperty.call(result, "handle")) result.handle = minimalHandle(result.handle);
    if (Array.isArray(result.attachments)) result.attachments = result.attachments.map(minimalAttachment);
    return result;
}

/**
 * Bounds the exact `{type,data}` string map passed to Firebase Admin's `data`
 * field. Firebase documents the 4096-byte limit as covering data keys and
 * values; measuring the JSON form is conservative because it also counts JSON
 * framing and escaping. Unknown oversized event shapes are skipped rather than
 * corrupted. Canonical message text is never truncated.
 */
export function boundFcmDataPayload(value: unknown): FcmDataPayload | null {
    if (!isFcmDataPayload(value)) return null;

    let decoded: unknown;
    try {
        decoded = JSON.parse(value.data);
    } catch (_) {
        return null;
    }

    if (MESSAGE_EVENT_TYPES.has(value.type) && !isMessagePayload(decoded)) return null;
    if (fits(value)) return { ...value };

    // Only known message events have a client-compatible compaction contract.
    if (!MESSAGE_EVENT_TYPES.has(value.type) || !isMessagePayload(decoded)) return null;
    if (value.type !== "updated-message" && !hasRoutingChats(decoded)) return null;

    // JSON.parse above gives us an isolated copy, so socket/webhook source data
    // and the caller's final envelope cannot be mutated by FCM compaction.
    clearParticipants(decoded);
    let candidate = encode(value.type, decoded);
    if (fits(candidate)) return candidate;

    removeOptionalMessagePayloads(decoded);
    candidate = encode(value.type, decoded);
    if (fits(candidate)) return candidate;

    removeOptionalAttachmentPayloads(decoded);
    candidate = encode(value.type, decoded);
    if (fits(candidate)) return candidate;

    candidate = encode(value.type, minimalMessage(decoded));
    return fits(candidate) ? candidate : null;
}

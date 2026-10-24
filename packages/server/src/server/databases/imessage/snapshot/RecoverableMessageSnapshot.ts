import type { DataSource } from "typeorm";

export type RecoverableMessageEntry = {
    chatGuid: string;
    messageGuid: string;
    /** Whether the chat still holds any non-deleted message. */
    chatHasMessages: boolean;
};

export type RecoverableMessageSnapshotResult = {
    schemaVersion: 1;
    chats: { guid: string; deletedMessageGuids: string[] }[];
    complete: boolean;
    generatedAt: number;
};

export type RecoverableMessageRow = {
    chat_guid: string;
    message_guid: string;
    chat_has_messages: number | null;
};

/**
 * Recently Deleted (`chat_recoverable_message_join`) arrived with macOS
 * Ventura. Earlier versions hard-delete, which the whole-chat delete path
 * already covers.
 */
export const supportsRecoverableMessages = (isMinVenturaOrLater: boolean): boolean => isMinVenturaOrLater;

/**
 * Selects every message Apple currently holds in Recently Deleted.
 *
 * The scan is driven by `chat_recoverable_message_join`, which holds only the
 * messages currently pending permanent deletion (111 rows on the author's Mac,
 * against ~2,460 chats). It deliberately does NOT aggregate the message table:
 * an earlier message-GUID fingerprint diff was reverted for exactly that cost.
 *
 * `message.date_retracted` is not consulted. That column marks unsend, which
 * upstream's MessagePoller already reports through `updated-message`.
 *
 * `chat_has_messages` lets the detector tell a single-message delete apart from
 * a whole-conversation delete, which drops every message into Recently Deleted
 * at once and is already reported as one `chat-deleted` event.
 */
export function buildRecoverableMessageQuery(): string {
    return `
        SELECT
            c.guid AS chat_guid,
            m.guid AS message_guid,
            EXISTS(
                SELECT 1
                FROM chat_message_join j
                WHERE j.chat_id = c.ROWID
                LIMIT 1
            ) AS chat_has_messages
        FROM chat_recoverable_message_join r
        JOIN message m ON m.ROWID = r.message_id
        JOIN chat c ON c.ROWID = r.chat_id
    `;
}

/** Indexed existence check for one message, used only for GUIDs leaving the set. */
export function buildMessageExistsQuery(): string {
    return `SELECT 1 AS present FROM message WHERE guid = ? LIMIT 1`;
}

export function parseRecoverableMessageRows(rows: RecoverableMessageRow[]): RecoverableMessageEntry[] {
    const byMessageGuid = new Map<string, RecoverableMessageEntry>();

    for (const row of rows) {
        if (row?.chat_guid == null || row?.message_guid == null) continue;
        if (typeof row.chat_guid !== "string" || row.chat_guid.length === 0) {
            throw new Error("Recoverable message row had an invalid chat GUID");
        }
        if (typeof row.message_guid !== "string" || row.message_guid.length === 0) {
            throw new Error("Recoverable message row had an invalid message GUID");
        }

        const hasMessages = Number(row.chat_has_messages ?? 0);
        if (hasMessages !== 0 && hasMessages !== 1) {
            throw new Error(`Invalid message-existence flag for chat ${row.chat_guid}`);
        }

        // Apple can expose the same message through more than one chat row. The
        // message is hidden on the client either way, so collapsing on the
        // message GUID is safe; a chat that still holds messages wins, so a
        // duplicate never makes a single delete look like a chat deletion.
        const existing = byMessageGuid.get(row.message_guid);
        if (existing) {
            existing.chatHasMessages = existing.chatHasMessages || hasMessages === 1;
            continue;
        }

        byMessageGuid.set(row.message_guid, {
            chatGuid: row.chat_guid,
            messageGuid: row.message_guid,
            chatHasMessages: hasMessages === 1
        });
    }

    return [...byMessageGuid.values()];
}

export async function loadRecoverableMessages(db: DataSource): Promise<RecoverableMessageEntry[]> {
    return parseRecoverableMessageRows(await db.query(buildRecoverableMessageQuery()));
}

export async function isMessagePresent(db: DataSource, messageGuid: string): Promise<boolean> {
    const rows = await db.query(buildMessageExistsQuery(), [messageGuid]);
    return Array.isArray(rows) && rows.length > 0;
}

/**
 * Groups the current Recently Deleted set by chat for the catch-up endpoint.
 *
 * `complete` is what licenses the client to act on absence. It is only true
 * when the whole query succeeded, so a failure can never be read as "nothing
 * is deleted" and un-hide every message the user deleted on Apple.
 */
export function buildRecoverableMessageSnapshot(
    entries: RecoverableMessageEntry[],
    generatedAt: number
): RecoverableMessageSnapshotResult {
    const byChat = new Map<string, Set<string>>();
    for (const entry of entries) {
        const existing = byChat.get(entry.chatGuid);
        if (existing) {
            existing.add(entry.messageGuid);
        } else {
            byChat.set(entry.chatGuid, new Set([entry.messageGuid]));
        }
    }

    const chats = [...byChat.entries()]
        .map(([guid, guids]) => ({ guid, deletedMessageGuids: [...guids].sort() }))
        .sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));

    return { schemaVersion: 1, chats, complete: true, generatedAt };
}

export async function loadRecoverableMessageSnapshot(db: DataSource): Promise<RecoverableMessageSnapshotResult> {
    return buildRecoverableMessageSnapshot(await loadRecoverableMessages(db), Date.now());
}

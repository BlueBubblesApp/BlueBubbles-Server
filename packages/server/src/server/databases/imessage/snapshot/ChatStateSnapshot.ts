import type { DataSource } from "typeorm";

export type ChatSnapshotEntry = {
    guid: string;
    read: boolean;
    isArchived: boolean;
    messageCount: number;
    readPointer: string;
};

export type ChatStateSnapshotResult = {
    schemaVersion: 3;
    chats: ChatSnapshotEntry[];
    complete: boolean;
    generatedAt: number;
};

export type ChatSnapshotRow = {
    guid: string;
    unread_count: number | null;
    is_archived: number | null;
    message_count: number | null;
    read_pointer: string | null;
};

export type ChatTransitionEntry = {
    guid: string;
    read: boolean;
    messageCount: number;
    readPointer: string;
    sourceRowIds: string[];
};

export type ChatTransitionRow = {
    guid: string;
    is_read: number | null;
    has_messages: number | null;
    read_pointer: string | null;
    row_id: string | null;
};

/** Chat-state queries require chat.last_read_message_timestamp (macOS High Sierra+). */
export const supportsChatStateSnapshot = (isHighSierraOrLater: boolean): boolean => isHighSierraOrLater;

/** Compare non-negative decimal integers without converting them to JS Number. */
export function compareDecimalStrings(a: string, b: string): number {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * Lightweight state used by the live poller. Message work is restricted to
 * Apple's indexed unread candidates; this avoids aggregating the message table
 * while still detecting reads that do not move the chat-level pointer.
 */
export function buildChatTransitionQuery(): string {
    return `
        WITH unread_chat_ids AS (
            SELECT DISTINCT j.chat_id
            FROM message m
            JOIN chat_message_join j ON j.message_id = m.ROWID
            WHERE m.is_read = 0
                AND m.is_from_me = 0
                AND m.item_type = 0
                AND (
                    COALESCE(m.associated_message_type, 0) = 0
                    OR (
                        COALESCE(m.associated_message_type, 0) != 0
                        AND NOT EXISTS (
                            SELECT 1
                            FROM chat_message_join newer_j
                            JOIN message newer_m ON newer_m.ROWID = newer_j.message_id
                            WHERE newer_j.chat_id = j.chat_id
                                AND (
                                    newer_m.date > m.date
                                    OR (newer_m.date = m.date AND newer_m.ROWID > m.ROWID)
                                )
                        )
                    )
                )
        )
        SELECT
            c.guid AS guid,
            CAST(c.ROWID AS TEXT) AS row_id,
            EXISTS(
                SELECT 1
                FROM chat_message_join j
                WHERE j.chat_id = c.ROWID
                LIMIT 1
            ) AS has_messages,
            CAST(COALESCE(c.last_read_message_timestamp, 0) AS TEXT) AS read_pointer,
            CASE WHEN unread.chat_id IS NULL THEN 1 ELSE 0 END AS is_read
        FROM chat c
        LEFT JOIN unread_chat_ids unread ON unread.chat_id = c.ROWID
    `;
}

export function parseChatTransitionRows(rows: ChatTransitionRow[]): ChatTransitionEntry[] {
    const byGuid = new Map<string, ChatTransitionEntry>();
    for (const row of rows) {
        if (row?.guid == null) continue;
        const readPointer = row.read_pointer ?? "0";
        if (!/^\d+$/.test(readPointer)) {
            throw new Error(`Invalid read pointer for chat ${row.guid}`);
        }
        const hasMessages = Number(row.has_messages ?? 0);
        if (hasMessages !== 0 && hasMessages !== 1) {
            throw new Error(`Invalid message-existence flag for chat ${row.guid}`);
        }
        const readFlag = Number(row.is_read ?? 0);
        if (readFlag !== 0 && readFlag !== 1) {
            throw new Error(`Invalid read-state flag for chat ${row.guid}`);
        }
        const read = readFlag === 1;

        const rowId = row.row_id ?? "";
        if (!/^\d+$/.test(rowId)) {
            throw new Error(`Invalid source row ID for chat ${row.guid}`);
        }
        const existing = byGuid.get(row.guid);
        if (existing) {
            existing.read = existing.read && read;
            existing.messageCount = Math.max(existing.messageCount, hasMessages);
            if (compareDecimalStrings(readPointer, existing.readPointer) > 0) {
                existing.readPointer = readPointer;
            }
            existing.sourceRowIds.push(rowId);
            existing.sourceRowIds.sort();
        } else {
            byGuid.set(row.guid, {
                guid: row.guid,
                read,
                messageCount: hasMessages,
                readPointer,
                sourceRowIds: [rowId]
            });
        }
    }
    return [...byGuid.values()];
}

export async function loadChatTransitionState(db: DataSource): Promise<ChatTransitionEntry[]> {
    return parseChatTransitionRows(await db.query(buildChatTransitionQuery()));
}

/**
 * Selects every chat Apple knows about, with its current unread tally and read
 * pointer.
 *
 * This deliberately does NOT reuse `buildChatReadStatesQuery`. That query inner
 * joins `chat_message_join` and `message`, so a chat holding no incoming
 * messages -- an empty thread, or one where the user has only ever sent --
 * produces no row at all. That omission is harmless for read state, because a
 * chat that cannot be unread simply never needs an event. It is destructive
 * here: this snapshot is what the client diffs against to decide what Apple has
 * DELETED, so a silently missing chat would be deleted off the device.
 *
 * The pointer is an ordered transition token only: its absolute value never
 * determines read state. It stays TEXT because Apple timestamps exceed
 * JavaScript's exact-integer range.
 */
export function buildChatSnapshotQuery(): string {
    return `
        SELECT
            c.guid AS guid,
            MAX(COALESCE(c.is_archived, 0)) AS is_archived,
            COUNT(DISTINCT m.ROWID) AS message_count,
            CAST(MAX(COALESCE(c.last_read_message_timestamp, 0)) AS TEXT) AS read_pointer,
            SUM(
                CASE
                    WHEN m.is_read = 0
                        AND m.item_type = 0
                        AND m.is_from_me = 0
                        AND (
                            COALESCE(m.associated_message_type, 0) = 0
                            OR (
                                COALESCE(m.associated_message_type, 0) != 0
                                AND NOT EXISTS (
                                    SELECT 1
                                    FROM chat_message_join newer_j
                                    JOIN message newer_m ON newer_m.ROWID = newer_j.message_id
                                    WHERE newer_j.chat_id = j.chat_id
                                        AND (
                                            newer_m.date > m.date
                                            OR (newer_m.date = m.date AND newer_m.ROWID > m.ROWID)
                                        )
                                )
                            )
                        )
                    THEN 1
                    ELSE 0
                END
            ) AS unread_count
        FROM chat c
        LEFT JOIN chat_message_join j ON j.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = j.message_id
        GROUP BY c.guid
    `;
}

/**
 * A chat appearing twice (Apple can expose the same guid through more than one
 * handle row) collapses to one entry. Unread wins, archive wins, message count
 * takes the maximum, and the greatest exact read pointer wins. Reporting such a
 * chat as read would clear a badge the phone still shows.
 */
export function parseChatSnapshotRows(rows: ChatSnapshotRow[]): ChatSnapshotEntry[] {
    const byGuid = new Map<string, ChatSnapshotEntry>();

    for (const row of rows) {
        if (row?.guid == null) continue;
        const readPointer = row.read_pointer ?? "0";
        if (!/^\d+$/.test(readPointer)) {
            throw new Error(`Invalid read pointer for chat ${row.guid}`);
        }

        const next: ChatSnapshotEntry = {
            guid: row.guid,
            read: Number(row.unread_count ?? 0) === 0,
            isArchived: Number(row.is_archived ?? 0) !== 0,
            messageCount: Number(row.message_count ?? 0),
            readPointer
        };

        const existing = byGuid.get(row.guid);
        if (existing) {
            next.read = existing.read && next.read;
            next.isArchived = existing.isArchived || next.isArchived;
            next.messageCount = Math.max(existing.messageCount, next.messageCount);
            if (compareDecimalStrings(existing.readPointer, next.readPointer) > 0) {
                next.readPointer = existing.readPointer;
            }
        }
        byGuid.set(row.guid, next);
    }

    const entries: ChatSnapshotEntry[] = [];
    byGuid.forEach(entry => entries.push(entry));
    return entries;
}

export async function loadChatStateSnapshot(db: DataSource): Promise<ChatStateSnapshotResult> {
    const rows = await db.query(buildChatSnapshotQuery());
    const chats = parseChatSnapshotRows(rows);

    return { schemaVersion: 3, chats, complete: true, generatedAt: Date.now() };
}

import type { DataSource } from "typeorm";

/**
 * Read-state query helpers for the iMessage database.
 *
 * The live change detection that once lived here (`IncomingReadEventDetector`,
 * keyed on `MAX(date_read)` advancing) moved to `ChatStateChangeDetector`, which
 * diffs the full snapshot so it can also see "Mark as Unread" resets and
 * whole-thread deletions. What remains here is the authoritative unread
 * predicate shared by the backfill endpoint and the read-event re-check.
 */

export type ChatReadState = {
    guid: string;
    read: boolean;
};

/**
 * Finds the CURRENT read state of every chat that has incoming messages.
 *
 * `buildRecentlyReadChatsQuery` was deliberately not reusable here. It selected
 * any chat containing at least one read incoming message, which is correct for
 * a forward detector (it only acted when MAX(date_read) advanced) but wrong as
 * a snapshot: a chat read last week and unread today still matches. Using it to
 * backfill marks genuinely-unread chats as read.
 *
 * A chat is read only when it has no incoming message still awaiting a read, so
 * the unread tally is what decides, not the presence of a read timestamp.
 *
 * Only real messages count toward that tally. `item_type != 0` rows are system
 * events (group renames, participants added or removed) and rows with an
 * `associated_message_type` are tapbacks and edits. Apple badges none of them,
 * yet they carry `is_read = 0` forever, so counting them reports chats as unread
 * that the phone shows as read -- 170 chats here versus the true 2.
 */
export function buildChatReadStatesQuery(): string {
    return `
        SELECT
            c.guid AS guid,
            SUM(
                CASE
                    WHEN m.is_read = 0
                        AND m.date_read = 0
                        AND m.item_type = 0
                        AND COALESCE(m.associated_message_type, 0) = 0
                    THEN 1
                    ELSE 0
                END
            ) AS unread_count
        FROM chat c
        JOIN chat_message_join j ON j.chat_id = c.ROWID
        JOIN message m ON m.ROWID = j.message_id
        WHERE m.is_from_me = 0
        GROUP BY c.guid
    `;
}

export function parseChatReadStates(rows: Array<{ guid: string; unread_count: number | null }>): ChatReadState[] {
    return rows
        .filter(row => row.guid != null)
        .map(row => ({ guid: row.guid, read: Number(row.unread_count ?? 0) === 0 }));
}

export async function loadChatReadStates(db: DataSource): Promise<ChatReadState[]> {
    const rows = await db.query(buildChatReadStatesQuery());
    return parseChatReadStates(rows);
}

/**
 * Counts the incoming messages in a chat that are still awaiting a read.
 *
 * Mirrors `buildChatReadStatesQuery`: only real messages count. `item_type != 0`
 * rows are system events (group renames, participant changes) and rows with an
 * `associated_message_type` are tapbacks and edits. Apple badges none of them,
 * but they keep `is_read = 0` indefinitely, so counting them leaves a chat
 * permanently unread.
 */
export function buildChatUnreadCountQuery(): string {
    return `
        SELECT
            COUNT(DISTINCT c.ROWID) AS chat_count,
            SUM(
                CASE
                    WHEN m.is_read = 0
                        AND m.date_read = 0
                        AND m.item_type = 0
                        AND COALESCE(m.associated_message_type, 0) = 0
                        AND m.is_from_me = 0
                    THEN 1
                    ELSE 0
                END
            ) AS unread_count
        FROM chat c
        LEFT JOIN chat_message_join j ON j.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = j.message_id
        WHERE c.guid = ?
    `;
}

/**
 * Resolves whether a single chat currently has no unread incoming messages.
 *
 * A read advancing on one message does not mean the chat is read: the user may
 * have read the newest message while older ones remain unread, and emitting an
 * unconditional `read: true` clears the whole badge. Re-check the chat instead.
 */
export async function isChatFullyRead(db: DataSource, guid: string): Promise<boolean> {
    const rows = await db.query(buildChatUnreadCountQuery(), [guid]);
    const chatCount = Number(rows?.[0]?.chat_count ?? 0);
    if (chatCount <= 0) return false;
    const unread = Number(rows[0]?.unread_count ?? 0);
    return unread === 0;
}

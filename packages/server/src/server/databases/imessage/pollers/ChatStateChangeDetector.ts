import type { ChatTransitionEntry } from "../snapshot/ChatStateSnapshot";
import { compareDecimalStrings } from "../snapshot/ChatStateSnapshot";

export type ChatStateChange = { guid: string; read: boolean } | { guid: string; deleted: true };

/** Diffs consecutive Apple-side states without replaying historical state. */
export class ChatStateChangeDetector {
    private readonly states = new Map<string, ChatTransitionEntry>();

    seed(entries: ChatTransitionEntry[]): void {
        this.states.clear();
        for (const entry of entries) this.states.set(entry.guid, entry);
    }

    async observe(
        entries: ChatTransitionEntry[],
        isChatFullyRead: (guid: string) => Promise<boolean>
    ): Promise<ChatStateChange[]> {
        const changes: ChatStateChange[] = [];
        const current = new Map<string, ChatTransitionEntry>();
        for (const entry of entries) current.set(entry.guid, entry);

        for (const [guid, previous] of this.states) {
            if (previous.messageCount <= 0) continue;

            const next = current.get(guid);
            if (!next || next.messageCount === 0) {
                changes.push({ guid, deleted: true });
                continue;
            }

            const sameSourceRows =
                previous.sourceRowIds.length === next.sourceRowIds.length &&
                previous.sourceRowIds.every((rowId, index) => rowId === next.sourceRowIds[index]);
            if (!sameSourceRows) continue;

            const pointerChange = compareDecimalStrings(next.readPointer, previous.readPointer);
            if (pointerChange < 0 || (previous.read && !next.read)) {
                changes.push({ guid, read: false });
            } else if (!previous.read && next.read) {
                changes.push({ guid, read: true });
            } else if (pointerChange > 0 && next.read && (await isChatFullyRead(guid))) {
                changes.push({ guid, read: true });
            }
        }

        // Commit the new baseline only after every targeted read check succeeds.
        // A query failure therefore retries the complete transition next poll.
        this.states.clear();
        for (const [guid, state] of current) this.states.set(guid, state);
        return changes;
    }
}

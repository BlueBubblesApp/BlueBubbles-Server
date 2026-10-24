import type { RecoverableMessageEntry } from "../snapshot/RecoverableMessageSnapshot";

export type RecoverableMessageChange =
    | { chatGuid: string; messageGuid: string; deleted: true }
    | { chatGuid: string; messageGuid: string; restored: true };

/**
 * Diffs consecutive Recently Deleted sets without replaying history.
 *
 * Modelled on ChatStateChangeDetector: the first observation only seeds a
 * baseline, so a server restart never re-announces deletions the client has
 * already applied, and the new baseline is committed only after every lookup
 * succeeds so a failed poll retries the whole transition.
 */
export class RecoverableMessageChangeDetector {
    private readonly deleted = new Map<string, RecoverableMessageEntry>();

    seed(entries: RecoverableMessageEntry[]): void {
        this.deleted.clear();
        for (const entry of entries) this.deleted.set(entry.messageGuid, entry);
    }

    /**
     * @param isMessagePresent Confirms a message that left Recently Deleted is
     *   still in Apple's message table. Emptying Recently Deleted removes the
     *   row AND the message, which must not be reported as a restore.
     */
    async observe(
        entries: RecoverableMessageEntry[],
        isMessagePresent: (messageGuid: string) => Promise<boolean>
    ): Promise<RecoverableMessageChange[]> {
        const changes: RecoverableMessageChange[] = [];
        const current = new Map<string, RecoverableMessageEntry>();
        for (const entry of entries) current.set(entry.messageGuid, entry);

        for (const [messageGuid, entry] of current) {
            if (this.deleted.has(messageGuid)) continue;
            // A whole-conversation delete drops every message into Recently
            // Deleted at once. That is already one `chat-deleted` event, so
            // emitting a per-message event for each would be a storm saying
            // nothing new.
            if (!entry.chatHasMessages) continue;
            changes.push({ chatGuid: entry.chatGuid, messageGuid, deleted: true });
        }

        for (const [messageGuid, entry] of this.deleted) {
            if (current.has(messageGuid)) continue;
            if (!(await isMessagePresent(messageGuid))) continue;
            changes.push({ chatGuid: entry.chatGuid, messageGuid, restored: true });
        }

        // Commit the new baseline only after every presence check succeeded.
        this.deleted.clear();
        for (const [messageGuid, entry] of current) this.deleted.set(messageGuid, entry);
        return changes;
    }
}

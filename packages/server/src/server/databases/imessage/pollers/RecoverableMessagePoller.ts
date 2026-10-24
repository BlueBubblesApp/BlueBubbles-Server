import { IMessagePollResult, IMessagePollType, IMessagePoller } from ".";
import { MESSAGE_DELETED, MESSAGE_RESTORED } from "@server/events";
import { RecoverableMessageChangeDetector } from "./RecoverableMessageChangeDetector";
import { isMessagePresent, loadRecoverableMessages } from "../snapshot/RecoverableMessageSnapshot";

/**
 * Reports messages Apple moved into, or back out of, Recently Deleted.
 *
 * Apple-to-Android only. Deleting one message moves its `chat_message_join`
 * row into `chat_recoverable_message_join` and leaves both the chat row and
 * the message row in place, so nothing in the existing message or chat pollers
 * ever observes it.
 */
export class RecoverableMessagePoller extends IMessagePoller {
    tag = "RecoverableMessagePoller";

    type = IMessagePollType.MESSAGE;

    private readonly detector = new RecoverableMessageChangeDetector();

    private seeded = false;

    async poll(_after: Date): Promise<IMessagePollResult[]> {
        const entries = await loadRecoverableMessages(this.repo.db);

        // The first poll of a server run states what is already deleted; it is
        // not news. Clients that were offline catch up through the snapshot
        // endpoint instead.
        if (!this.seeded) {
            this.detector.seed(entries);
            this.seeded = true;
            return [];
        }

        const changes = await this.detector.observe(entries, guid => isMessagePresent(this.repo.db, guid));

        return changes.map(change => ({
            eventType: "deleted" in change ? MESSAGE_DELETED : MESSAGE_RESTORED,
            data: { chatGuid: change.chatGuid, messageGuid: change.messageGuid }
        }));
    }
}

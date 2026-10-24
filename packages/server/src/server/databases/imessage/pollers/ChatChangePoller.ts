import { CHAT_DELETED, CHAT_READ_STATUS_CHANGED } from "@server/events";
import { IMessagePollResult, IMessagePollType, IMessagePoller } from ".";
import { isChatFullyRead } from "./IncomingReadEventDetector";
import { loadChatTransitionState } from "../snapshot/ChatStateSnapshot";
import { ChatStateChangeDetector } from "./ChatStateChangeDetector";

export class ChatUpdatePoller extends IMessagePoller {
    tag = "ChatUpdatePoller";
    type = IMessagePollType.CHAT;
    private readonly detector = new ChatStateChangeDetector();
    private seeded = false;

    /** Emits forward-only read-state and whole-chat deletion events. */
    async poll(_after: Date): Promise<IMessagePollResult[]> {
        const entries = await loadChatTransitionState(this.repo.db);

        if (!this.seeded) {
            this.seeded = true;
            this.detector.seed(entries);
            return [];
        }

        const changes = await this.detector.observe(entries, guid => isChatFullyRead(this.repo.db, guid));
        return changes.map(change => {
            if ("deleted" in change) {
                return { eventType: CHAT_DELETED, data: { guid: change.guid } };
            }
            return {
                eventType: CHAT_READ_STATUS_CHANGED,
                data: { guid: change.guid, read: change.read }
            };
        });
    }
}

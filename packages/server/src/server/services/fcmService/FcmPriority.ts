import { CHAT_READ_STATUS_CHANGED } from "../../events";

export type FcmPriority = "normal" | "high";

export function resolveFcmPriority(type: string, requestedPriority: FcmPriority): FcmPriority {
    return type === CHAT_READ_STATUS_CHANGED ? "high" : requestedPriority;
}

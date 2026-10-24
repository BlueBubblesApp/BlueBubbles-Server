import { NSAttributedString } from "node-typedstream";

export type ServerMetadataResponse = {
    computer_id: string;
    os_version: string;
    server_version: string;
    private_api: boolean;
    helper_connected: boolean;
    proxy_service: string;
    detected_icloud: string;
    detected_imessage: string;
    macos_time_sync: number | null;
    local_ipv4s: string[];
    local_ipv6s: string[];
};

/**
 * ITEM TYPES:
 * 0: Text
 * 1: Removal of person from conversation (groupActionType == 1)
 * 1: Adding of person to conversation (groupActionType == 0)
 * 2: Group Name Change
 * 3: Someone left the conversation (handle_id shows who)
 */
export type MessageResponse = {
    originalROWID: number;
    tempGuid?: string;
    guid: string;
    text: string;
    attributedBody?: NSAttributedString[];
    messageSummaryInfo?: NodeJS.Dict<any>[];
    handle?: HandleResponse | null;
    handleId: number;
    otherHandle: number;
    chats?: ChatResponse[];
    attachments?: AttachmentResponse[];
    subject: string;
    country?: string;
    error: number;
    dateCreated: number;
    dateRead: number | null;
    dateDelivered: number | null;
    isFromMe: boolean;
    isDelayed?: boolean;
    isDelivered?: boolean;
    isAutoReply?: boolean;
    isSystemMessage?: boolean;
    isServiceMessage?: boolean;
    isForward?: boolean;
    isArchived: boolean;
    hasDdResults?: boolean;
    cacheRoomnames?: string | null;
    isAudioMessage?: boolean;
    datePlayed?: number | null;
    itemType: number;
    groupTitle: string | null;
    groupActionType: number;
    isExpired?: boolean;
    balloonBundleId: string | null;
    associatedMessageGuid: string | null;
    associatedMessageType: string | null;
    expressiveSendStyleId: string | null;
    timeExpressiveSendPlayed?: number | null;
    replyToGuid?: string | null;
    isCorrupt?: boolean;
    isSpam?: boolean;
    threadOriginatorGuid?: string | null;
    threadOriginatorPart?: string | null;
    dateRetracted?: number | null;
    dateEdited?: number | null;
    partCount?: number | null;
    payloadData?: NodeJS.Dict<any>[];
    hasPayloadData?: boolean;
    wasDeliveredQuietly?: boolean;
    didNotifyRecipient?: boolean;
    shareStatus?: number | null;
    shareDirection?: number | null;
};

export type HandleResponse = {
    originalROWID: number;
    messages?: MessageResponse[];
    chats?: ChatResponse[];
    address: string;
    service: string;
    country?: string;
    uncanonicalizedId?: string;
};

export type ChatResponse = {
    originalROWID: number;
    guid: string;
    participants?: HandleResponse[];
    messages?: MessageResponse[];
    lastMessage?: MessageResponse;
    properties?: NodeJS.Dict<any>[] | null;
    style: number;
    chatIdentifier: string;
    isArchived: boolean;
    isFiltered?: boolean;
    isFilteredAsSpam?: boolean;
    displayName: string;
    groupId?: string;
    lastAddressedHandle?: string | null;
};

export type AttachmentResponse = {
    originalROWID: number;
    guid: string;
    messages?: string[];
    data?: string; // Base64 string
    blurhash?: string;
    height?: number;
    width?: number;
    uti: string;
    mimeType: string;
    transferState?: number;
    totalBytes: number;
    isOutgoing?: boolean;
    transferName: string;
    isSticker?: boolean;
    hideAttachment?: boolean;
    originalGuid?: string;
    metadata?: { [key: string]: string | boolean | number };
    hasLivePhoto?: boolean;
};

export type ValidTapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
export type ValidRemoveTapback = "-love" | "-like" | "-dislike" | "-laugh" | "-emphasize" | "-question";
export enum ProgressStatus {
    NOT_STARTED = "NOT_STARTED",
    IN_PROGRESS = "IN_PROGRESS",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED"
}

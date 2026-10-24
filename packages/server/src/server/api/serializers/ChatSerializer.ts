import { ChatResponse } from "@server/types";
import { DEFAULT_CHAT_CONFIG, DEFAULT_HANDLE_CONFIG, DEFAULT_MESSAGE_CONFIG } from "./constants";
import type { ChatSerializerMutliParams, ChatSerializerSingleParams } from "./types";
import { MessageSerializer } from "./MessageSerializer";
import { HandleSerializer } from "./HandleSerializer";
import { isChatFilteredAsSpam } from "./chatSpam";

export class ChatSerializer {
    static async serialize({
        chat,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams): Promise<ChatResponse> {
        return (
            await ChatSerializer.serializeList({
                chats: [chat],
                config: { ...DEFAULT_CHAT_CONFIG, ...config },
                messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                isForNotification
            })
        )[0];
    }

    static async serializeList({
        chats,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerMutliParams): Promise<ChatResponse[]> {
        return Promise.all(
            chats.map(
                async chat =>
                    await ChatSerializer.convert({
                        chat,
                        config: { ...DEFAULT_CHAT_CONFIG, ...config },
                        messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                        handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                        isForNotification
                    })
            )
        );
    }

    private static async convert({
        chat,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams): Promise<ChatResponse> {
        let output: ChatResponse = {
            originalROWID: chat.ROWID,
            guid: chat.guid,
            style: chat.style,
            chatIdentifier: chat.chatIdentifier,
            isArchived: chat.isArchived,
            displayName: chat.displayName,
            // Included in notifications too: the first message from a new spam
            // sender arrives by push, before any chat sync.
            isFilteredAsSpam: isChatFilteredAsSpam(chat.properties)
        };

        if (config.includeParticipants) {
            output.participants = await HandleSerializer.serializeList({
                handles: chat?.participants ?? [],
                config: {
                    ...handleConfig,
                    includeChats: false
                },
                messageConfig,
                chatConfig: config,
                isForNotification
            });
        }

        if (config.includeMessages) {
            output.messages = await MessageSerializer.serializeList({
                messages: chat?.messages ?? [],
                config: {
                    ...messageConfig,
                    includeChats: false
                },
                isForNotification
            });
        }

        if (!isForNotification) {
            output = {
                ...output,
                ...{
                    isFiltered: chat.isFiltered,
                    groupId: chat.groupId,
                    properties: chat.properties,
                    lastAddressedHandle: chat.lastAddressedHandle
                }
            };
        }

        return output;
    }
}

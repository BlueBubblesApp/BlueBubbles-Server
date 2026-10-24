import * as KoaRouter from "koa-router";
import { Server } from "@server";
import { isNotEmpty } from "@server/helpers/utils";

// Middleware
import { AuthMiddleware } from "./middleware/authMiddleware";

// Routers
import { ThemeRouter } from "./routers/themeRouter";
import { HandleRouter } from "./routers/handleRouter";
import { MessageRouter } from "./routers/messageRouter";
import { ChatRouter } from "./routers/chatRouter";
import { AttachmentRouter } from "./routers/attachmentRouter";
import { FcmRouter } from "./routers/fcmRouter";
import { ServerRouter } from "./routers/serverRouter";
import { GeneralRouter } from "./routers/generalRouter";
import { UiRouter } from "./routers/uiRouter";
import { SettingsRouter } from "./routers/settingsRouter";
import { ContactRouter } from "./routers/contactRouter";
import { MetricsMiddleware } from "./middleware/metricsMiddleware";
import { LogMiddleware } from "./middleware/logMiddleware";
import { ErrorMiddleware } from "./middleware/errorMiddleware";
import { MacOsRouter } from "./routers/macosRouter";
import { iCloudRouter } from "./routers/icloudRouter";
import { FaceTimeRouter } from "./routers/facetimeRouter";
import { PrivateApiMiddleware } from "./middleware/privateApiMiddleware";
import { HttpDefinition, HttpMethod, HttpRoute, HttpRouteGroup, KoaMiddleware } from "../../types";
import { SettingsValidator } from "./validators/settingsValidator";
import { MessageValidator } from "./validators/messageValidator";
import { HandleValidator } from "./validators/handleValidator";
import { FcmValidator } from "./validators/fcmValidator";
import { AttachmentValidator } from "./validators/attachmentValidator";
import { ChatValidator } from "./validators/chatValidator";
import { AlertsValidator } from "./validators/alertsValidator";
import { ScheduledMessageValidator } from "./validators/scheduledMessageValidator";
import { ScheduledMessageRouter } from "./routers/scheduledMessageRouter";
import { ThemeValidator } from "./validators/themeValidator";
import type { Context, Next } from "koa";
import { FindMyRouter } from "./routers/findmyRouter";
import { getLogger } from "@server/lib/logging/Loggable";
import { WebhookRouter } from "./routers/webhookRouter";
import { WebhookValidator } from "./validators/webhookValidator";
import { ContactValidator } from "./validators/contactValidator";

export class HttpRoutes {
    static version = 1;

    static defaultRequestTimeout = 60 * 1000; // 1 minute

    static defaultResponseTimeout = 5 * 60 * 1000; // 5 minutes

    private static get protected() {
        return [...HttpRoutes.unprotected, AuthMiddleware];
    }

    private static get unprotected() {
        return [MetricsMiddleware, ErrorMiddleware, LogMiddleware];
    }

    static api: HttpDefinition = {
        root: "api",
        routeGroups: [
            {
                name: "General",
                middleware: HttpRoutes.protected,
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "ping",
                        controller: GeneralRouter.ping
                    }
                ]
            },
            {
                name: "macOS",
                middleware: HttpRoutes.protected,
                prefix: "mac",
                responseTimeoutMs: 30 * 1000,
                routes: [
                    {
                        method: HttpMethod.POST,
                        path: "lock",
                        controller: MacOsRouter.lock
                    },
                    {
                        method: HttpMethod.POST,
                        path: "imessage/restart",
                        controller: MacOsRouter.restartMessagesApp
                    }
                ]
            },
            {
                name: "iCloud",
                middleware: HttpRoutes.protected,
                prefix: "icloud",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "account",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: iCloudRouter.getAccountInfo
                    },
                    {
                        method: HttpMethod.POST,
                        path: "account/alias",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: iCloudRouter.changeAlias
                    },
                    {
                        method: HttpMethod.GET,
                        path: "contact",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: iCloudRouter.getContactCard
                    },
                    {
                        method: HttpMethod.GET,
                        path: "findmy/devices",
                        controller: FindMyRouter.devices
                    },
                    {
                        method: HttpMethod.POST,
                        path: "findmy/devices/refresh",
                        controller: FindMyRouter.refreshDevices
                    },
                    {
                        method: HttpMethod.GET,
                        path: "findmy/friends",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: FindMyRouter.friends
                    },
                    {
                        method: HttpMethod.POST,
                        path: "findmy/friends/refresh",
                        controller: FindMyRouter.refreshFriends
                    }
                ]
            },
            {
                name: "Server",
                middleware: HttpRoutes.protected,
                prefix: "server",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "info",
                        controller: ServerRouter.getInfo
                    },
                    {
                        method: HttpMethod.GET,
                        path: "chat-state/snapshot",
                        controller: ServerRouter.getChatStateSnapshot
                    },
                    {
                        method: HttpMethod.GET,
                        path: "recoverable-messages/snapshot",
                        controller: ServerRouter.getRecoverableMessageSnapshot
                    },
                    {
                        method: HttpMethod.GET,
                        path: "logs",
                        controller: ServerRouter.getLogs
                    },
                    {
                        method: HttpMethod.GET,
                        path: "restart/soft",
                        controller: ServerRouter.restartServices
                    },
                    {
                        method: HttpMethod.GET,
                        path: "restart/hard",
                        controller: ServerRouter.restartAll
                    },
                    {
                        method: HttpMethod.GET,
                        path: "update/check",
                        controller: ServerRouter.checkForUpdate
                    },
                    {
                        method: HttpMethod.POST,
                        path: "update/install",
                        controller: ServerRouter.installUpdate,
                        // 30 minute timeout in the case that they want to wait for the install to complete
                        responseTimeoutMs: 30 * 60 * 1000
                    },
                    {
                        method: HttpMethod.GET,
                        path: "alert",
                        controller: ServerRouter.getAlerts
                    },
                    {
                        method: HttpMethod.POST,
                        path: "alert/read",
                        controller: ServerRouter.markAsRead,
                        validators: [AlertsValidator.validateRead]
                    },
                    {
                        method: HttpMethod.GET,
                        path: "statistics/totals",
                        controller: ServerRouter.getStatTotals
                    },
                    {
                        method: HttpMethod.GET,
                        path: "statistics/media",
                        controller: ServerRouter.getStatMedia
                    },
                    {
                        method: HttpMethod.GET,
                        path: "statistics/media/chat",
                        controller: ServerRouter.getStatMediaByChat
                    }
                ]
            },
            {
                name: "FCM",
                middleware: HttpRoutes.protected,
                prefix: "fcm",
                routes: [
                    {
                        method: HttpMethod.POST,
                        path: "device",
                        validators: [FcmValidator.validateRegistration],
                        controller: FcmRouter.registerDevice
                    },
                    {
                        method: HttpMethod.GET,
                        path: "client",
                        controller: FcmRouter.getClientConfig
                    }
                ]
            },
            {
                name: "Attachment",
                middleware: HttpRoutes.protected,
                prefix: "attachment",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "count",
                        controller: AttachmentRouter.count
                    },
                    {
                        method: HttpMethod.POST,
                        path: "upload",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [AttachmentValidator.validateUpload],
                        controller: AttachmentRouter.uploadAttachment,
                        // 30 minute timeout for uploads
                        requestTimeoutMs: 30 * 60 * 1000
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/download",
                        validators: [AttachmentValidator.validateDownload],
                        controller: AttachmentRouter.download,
                        // 30 minute timeout for this to account for people on slow connections
                        responseTimeoutMs: 30 * 60 * 1000
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/download/force",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [AttachmentValidator.validateDownload],
                        controller: AttachmentRouter.forceDownload,
                        // 60 minute timeout for this to account for people on slow connections.
                        // Since a "force" means the attachment isnt already downloaded, give it
                        // double the time. The client can timeout if it pleases.
                        responseTimeoutMs: 60 * 60 * 1000
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/blurhash",
                        validators: [AttachmentValidator.validateDownload],
                        controller: AttachmentRouter.blurhash
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/live",
                        controller: AttachmentRouter.downloadLive,
                        // 30 minute timeout for this to account for people on slow connections
                        responseTimeoutMs: 30 * 60 * 1000
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid",
                        validators: [AttachmentValidator.validateFind],
                        controller: AttachmentRouter.find
                    }
                ]
            },
            {
                name: "Chat",
                middleware: HttpRoutes.protected,
                prefix: "chat",
                routes: [
                    {
                        method: HttpMethod.POST,
                        path: "new",
                        middleware: [...HttpRoutes.protected],
                        validators: [ChatValidator.validateCreate],
                        controller: ChatRouter.create
                    },
                    {
                        method: HttpMethod.GET,
                        path: "count",
                        controller: ChatRouter.count
                    },
                    {
                        method: HttpMethod.POST,
                        path: "query",
                        validators: [ChatValidator.validateQuery],
                        controller: ChatRouter.query
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/message",
                        validators: [ChatValidator.validateGetMessages],
                        controller: ChatRouter.getMessages
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/share/contact/status",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.shouldShareContact
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/share/contact",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.shareContact
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/read",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.markRead
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/unread",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.markUnread
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/leave",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.leaveChat
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/participant",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateToggleParticipant],
                        controller: ChatRouter.addParticipant
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":guid/participant",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateToggleParticipant],
                        controller: ChatRouter.removeParticipant
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/participant/add",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateToggleParticipant],
                        controller: ChatRouter.addParticipant
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/participant/remove",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateToggleParticipant],
                        controller: ChatRouter.removeParticipant
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/typing",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.startTyping
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":guid/typing",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.stopTyping
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/icon",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateGroupChatIcon],
                        controller: ChatRouter.setGroupChatIcon
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":guid/icon",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.removeGroupChatIcon
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/icon",
                        middleware: [...HttpRoutes.protected],
                        controller: ChatRouter.getGroupIcon
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":guid/:messageGuid",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.deleteChatMessage
                    },
                    {
                        method: HttpMethod.PUT,
                        path: ":guid",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [ChatValidator.validateUpdate],
                        controller: ChatRouter.update
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid",
                        controller: ChatRouter.find
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":guid",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: ChatRouter.deleteChat
                    }
                ]
            },
            {
                name: "Message",
                middleware: HttpRoutes.protected,
                prefix: "message",
                routes: [
                    {
                        method: HttpMethod.POST,
                        path: "text",
                        validators: [MessageValidator.validateText],
                        controller: MessageRouter.sendText
                    },
                    {
                        method: HttpMethod.POST,
                        path: "attachment",
                        validators: [MessageValidator.validateAttachment],
                        controller: MessageRouter.sendAttachment
                    },
                    {
                        method: HttpMethod.POST,
                        path: "attachment/chunk",
                        validators: [MessageValidator.validateAttachmentChunk],
                        controller: MessageRouter.sendAttachmentChunk
                    },
                    {
                        method: HttpMethod.POST,
                        path: "multipart",
                        validators: [MessageValidator.validateMultipart],
                        controller: MessageRouter.sendMultipartMessage
                    },
                    {
                        method: HttpMethod.POST,
                        path: "react",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [MessageValidator.validateReaction],
                        controller: MessageRouter.react
                    },
                    {
                        method: HttpMethod.GET,
                        path: "count",
                        validators: [MessageValidator.validateCount],
                        controller: MessageRouter.count
                    },
                    {
                        method: HttpMethod.GET,
                        path: "count/updated",
                        validators: [MessageValidator.validateUpdatedCount],
                        controller: MessageRouter.countUpdated
                    },
                    {
                        method: HttpMethod.GET,
                        path: "count/me",
                        controller: MessageRouter.sentCount
                    },
                    {
                        method: HttpMethod.POST,
                        path: "query",
                        validators: [MessageValidator.validateQuery],
                        controller: MessageRouter.query
                    },
                    {
                        method: HttpMethod.GET,
                        path: "schedule",
                        controller: ScheduledMessageRouter.getScheduledMessages
                    },
                    {
                        method: HttpMethod.POST,
                        path: "schedule",
                        validators: [ScheduledMessageValidator.validateScheduledMessage],
                        controller: ScheduledMessageRouter.createScheduledMessage
                    },
                    {
                        method: HttpMethod.GET,
                        path: "schedule/:id",
                        controller: ScheduledMessageRouter.getById
                    },
                    {
                        method: HttpMethod.PUT,
                        path: "schedule/:id",
                        validators: [ScheduledMessageValidator.validateScheduledMessage],
                        controller: ScheduledMessageRouter.updateScheduledMessage
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: "schedule/:id",
                        controller: ScheduledMessageRouter.deleteById
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid",
                        validators: [MessageValidator.validateFind],
                        controller: MessageRouter.find
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/edit",
                        validators: [MessageValidator.validateEdit],
                        controller: MessageRouter.editMessage
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/unsend",
                        validators: [MessageValidator.validateUnsend],
                        controller: MessageRouter.unsendMessage
                    },
                    {
                        method: HttpMethod.POST,
                        path: ":guid/notify",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        controller: MessageRouter.notify
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/embedded-media",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [MessageValidator.validateGetEmbeddedMedia],
                        controller: MessageRouter.getEmbeddedMedia
                    }
                ]
            },
            {
                name: "Handle",
                middleware: HttpRoutes.protected,
                prefix: "handle",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "count",
                        controller: HandleRouter.count
                    },
                    {
                        method: HttpMethod.POST,
                        path: "query",
                        validators: [HandleValidator.validateQuery],
                        controller: HandleRouter.query
                    },
                    {
                        method: HttpMethod.GET,
                        path: "availability/imessage",
                        middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                        validators: [HandleValidator.validateAvailability],
                        controller: HandleRouter.getMessagesAvailability
                    },
                    {
                        method: HttpMethod.GET,
                        path: "availability/facetime",
                        validators: [HandleValidator.validateAvailability],
                        controller: HandleRouter.getFacetimeAvailability
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid",
                        validators: [HandleValidator.validateFind],
                        controller: HandleRouter.find
                    },
                    {
                        method: HttpMethod.GET,
                        path: ":guid/focus",
                        validators: [HandleValidator.validateFind],
                        controller: HandleRouter.getFocusStatus
                    }
                ]
            },
            {
                name: "FaceTime",
                middleware: [...HttpRoutes.protected, PrivateApiMiddleware],
                prefix: "facetime",
                routes: [
                    {
                        method: HttpMethod.POST,
                        path: "session",
                        controller: FaceTimeRouter.newSession
                    },
                    {
                        method: HttpMethod.POST,
                        path: "answer/:call_uuid",
                        controller: FaceTimeRouter.answer
                    },
                    {
                        method: HttpMethod.POST,
                        path: "leave/:call_uuid",
                        controller: FaceTimeRouter.leave
                    }
                ]
            },
            {
                name: "Contact",
                middleware: HttpRoutes.protected,
                prefix: "contact",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "",
                        controller: ContactRouter.get
                    },
                    {
                        method: HttpMethod.POST,
                        path: "",
                        controller: ContactRouter.create,
                        // Increase the timeout to 5 minutes for requests in case there are avatars
                        requestTimeoutMs: 5 * 60 * 1000
                    },
                    {
                        method: HttpMethod.PUT,
                        path: "",
                        validators: [ContactValidator.validateUpdate],
                        controller: ContactRouter.update
                    },
                    {
                        method: HttpMethod.PUT,
                        path: ":id",
                        validators: [ContactValidator.validateUpdate],
                        controller: ContactRouter.update
                    },
                    {
                        method: HttpMethod.GET,
                        path: "external/:externalId",
                        controller: ContactRouter.findByExternalId
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":id",
                        validators: [ContactValidator.validateDelete],
                        controller: ContactRouter.delete
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: "",
                        validators: [ContactValidator.validateDelete],
                        controller: ContactRouter.delete
                    },
                    {
                        method: HttpMethod.POST,
                        path: "query",
                        controller: ContactRouter.query
                    },
                    {
                        method: HttpMethod.POST,
                        path: "import/vcf",
                        validators: [ContactValidator.validateImportVcf],
                        controller: ContactRouter.importVcf,
                        requestTimeoutMs: 5 * 60 * 1000
                    }
                ]
            },
            {
                name: "Backup",
                middleware: HttpRoutes.protected,
                prefix: "backup",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "theme",
                        controller: ThemeRouter.get
                    },
                    {
                        method: HttpMethod.POST,
                        path: "theme",
                        validators: [ThemeValidator.validate],
                        controller: ThemeRouter.create
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: "theme",
                        validators: [ThemeValidator.validateDelete],
                        controller: ThemeRouter.delete
                    },
                    {
                        method: HttpMethod.GET,
                        path: "settings",
                        controller: SettingsRouter.get
                    },
                    {
                        method: HttpMethod.POST,
                        path: "settings",
                        validators: [SettingsValidator.validate],
                        controller: SettingsRouter.create
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: "settings",
                        validators: [SettingsValidator.validateDelete],
                        controller: SettingsRouter.delete
                    }
                ]
            },
            {
                name: "Webhooks",
                middleware: HttpRoutes.protected,
                prefix: "webhook",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "",
                        validators: [WebhookValidator.validateGetWebhooks],
                        controller: WebhookRouter.get
                    },
                    {
                        method: HttpMethod.POST,
                        path: "",
                        validators: [WebhookValidator.validateCreateWebhook],
                        controller: WebhookRouter.create
                    },
                    {
                        method: HttpMethod.DELETE,
                        path: ":id",
                        controller: WebhookRouter.delete
                    }
                ]
            }
        ]
    };

    static ui: HttpDefinition = {
        root: "/",
        routeGroups: [
            {
                name: "Index",
                middleware: HttpRoutes.unprotected,
                prefix: "/",
                routes: [
                    {
                        method: HttpMethod.GET,
                        path: "/",
                        controller: UiRouter.index
                    }
                ]
            }
        ]
    };

    static createRoutes(router: KoaRouter) {
        const { api, ui } = HttpRoutes;

        // Load in the API routes
        for (const group of api.routeGroups) {
            for (const route of group.routes) {
                const middleware = HttpRoutes.buildMiddleware(group, route);
                HttpRoutes.registerRoute(
                    router,
                    route.method,
                    [api.root, `v${HttpRoutes.version}`, group.prefix, route.path],
                    middleware
                );
            }
        }

        // Load in the UI routes
        for (const group of ui.routeGroups) {
            for (const route of group.routes) {
                const middleware = HttpRoutes.buildMiddleware(group, route);
                HttpRoutes.registerRoute(router, route.method, [ui.root, group.prefix, route.path], middleware);
            }
        }
    }

    private static TimeoutMiddleware(requestTimeoutMs: number, responseTimeoutMs: number) {
        return async (ctx: Context, next: Next) => {
            ctx.req.setTimeout(requestTimeoutMs, () => {
                ctx.status = 504;
                ctx.set("Content-Type", "application/json");
                ctx.res.end(
                    JSON.stringify({
                        status: 504,
                        message: `The request timed-out after ${requestTimeoutMs} ms!`,
                        error: {
                            type: "Gateway Timeout",
                            message: "The data in your request took too long to get to the server!"
                        }
                    })
                );
            });

            ctx.res.setTimeout(responseTimeoutMs, () => {
                ctx.status = 504;
                ctx.set("Content-Type", "application/json");
                ctx.res.end(
                    JSON.stringify({
                        status: 504,
                        message: `The request timed-out after ${responseTimeoutMs}!`,
                        error: {
                            type: "Gateway Timeout",
                            message: "The server took too long to respond and has timed-out!"
                        }
                    })
                );
            });

            await next();
        };
    }

    private static buildMiddleware(group: HttpRouteGroup, route: HttpRoute) {
        let reqTimeout = this.defaultRequestTimeout;
        let resTimeout = this.defaultResponseTimeout;

        // Prioritize the route timeout over the group timeout
        if (route.requestTimeoutMs && route.requestTimeoutMs > 0) {
            reqTimeout = route.requestTimeoutMs;
        } else if (group.requestTimeoutMs && group.requestTimeoutMs > 0) {
            reqTimeout = group.requestTimeoutMs;
        }

        // Prioritize the route timeout over the group timeout
        if (route.responseTimeoutMs && route.responseTimeoutMs > 0) {
            resTimeout = route.responseTimeoutMs;
        } else if (group.responseTimeoutMs && group.responseTimeoutMs > 0) {
            resTimeout = group.responseTimeoutMs;
        }

        return [
            ...(route?.middleware ?? group.middleware ?? []),
            this.TimeoutMiddleware(reqTimeout, resTimeout),
            ...(route.validators ?? []),
            route.controller
        ];
    }

    private static registerRoute(
        router: KoaRouter,
        method: HttpMethod,
        pathParts: string[],
        middleware: KoaMiddleware[]
    ) {
        const log = getLogger("HttpRoutes");

        // Sanitize the path parts so we can accurately build them
        const parts = pathParts.map(i => (i ?? "").replace(/(^\/)|(\/$)/g, "")).filter(i => isNotEmpty(i));

        // Build the path
        const path = `/${parts.join("/")}`;
        log.debug(`Registering route: [${method}] -> ${path}`);

        // Create the routes based on type
        if (method === HttpMethod.GET) router.get(path, ...middleware);
        if (method === HttpMethod.POST) router.post(path, ...middleware);
        if (method === HttpMethod.PUT) router.put(path, ...middleware);
        if (method === HttpMethod.PATCH) router.patch(path, ...middleware);
        if (method === HttpMethod.DELETE) router.delete(path, ...middleware);
    }
}

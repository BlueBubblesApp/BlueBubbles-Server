import { Next } from "koa";
import { RouterContext } from "koa-router";
import { FileSystem } from "@server/fileSystem";
import { Server } from "@server";
import { ServerInterface } from "@server/api/interfaces/serverInterface";
import { GeneralInterface } from "@server/api/interfaces/generalInterface";
import { Success } from "../responses/success";
import { AlertsInterface } from "@server/api/interfaces/alertsInterface";
import { isEmpty, isTruthyBool } from "@server/helpers/utils";
import { BadRequest, ServerError } from "../responses/errors";
import { isMinHighSierra } from "@server/env";
import { supportsChatStateSnapshot } from "@server/databases/imessage/snapshot/ChatStateSnapshot";
import { isMinVentura } from "@server/env";
import { supportsRecoverableMessages } from "@server/databases/imessage/snapshot/RecoverableMessageSnapshot";
import { autoUpdater } from "electron-updater";
import { SERVER_UPDATE_DOWNLOADING } from "@server/events";

export class ServerRouter {
    static async getInfo(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: await GeneralInterface.getServerMetadata() }).send();
    }

    static async getChatStateSnapshot(ctx: RouterContext, _: Next) {
        if (!supportsChatStateSnapshot(isMinHighSierra)) {
            throw new BadRequest({
                message: "Chat-state snapshots require macOS High Sierra or later!",
                error: "UNSUPPORTED_MACOS_VERSION"
            });
        }

        try {
            const result = await Server().getChatStateSnapshot();
            return new Success(ctx, { data: result }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to build chat state snapshot!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async getRecoverableMessageSnapshot(ctx: RouterContext, _: Next) {
        if (!supportsRecoverableMessages(isMinVentura)) {
            throw new BadRequest({
                message: "Recently Deleted requires macOS Ventura or later!",
                error: "UNSUPPORTED_MACOS_VERSION"
            });
        }

        try {
            const result = await Server().getRecoverableMessageSnapshot();
            return new Success(ctx, { data: result }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to build recoverable message snapshot!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async checkForUpdate(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: await GeneralInterface.checkForUpdate() }).send();
    }

    static async installUpdate(ctx: RouterContext, _: Next) {
        const waitParam = (ctx.request.query?.wait ?? "false") as string;
        const wait = isTruthyBool(waitParam);

        // Check if there even is an update
        const updateMetadata = await GeneralInterface.checkForUpdate();
        if (!updateMetadata?.available) {
            throw new BadRequest({ message: "No update available!", error: "NO_UPDATE_AVAILABLE" });
        }

        // Once the update is downloaded, it should be installed automatically.
        // Ref: updateService/index.ts
        Server().emitMessage(SERVER_UPDATE_DOWNLOADING, null);
        const waiter = autoUpdater.downloadUpdate();
        if (wait) {
            Server().log("Waiting for update to download...", "debug");
            await waiter;
        }

        return new Success(ctx, { message: "Update has started downloading!" }).send();
    }

    static async restartServices(ctx: RouterContext, _: Next) {
        // Give it a second so that we can return to the client
        setTimeout(() => {
            Server().hotRestart();
        }, 1000);

        return new Success(ctx, { message: "Successfully kicked off services restart!" }).send();
    }

    static async restartAll(ctx: RouterContext, _: Next) {
        // Give it a second so that we can return to the client
        setTimeout(() => {
            Server().relaunch();
        }, 1000);
        return new Success(ctx, { message: "Successfully kicked off re-launch process!" }).send();
    }

    static async getLogs(ctx: RouterContext, _: Next) {
        const countParam = ctx.request.query?.count ?? "100";
        let count;

        try {
            count = Number.parseInt(countParam as string, 10);
        } catch (ex: any) {
            count = 100;
        }

        const logs = await FileSystem.getLogs({ count });
        return new Success(ctx, { data: logs }).send();
    }

    static async getStatTotals(ctx: RouterContext, _: Next) {
        const { only } = ctx.request.query;

        const params: any = {};
        if (only) {
            params.only = (only as string).split(",");
        }

        return new Success(ctx, { data: await ServerInterface.getDatabaseTotals(params) }).send();
    }

    static async getStatMedia(ctx: RouterContext, _: Next) {
        const { only } = ctx.request.query;

        const params: any = {};
        if (only) {
            params.only = (only as string).split(",");
        }

        return new Success(ctx, { data: await ServerInterface.getMediaTotals(params) }).send();
    }

    static async getStatMediaByChat(ctx: RouterContext, _: Next) {
        const { only } = ctx.request.query;

        const params: any = {};
        if (only) {
            params.only = (only as string).split(",");
        }

        return new Success(ctx, { data: await await ServerInterface.getMediaTotalsByChat(params) }).send();
    }

    static async getAlerts(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: await AlertsInterface.find() }).send();
    }

    static async markAsRead(ctx: RouterContext, _: Next) {
        const { ids } = ctx?.request?.body ?? {};
        if (isEmpty(ids)) throw new BadRequest({ message: "No alert IDs provided!" });
        return new Success(ctx, { data: await AlertsInterface.markAsRead(ids) }).send();
    }
}

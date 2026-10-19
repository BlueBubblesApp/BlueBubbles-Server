import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import { FCM_MAX_DATA_BYTES, fcmDataPayloadBytes, type FcmDataPayload } from "../src/server/services/fcmService/FcmPayload";

function envelope(type: string, data: unknown): FcmDataPayload {
    return { type, data: JSON.stringify(data) };
}

function message(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        guid: "message-guid",
        text: "hello",
        subject: "subject",
        dateCreated: 123456789,
        isFromMe: false,
        itemType: 0,
        attachments: [],
        chats: [{ guid: "chat-guid", displayName: "Group", participants: [] }],
        ...overrides
    };
}

test("sendNotification passes only bounded valid data to the Admin SDK", async t => {
    const sent: any[] = [];
    const fakeApp = {
        messaging: () => ({
            sendEachForMulticast: async (payload: any) => {
                sent.push(payload);
                return { responses: [], successCount: 1, failureCount: 0 };
            }
        })
    };
    const noOpDecorator = () => (_target: unknown, _key: string, descriptor: PropertyDescriptor) => descriptor;
    const stubs: Record<string, any> = {
        "firebase-admin": { app: () => fakeApp, apps: [] },
        "@server": { Server: () => ({}) },
        "@server/fileSystem": { FileSystem: {} },
        "@server/helpers/utils": { isEmpty: (value: unknown) => value == null || value === "" },
        "@server/lib/ScheduledService": { ScheduledService: class {} },
        "@server/lib/logging/Loggable": {
            Loggable: class {
                log = { debug() {}, info() {}, warn() {}, error() {} };
            }
        },
        "@server/lib/decorators/AsyncSingletonDecorator": { AsyncSingleton: noOpDecorator },
        "@server/lib/decorators/AsyncRetryerDecorator": { AsyncRetryer: noOpDecorator },
        "@server/databases/server/constants": { ProxyServices: {} }
    };
    const originalLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
        return Object.prototype.hasOwnProperty.call(stubs, request)
            ? stubs[request]
            : originalLoad.call(this, request, parent, isMain);
    };
    t.after(() => {
        (Module as any)._load = originalLoad;
    });

    const { FCMService } = await import("../src/server/services/fcmService");
    const service = new FCMService();
    service.hasInitialized = true;

    const oversizedValid = envelope(
        "new-message",
        message({ chats: [{ guid: "chat-guid", displayName: "Group", participants: [{ address: "x".repeat(5000) }] }] })
    );
    await service.sendNotification(["device-token"], oversizedValid, "high");

    assert.equal(sent.length, 1);
    assert.ok(fcmDataPayloadBytes(sent[0].data) <= FCM_MAX_DATA_BYTES);
    assert.equal(JSON.parse(sent[0].data.data).text, "hello");

    await service.sendNotification(["device-token"], envelope("new-message", { guid: "m" }));
    await service.sendNotification(
        ["device-token"],
        envelope("updated-message", message({ chats: undefined, subject: "🙂".repeat(2000) }))
    );

    assert.equal(sent.length, 1, "invalid and irreducible payloads must not reach the Admin SDK");
});

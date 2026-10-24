import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_READ_STATUS_CHANGED, NEW_MESSAGE } from "../src/server/events";
import { resolveFcmPriority } from "../src/server/services/fcmService/FcmPriority";

test("upgrades only chat read-state events to high FCM priority", () => {
    assert.equal(resolveFcmPriority(CHAT_READ_STATUS_CHANGED, "normal"), "high");
    assert.equal(resolveFcmPriority(NEW_MESSAGE, "normal"), "normal");
    assert.equal(resolveFcmPriority(NEW_MESSAGE, "high"), "high");
});

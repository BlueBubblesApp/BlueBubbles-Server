import assert from "node:assert/strict";
import test from "node:test";

import { isChatFilteredAsSpam } from "../src/server/api/serializers/chatSpam";

test("a chat Messages categorized as spam (SMSCategory 1) is filtered as spam", () => {
    assert.equal(isChatFilteredAsSpam([{ SMSCategory: 1, wasDetectedAsSMSSpam: false }]), true);
});

test("a chat Messages detected as SMS spam is filtered as spam", () => {
    assert.equal(isChatFilteredAsSpam([{ wasDetectedAsSMSSpam: true }]), true);
});

test("any properties entry marking spam is enough", () => {
    assert.equal(isChatFilteredAsSpam([{ SMSCategory: 0 }, { SMSCategory: 1 }]), true);
});

test("a chat in category 0 is not spam", () => {
    assert.equal(isChatFilteredAsSpam([{ SMSCategory: 0, wasDetectedAsSMSSpam: false }]), false);
});

test("a chat without spam keys is not spam", () => {
    assert.equal(isChatFilteredAsSpam([{ hasViewedPotentialSpamChat: false }]), false);
});

test("null, undefined, and empty properties are not spam", () => {
    assert.equal(isChatFilteredAsSpam(null), false);
    assert.equal(isChatFilteredAsSpam(undefined), false);
    assert.equal(isChatFilteredAsSpam([]), false);
});

test("non-dict entries are ignored", () => {
    assert.equal(isChatFilteredAsSpam([null, "x", 1] as any), false);
});

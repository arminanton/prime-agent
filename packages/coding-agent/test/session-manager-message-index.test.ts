import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

describe("SessionManager message entry index", () => {
	it("finds an appended message entry by message object identity", () => {
		const manager = SessionManager.inMemory();
		const message = { role: "user" as const, content: "hello", timestamp: Date.now() };

		const entryId = manager.appendMessage(message);

		expect(manager.getMessageEntry(message)).toBe(manager.getEntry(entryId));
		expect(manager.getMessageEntry({ ...message })).toBeUndefined();
	});

	it("keeps the first entry when the same message object is appended twice", () => {
		const manager = SessionManager.inMemory();
		const message = { role: "user" as const, content: "duplicate", timestamp: Date.now() };

		const firstEntryId = manager.appendMessage(message);
		manager.appendMessage(message);

		expect(manager.getMessageEntry(message)).toBe(manager.getEntry(firstEntryId));
	});

	it("rebuilds the index and drops pruned messages when creating a branch", () => {
		const manager = SessionManager.inMemory();
		const keptMessage = { role: "user" as const, content: "keep", timestamp: Date.now() };
		const prunedMessage = { role: "user" as const, content: "prune", timestamp: Date.now() + 1 };
		const keptEntryId = manager.appendMessage(keptMessage);
		manager.appendMessage(prunedMessage);

		manager.createBranchedSession(keptEntryId);

		expect(manager.getMessageEntry(keptMessage)).toBe(manager.getEntry(keptEntryId));
		expect(manager.getMessageEntry(prunedMessage)).toBeUndefined();
	});
});

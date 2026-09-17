import type { Api, Message } from "../types.js";

// Request identity from the GitHub Copilot CLI 1.0.84-5.

// COPILOT_CLI_VERSION does not change the CLI package identity on the wire.
export const COPILOT_CLI_VERSION_FALLBACK = "1.0.84-5";

const COPILOT_API_VERSION_FALLBACK = "2026-08-01";

export const COPILOT_INTEGRATION_ID_DEFAULT = "copilot-developer-cli";

// X-Initiator varies by turn; X-Interaction-Type does not.
const COPILOT_INTERACTION_TYPE = "conversation-user";

const COPILOT_HARNESS_ID = "copilot-sdk";

const COPILOT_INTENT_DEFAULT = "conversation-agent";

function env(name: string): string {
	if (typeof process === "undefined") return "";
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

export function copilotIntegrationId(): string {
	return env("GITHUB_COPILOT_INTEGRATION_ID") || COPILOT_INTEGRATION_ID_DEFAULT;
}

export function copilotCliVersion(): string {
	return COPILOT_CLI_VERSION_FALLBACK;
}

export function copilotApiVersion(): string {
	return env("COPILOT_API_VERSION") || COPILOT_API_VERSION_FALLBACK;
}

const STATIC_IDENTITY_HEADERS: ReadonlySet<string> = new Set([
	"user-agent",
	"editor-version",
	"copilot-integration-id",
]);

/** Remove stale static headers before overlaying the current CLI identity. */
export function sanitizeCopilotModelHeaders(
	headers: Record<string, string> | undefined,
	api: Api,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter(([name]) => {
			const normalized = name.toLowerCase();
			if (normalized === "editor-plugin-version") return false;
			if (STATIC_IDENTITY_HEADERS.has(normalized)) return false;
			return api !== "anthropic-messages" || normalized !== "openai-intent";
		}),
	);
}

// The SDKs accept null values to omit their default fingerprint headers.
export const COPILOT_SDK_HEADER_OVERRIDES: Readonly<Record<string, string | null>> = {
	"X-Stainless-Lang": null,
	"X-Stainless-Package-Version": null,
	"X-Stainless-OS": null,
	"X-Stainless-Arch": null,
	"X-Stainless-Runtime": null,
	"X-Stainless-Runtime-Version": null,
	"X-Stainless-Retry-Count": null,
	"X-Stainless-Timeout": null,
};

function nodePlatform(): string {
	return typeof process !== "undefined" && process.platform ? process.platform : "linux";
}

// The official CLI reports its embedded Node version, not the host runtime.
const COPILOT_CLI_EMBEDDED_NODE_VERSION = "v24.20.0";

function nodeVersion(): string {
	const override = env("COPILOT_NODE_VERSION");
	if (override) return override.startsWith("v") ? override : `v${override}`;
	return COPILOT_CLI_EMBEDDED_NODE_VERSION;
}

function termProgram(): string {
	return env("COPILOT_TERM_PROGRAM") || env("TERM_PROGRAM") || "unknown";
}

// Inference adds client/github/cli; control-plane calls omit it.
export function copilotControlPlaneUserAgent(): string {
	const version = copilotCliVersion();
	const platform = nodePlatform();
	const node = nodeVersion();
	const term = termProgram();
	return `copilot/${version} (${platform} ${node}) term/${term}`;
}

export function copilotUserAgent(): string {
	return `${copilotControlPlaneUserAgent()} client/github/cli`;
}

// Avoid Node imports so the browser entry point can build correlation ids.
function randomId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}

	const bytes = new Uint8Array(16);
	if (typeof globalThis.crypto?.getRandomValues === "function") {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// Browsers persist the machine id. Node callers can set COPILOT_MACHINE_ID
// for stability across processes; otherwise it lasts for this process.
let machineIdMemo: string | undefined;
const COPILOT_MACHINE_ID_STORAGE_KEY = "prime.copilot.machine-id";

function copilotMachineId(): string {
	const override = env("COPILOT_MACHINE_ID");
	if (override) return override;
	if (machineIdMemo) return machineIdMemo;

	try {
		const existing = globalThis.localStorage?.getItem(COPILOT_MACHINE_ID_STORAGE_KEY)?.trim();
		if (existing) {
			machineIdMemo = existing;
			return existing;
		}
	} catch {
		// local storage can be unavailable or blocked
	}

	const generated = randomId();
	machineIdMemo = generated;
	try {
		globalThis.localStorage?.setItem(COPILOT_MACHINE_ID_STORAGE_KEY, generated);
	} catch {
		// process-local stability is sufficient when storage is unavailable
	}
	return generated;
}

export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

// Keep interaction and task ids across tool follow-ups, then rotate them on
// the next user turn. Bound the cache for clients with many conversations.
const turnIdsBySession = new Map<string, { interactionId: string; taskId: string }>();
const MAX_TRACKED_TURN_SESSIONS = 512;

function copilotTurnIds(
	sessionId: string | undefined,
	initiator: "user" | "agent",
): { interactionId: string; taskId: string } {
	if (!sessionId) return { interactionId: randomId(), taskId: randomId() };
	const current = turnIdsBySession.get(sessionId);
	if (initiator === "agent" && current) return current;
	const fresh = { interactionId: randomId(), taskId: randomId() };
	if (!turnIdsBySession.has(sessionId) && turnIdsBySession.size >= MAX_TRACKED_TURN_SESSIONS) {
		const oldest = turnIdsBySession.keys().next().value;
		if (oldest !== undefined) turnIdsBySession.delete(oldest);
	}
	turnIdsBySession.set(sessionId, fresh);
	return fresh;
}

/** Catalog calls do not carry session, task, repository, or SDK headers. */
export function buildCopilotCatalogHeaders(): Record<string, string> {
	return {
		"User-Agent": copilotControlPlaneUserAgent(),
		"Copilot-Integration-Id": copilotIntegrationId(),
		"Editor-Version": `copilot/${copilotCliVersion()}`,
		"X-GitHub-Api-Version": copilotApiVersion(),
		"Copilot-Harness-Id": COPILOT_HARNESS_ID,
		"X-Client-Machine-Id": copilotMachineId(),
		"X-Interaction-Id": randomId(),
		"X-Initiator": "user",
		"Openai-Intent": COPILOT_INTENT_DEFAULT,
		Accept: "application/json",
		"Content-Type": "application/json",
	};
}

export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
	api?: Api;
	sessionId?: string;
	isStreaming?: boolean;
}): Record<string, string> {
	const initiator = inferCopilotInitiator(params.messages);

	const turnIds = copilotTurnIds(params.sessionId, initiator);
	const headers: Record<string, string> = {
		"User-Agent": copilotUserAgent(),
		"Copilot-Integration-Id": copilotIntegrationId(),
		"Editor-Version": `copilot/${copilotCliVersion()}`,
		"X-GitHub-Api-Version": copilotApiVersion(),
		"X-Initiator": initiator,
		"X-Interaction-Type": COPILOT_INTERACTION_TYPE,
		"Copilot-Harness-Id": COPILOT_HARNESS_ID,
		"X-Client-Machine-Id": copilotMachineId(),
		"X-Interaction-Id": turnIds.interactionId,
		"X-Client-Session-Id": params.sessionId || randomId(),
		"X-Agent-Task-Id": turnIds.taskId,
		"X-GitHub-Repository-Nwo": "__no_repository__",
		"X-GitHub-Repository-Host": "__no_repository__",
	};

	if (params.api !== "anthropic-messages") {
		headers["Openai-Intent"] = COPILOT_INTENT_DEFAULT;
	}

	if (params.isStreaming !== false) {
		// OpenAI SDK (stainless) signature the CLI carries on streamed turns.
		headers["X-Stainless-Helper-Method"] = "stream";
	}

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}

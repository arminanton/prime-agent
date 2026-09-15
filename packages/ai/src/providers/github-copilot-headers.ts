import type { Api, Message } from "../types.js";

/**
 * GitHub Copilot request identity.
 *
 * The ordinary first-turn fields below were captured from the official
 * `@github/copilot` CLI 1.0.84-5 across `/responses`, `/chat/completions`, and
 * `/v1/messages`. Conditional fields found in the executable but not observed
 * on those requests are documented separately and are not synthesized.
 */

// Package version embedded in the authoritative executable and used for its
// User-Agent and Editor-Version. COPILOT_CLI_VERSION changes CLI behavior but
// does not change this package identity on the wire.
export const COPILOT_CLI_VERSION_FALLBACK = "1.0.84-5";

// Exact API version captured on 1.0.84-5 catalog and inference requests.
// Context tier selection changes client-side limits, not this header.
const COPILOT_API_VERSION_FALLBACK = "2026-08-01";

// The CLI integration id. The official executable reads this override name.
export const COPILOT_INTEGRATION_ID_DEFAULT = "copilot-developer-cli";

// Fixed interaction type. X-Initiator, rather than Openai-Intent, identifies
// whether the current turn was initiated by the user or agent.
const COPILOT_INTERACTION_TYPE = "conversation-user";

// Harness id the CLI carries on every inference call.
const COPILOT_HARNESS_ID = "copilot-sdk";

// Default intent for an agentic turn. The official CLI sends conversation-agent
// on agent-driven calls; conversation-edits is the older VS Code Chat value and
// is not what the CLI presents.
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

/** Remove stale static headers before overlaying the current CLI identity. */
export function sanitizeCopilotModelHeaders(
	headers: Record<string, string> | undefined,
	api: Api,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter(([name]) => {
			const normalized = name.toLowerCase();
			if (normalized === "editor-plugin-version") return false;
			return api !== "anthropic-messages" || normalized !== "openai-intent";
		}),
	);
}

/**
 * Map to Node's process.platform tokens. The CLI builds its User-Agent from
 * process.platform (linux/darwin/win32), which is exactly what Node reports.
 */
function nodePlatform(): string {
	return typeof process !== "undefined" && process.platform ? process.platform : "linux";
}

// Node runtime embedded in the official CLI's single-executable build. The CLI
// reports this token, not the host's Node, so the default follows the binary.
const COPILOT_CLI_EMBEDDED_NODE_VERSION = "v24.20.0";

function nodeVersion(): string {
	const override = env("COPILOT_NODE_VERSION");
	if (override) return override.startsWith("v") ? override : `v${override}`;
	return COPILOT_CLI_EMBEDDED_NODE_VERSION;
}

/** TERM_PROGRAM token for the User-Agent, including the CLI's `unknown` fallback. */
function termProgram(): string {
	return env("COPILOT_TERM_PROGRAM") || env("TERM_PROGRAM") || "unknown";
}

/**
 * Control-plane User-Agent captured from the CLI. Inference adds the
 * `client/github/cli` suffix below.
 */
export function copilotControlPlaneUserAgent(): string {
	const version = copilotCliVersion();
	const platform = nodePlatform();
	const node = nodeVersion();
	const term = termProgram();
	if (node) return `copilot/${version} (${platform} ${node}) term/${term}`;
	return `copilot/${version}`;
}

export function copilotUserAgent(): string {
	return `${copilotControlPlaneUserAgent()} client/github/cli`;
}

/**
 * Generate request correlation ids without importing Node built-ins so the
 * provider remains usable from the browser entry point.
 */
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

/**
 * Stable request identity. Browsers persist it in local storage. Node callers
 * can provide COPILOT_MACHINE_ID for cross-process stability; otherwise it is
 * stable for the life of the process.
 */
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

/**
 * Build the full per-request Copilot identity header set.
 *
 * Provider callers remove obsolete static identity fields and then overlay
 * this set. Explicit per-request headers can still override it by design.
 *
 * @param params.messages    - the conversation, used to infer initiator + vision
 * @param params.hasImages   - whether the turn carries image input
 * @param params.sessionId   - stable per-conversation id (maps to X-Client-Session-Id)
 * @param params.isStreaming - whether this is a streamed request (adds the SDK marker)
 *
 * The 1.0.84-5 binary also contains conditional candidates
 * `X-Parent-Agent-Id`, `X-GitHub-User`, `X-GitHub-Actor-Type`, `Request-HMAC`,
 * `X-Copilot-API-Exp-Assignment-Context`, `X-Copilot-Service-Request-Id`,
 * `X-GitHub-Copilot-Request-TE`, and `Copilot-Subsystem-Id`. Ordinary
 * first-turn captures did not send them. The assignment-context and service
 * request id were observed as response headers, so we do not synthesize any of
 * these request headers. The same rule applies to the candidate body fields
 * `previous_response_id`, `prompt_cache_options`, `cache_ttl_seconds`, and
 * `service_tier`. `long_context` is a client-side catalog/session tier and was
 * not observed as an inference header or body field.
 */
export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
	api?: Api;
	sessionId?: string;
	isStreaming?: boolean;
}): Record<string, string> {
	const initiator = inferCopilotInitiator(params.messages);

	const headers: Record<string, string> = {
		"User-Agent": copilotUserAgent(),
		"Copilot-Integration-Id": copilotIntegrationId(),
		"Editor-Version": `copilot/${copilotCliVersion()}`,
		"X-GitHub-Api-Version": copilotApiVersion(),
		"X-Initiator": initiator,
		"X-Interaction-Type": COPILOT_INTERACTION_TYPE,
		"Copilot-Harness-Id": COPILOT_HARNESS_ID,
		"X-Client-Machine-Id": copilotMachineId(),
		"X-Interaction-Id": randomId(),
		"X-Client-Session-Id": params.sessionId || randomId(),
		"X-Agent-Task-Id": randomId(),
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

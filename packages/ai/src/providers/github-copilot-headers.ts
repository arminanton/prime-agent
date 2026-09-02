import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../types.js";

/**
 * GitHub Copilot request identity.
 *
 * These headers reproduce the identity the official `@github/copilot` CLI puts
 * on the wire for every inference call (MITM-captured across `/responses`,
 * `/chat/completions`, and `/v1/messages`). We match the CLI 1:1 rather than
 * sending a minimal subset: an incomplete header fingerprint is itself a
 * flagging signal, so parity is the anti-block posture.
 *
 * The single most important value is `Copilot-Integration-Id`. It (not the
 * User-Agent, not any `X-Copilot-Agent-Slug`) is what the GitHub backend keys
 * the visible model catalog and per-model limits off of. `copilot-developer-cli`
 * is the identity that exposes the full catalog (gemini-3.x, gpt-5.x with the
 * full reasoning-effort range, claude-opus with low..max) when the request
 * carries a valid GitHub bearer token. The previous `vscode-chat` identity
 * served a strictly smaller catalog.
 *
 * Every value here can be overridden through an environment variable so an
 * install that needs a different fingerprint can supply one without a rebuild.
 */

// Latest released @github/copilot CLI version. Used for the User-Agent and
// Editor-Version we present. Kept as a static fallback; the real CLI updates
// this whenever the user updates their install.
const COPILOT_CLI_VERSION_FALLBACK = "1.0.81-6";

// X-GitHub-Api-Version literal the CLI's Rust core carries in capi_client.rs.
// As of CLI 1.0.81-6 the per-model catalog limits are byte-identical across
// recent api-version values (the long-context tier is now selected server-side
// by token count), so this is an identity-parity value, not a tier lever.
const COPILOT_API_VERSION_FALLBACK = "2026-08-01";

// The integration id that unlocks the full premium catalog. Override with
// COPILOT_INTEGRATION_ID for an account that needs a different integrator.
const COPILOT_INTEGRATION_ID_DEFAULT = "copilot-developer-cli";

// Fixed literal the CLI sends in every request (this is NOT the Openai-Intent
// value, which is conversation-agent / conversation-user depending on turn).
const COPILOT_INTERACTION_TYPE = "conversation-user";

// Harness id the CLI carries on every inference call.
const COPILOT_HARNESS_ID = "copilot-sdk";

// Default intent for an agentic turn. The official CLI sends conversation-agent
// on agent-driven calls; conversation-edits is the older VS Code Chat value and
// is not what the CLI presents.
const COPILOT_INTENT_DEFAULT = "conversation-agent";

function env(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

export function copilotIntegrationId(): string {
	return env("COPILOT_INTEGRATION_ID") || COPILOT_INTEGRATION_ID_DEFAULT;
}

export function copilotCliVersion(): string {
	return env("COPILOT_CLI_VERSION") || COPILOT_CLI_VERSION_FALLBACK;
}

export function copilotApiVersion(): string {
	return env("COPILOT_API_VERSION") || COPILOT_API_VERSION_FALLBACK;
}

/**
 * Map to Node's process.platform tokens. The CLI builds its User-Agent from
 * process.platform (linux/darwin/win32), which is exactly what Node reports.
 */
function nodePlatform(): string {
	return typeof process !== "undefined" && process.platform ? process.platform : "linux";
}

function nodeVersion(): string {
	const override = env("COPILOT_NODE_VERSION");
	if (override) return override.startsWith("v") ? override : `v${override}`;
	if (typeof process !== "undefined" && process.version) return process.version;
	return "";
}

/**
 * TERM_PROGRAM token for the User-Agent. A real value is the most authentic;
 * fall back to "vscode" (a valid, common Copilot CLI host) rather than the
 * CLI's literal "unknown" fallback, which reads as a non-interactive/bot signal.
 */
function termProgram(): string {
	return env("COPILOT_TERM_PROGRAM") || env("TERM_PROGRAM") || "vscode";
}

/**
 * User-Agent presented to api.githubcopilot.com. Reproduces the CLI's builder:
 *   copilot/<ver> (<platform> <node-version>) term/<TERM_PROGRAM>
 * Falls back to the honest short core `copilot/<ver>` if the node runtime cannot
 * be resolved, rather than inventing a runtime string.
 */
export function copilotUserAgent(): string {
	const version = copilotCliVersion();
	const platform = nodePlatform();
	const node = nodeVersion();
	const term = termProgram();
	if (node) {
		return `copilot/${version} (${platform} ${node}) term/${term}`;
	}
	return `copilot/${version}`;
}

/**
 * Stable per-install device id. Persisted so it is identical across calls and
 * process restarts, exactly like the CLI's X-Client-Machine-Id. Stored under
 * the prime config dir; a generated-but-unpersisted value is used if the disk
 * is not writable.
 */
let machineIdMemo: string | undefined;

function copilotMachineId(): string {
	const override = env("COPILOT_MACHINE_ID");
	if (override) return override;
	if (machineIdMemo) return machineIdMemo;

	const path = join(homedir(), ".prime", "copilot_machine_id");
	try {
		if (existsSync(path)) {
			const existing = readFileSync(path, "utf-8").trim();
			if (existing) {
				machineIdMemo = existing;
				return existing;
			}
		}
	} catch {
		// fall through to generate
	}

	const generated = randomUUID();
	try {
		mkdirSync(join(homedir(), ".prime"), { recursive: true });
		writeFileSync(path, generated);
	} catch {
		// non-fatal: use the in-memory value for this process
	}
	machineIdMemo = generated;
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
 * These are merged LAST over any static `model.headers` in every provider
 * (openai-responses, openai-completions, anthropic), so this is the effective
 * identity on the wire and the single source of truth for it.
 *
 * @param params.messages    - the conversation, used to infer initiator + vision
 * @param params.hasImages   - whether the turn carries image input
 * @param params.sessionId   - stable per-conversation id (maps to X-Client-Session-Id)
 * @param params.isStreaming - whether this is a streamed request (adds the SDK marker)
 */
export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
	sessionId?: string;
	isStreaming?: boolean;
}): Record<string, string> {
	const initiator = inferCopilotInitiator(params.messages);

	const headers: Record<string, string> = {
		"User-Agent": copilotUserAgent(),
		"Copilot-Integration-Id": copilotIntegrationId(),
		"Editor-Version": `copilot/${copilotCliVersion()}`,
		"X-GitHub-Api-Version": copilotApiVersion(),
		"Openai-Intent": COPILOT_INTENT_DEFAULT,
		"X-Initiator": initiator,
		"X-Interaction-Type": COPILOT_INTERACTION_TYPE,
		"Copilot-Harness-Id": COPILOT_HARNESS_ID,
		"X-Client-Machine-Id": copilotMachineId(),
		"X-Interaction-Id": randomUUID(),
		"X-Client-Session-Id": params.sessionId || randomUUID(),
		"X-Agent-Task-Id": randomUUID(),
		"X-GitHub-Repository-Nwo": "__no_repository__",
		"X-GitHub-Repository-Host": "__no_repository__",
	};

	if (params.isStreaming !== false) {
		// OpenAI SDK (stainless) signature the CLI carries on streamed turns.
		headers["X-Stainless-Helper-Method"] = "stream";
	}

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}

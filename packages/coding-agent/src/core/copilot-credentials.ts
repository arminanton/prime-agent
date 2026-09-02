/**
 * GitHub Copilot credential pinning.
 *
 * On a host with several `gh` accounts (or ambient GH_TOKEN / GITHUB_TOKEN
 * exported in the shell), we must be able to pin the Copilot harness to ONE
 * specific GitHub user and domain, so that switching the active `gh` account or
 * exporting a different token in the shell cannot silently redirect Copilot
 * requests to the wrong identity.
 *
 * Resolution order (first hit wins):
 *   1. COPILOT_GITHUB_TOKEN            explicit pinned token, always wins
 *   2. `gh auth token` with pinning    when COPILOT_GH_USER or COPILOT_GH_HOST
 *                                      is set, resolve from gh's own credential
 *                                      store for that user/host, with ambient
 *                                      GH_TOKEN / GITHUB_TOKEN stripped from the
 *                                      subprocess env so gh reads hosts.yml
 *                                      instead of echoing the shell token back
 *   3. GH_TOKEN / GITHUB_TOKEN         ambient fallback (only when no pin is
 *                                      configured), preserving prior behavior
 *
 * Env vars (mirrors the Hermes Copilot integration):
 *   COPILOT_GITHUB_TOKEN  explicit token to use verbatim
 *   COPILOT_GH_USER       gh account (login) to resolve via `gh auth token --user`
 *   COPILOT_GH_HOST       gh hostname to resolve via `gh auth token --hostname`
 *                         (also selects the enterprise Copilot domain)
 */

import { spawnSync } from "child_process";
import {
	copilotApiVersion,
	copilotCliVersion,
	copilotIntegrationId,
	copilotUserAgent,
} from "@earendil-works/pi-ai";

const COPILOT_PIN_TOKEN_ENV = "COPILOT_GITHUB_TOKEN";
const COPILOT_GH_USER_ENV = "COPILOT_GH_USER";
const COPILOT_GH_HOST_ENV = "COPILOT_GH_HOST";
const AMBIENT_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

// Classic PATs (ghp_) are not accepted by the Copilot API.
const CLASSIC_PAT_PREFIX = "ghp_";

function readEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

export function copilotPinnedUser(): string {
	return readEnv(COPILOT_GH_USER_ENV);
}

export function copilotPinnedHost(): string {
	return readEnv(COPILOT_GH_HOST_ENV);
}

/** True when a specific gh user or host is pinned for Copilot. */
export function hasCopilotPin(): boolean {
	return Boolean(copilotPinnedUser() || copilotPinnedHost());
}

/**
 * A stable identity string for the pinned Copilot account, used for auth-source
 * change detection (so switching the pinned user/host or the explicit token
 * invalidates a resumed session's model auth). Does NOT include the token value
 * itself; the value fingerprint is derived separately from the resolved token.
 */
export function copilotPinIdentity(): string {
	const explicit = readEnv(COPILOT_PIN_TOKEN_ENV);
	if (isUsableCopilotToken(explicit)) {
		return "github-copilot:pin:token";
	}
	const host = copilotPinnedHost() || "github.com";
	const user = copilotPinnedUser();
	return `github-copilot:pin:${host}:${user}`;
}

/**
 * The Copilot API base URL to use when a pinned raw GitHub token is in play.
 *
 * A raw `gho_` / `github_pat_` token has no embedded `proxy-ep`, so the account
 * cannot be routed to its per-plan host (api.individual.githubcopilot.com), and
 * that host answers a raw token with 421 Misdirected Request. The shared front
 * door api.githubcopilot.com accepts the raw token and serves the account's full
 * catalog, so we target it for github.com. For an enterprise host we use the
 * enterprise Copilot API domain.
 *
 * Returns undefined when no pin is configured, so the model's declared baseUrl
 * (the per-plan host, used with the exchanged tid= token from OAuth) is left
 * untouched.
 */
export function copilotPinnedBaseUrl(): string | undefined {
	if (!hasCopilotPin() && !isUsableCopilotToken(readEnv(COPILOT_PIN_TOKEN_ENV))) {
		return undefined;
	}
	const host = copilotPinnedHost();
	if (host && host !== "github.com") {
		return `https://copilot-api.${host}`;
	}
	return "https://api.githubcopilot.com";
}

function isUsableCopilotToken(token: string): boolean {
	return Boolean(token) && !token.startsWith(CLASSIC_PAT_PREFIX);
}

/**
 * Resolve a token from `gh auth token`, pinning the host and/or user so a
 * multi-account box returns the intended identity regardless of which account
 * is currently active. Returns undefined when gh is unavailable or has no token
 * for the requested user/host.
 */
function resolveGhCliToken(): string | undefined {
	const host = copilotPinnedHost();
	const user = copilotPinnedUser();

	// Strip ambient tokens so gh reads its own credential store (hosts.yml)
	// rather than short-circuiting and echoing the shell token back.
	const cleanEnv: Record<string, string | undefined> = { ...process.env };
	for (const name of AMBIENT_TOKEN_ENV_VARS) {
		delete cleanEnv[name];
	}

	const args = ["auth", "token"];
	if (host) args.push("--hostname", host);
	if (user) args.push("--user", user);

	try {
		const result = spawnSync("gh", args, {
			encoding: "utf-8",
			timeout: 5000,
			env: cleanEnv,
		});
		if (result.status === 0) {
			const token = (result.stdout ?? "").trim();
			if (isUsableCopilotToken(token)) {
				return token;
			}
		}
	} catch {
		// gh not installed or failed — fall through to ambient resolution.
	}
	return undefined;
}

/**
 * Resolve the Copilot GitHub token for this process, honoring an explicit pin
 * and, when a gh user/host is pinned, the gh credential store for that identity.
 * Returns undefined when nothing usable is configured, so the caller can fall
 * back to stored auth.json / OAuth credentials.
 */
export function resolvePinnedCopilotToken(): string | undefined {
	// 1. Explicit pinned token always wins.
	const explicit = readEnv(COPILOT_PIN_TOKEN_ENV);
	if (isUsableCopilotToken(explicit)) {
		return explicit;
	}

	// 2. When a user/host is pinned, resolve strictly from gh for that identity.
	//    Do NOT fall back to ambient GH_TOKEN / GITHUB_TOKEN here: the whole
	//    point of pinning is that the wrong ambient token must not leak in.
	if (hasCopilotPin()) {
		return resolveGhCliToken();
	}

	// 3. No pin configured: preserve the prior ambient behavior.
	for (const name of AMBIENT_TOKEN_ENV_VARS) {
		const token = readEnv(name);
		if (isUsableCopilotToken(token)) {
			return token;
		}
	}

	return undefined;
}

/**
 * Live Copilot catalog info for the active account: the set of entitled model
 * ids and, per id, the api mode derived from the model's declared
 * `supported_endpoints`. Prime's baked catalog is a superset of any single
 * account's entitlements (so unentitled models 400), and its api-mode routing
 * uses name-prefix heuristics that can misroute newer models (e.g. grok and the
 * mai-code/oswe family are `/responses`-only, but a completions guess 400s with
 * "not accessible via the /chat/completions endpoint"). Reading the live
 * endpoints fixes both classes at the source.
 */
export interface CopilotCatalogInfo {
	/** Model ids the account is entitled to. Empty on failure (caller keeps full catalog). */
	ids: Set<string>;
	/** id -> api mode derived from supported_endpoints. Only ids with a clear signal are present. */
	apiById: Map<string, CopilotApiMode>;
}

export type CopilotApiMode = "anthropic-messages" | "openai-responses" | "openai-completions";

/**
 * Map a model's `supported_endpoints` to the api mode prime should use.
 *   - `/v1/messages` present            -> anthropic-messages (Claude)
 *   - `/responses` present (no messages) -> openai-responses (gpt-5.x, grok, mai-code)
 *   - only `/chat/completions`          -> openai-completions (gemini, etc.)
 * Anthropic wins when both messages and completions are offered because prime
 * proxies Claude through the Anthropic Messages API. Responses wins over
 * completions because the responses API is the richer superset and is the only
 * one that works for responses-only models.
 */
export function copilotApiModeFromEndpoints(endpoints: string[]): CopilotApiMode | undefined {
	const set = new Set(endpoints.map((e) => e.replace(/^ws:/, "")));
	if (set.has("/v1/messages")) {
		return "anthropic-messages";
	}
	if (set.has("/responses")) {
		return "openai-responses";
	}
	if (set.has("/chat/completions")) {
		return "openai-completions";
	}
	return undefined;
}

/**
 * Fetch the account's live Copilot catalog: entitled ids + per-model api routing
 * derived from `supported_endpoints`. Uses the front-door base URL (accepts a raw
 * pinned gh token) with the full CLI identity headers so the result matches what
 * inference actually serves. Returns empty structures on any failure so the
 * caller falls back to the baked catalog rather than hiding everything.
 */
export async function fetchCopilotCatalogInfo(
	token: string,
	options?: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch },
): Promise<CopilotCatalogInfo> {
	const empty: CopilotCatalogInfo = { ids: new Set(), apiById: new Map() };
	const base = options?.baseUrl ?? copilotPinnedBaseUrl() ?? "https://api.githubcopilot.com";
	const fetchFn = options?.fetchFn ?? fetch;
	const timeoutMs = options?.timeoutMs ?? 6000;
	try {
		const resp = await fetchFn(`${base}/models`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": copilotUserAgent(),
				"Editor-Version": `copilot/${copilotCliVersion()}`,
				"Copilot-Integration-Id": copilotIntegrationId(),
				"X-GitHub-Api-Version": copilotApiVersion(),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!resp.ok) {
			return empty;
		}
		const payload = (await resp.json()) as unknown;
		if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
			return empty;
		}
		const ids = new Set<string>();
		const apiById = new Map<string, CopilotApiMode>();
		for (const entry of payload.data) {
			if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
				continue;
			}
			ids.add(entry.id);
			const endpoints = (entry as { supported_endpoints?: unknown }).supported_endpoints;
			if (Array.isArray(endpoints)) {
				const api = copilotApiModeFromEndpoints(endpoints.filter((e): e is string => typeof e === "string"));
				if (api) {
					apiById.set(entry.id, api);
				}
			}
		}
		return { ids, apiById };
	} catch {
		return empty;
	}
}

/**
 * Back-compat: entitled ids only. Prefer {@link fetchCopilotCatalogInfo} for
 * routing-aware callers.
 */
export async function fetchCopilotEntitledModelIds(
	token: string,
	options?: { baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch },
): Promise<Set<string>> {
	return (await fetchCopilotCatalogInfo(token, options)).ids;
}

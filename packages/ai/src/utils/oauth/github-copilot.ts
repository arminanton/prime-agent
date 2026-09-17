import {
	buildCopilotCatalogHeaders,
	copilotApiVersion,
	copilotCliVersion,
	copilotControlPlaneUserAgent,
	copilotIntegrationId,
} from "../../providers/github-copilot-headers.js";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type CopilotCredentials = OAuthCredentials & {
	enterpriseUrl?: string;
};

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

// Read overrides per call, using the same identity as inference requests.
function copilotControlPlaneHeaders(): Record<string, string> {
	return {
		"User-Agent": copilotControlPlaneUserAgent(),
		"Editor-Version": `copilot/${copilotCliVersion()}`,
		"Copilot-Integration-Id": copilotIntegrationId(),
	};
}

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": copilotControlPlaneUserAgent(),
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		await abortableSleep(waitMs, signal);

		const raw = await fetchJson(urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": copilotControlPlaneUserAgent(),
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0 ? interval * 1000 : Math.max(1000, intervalMs + 5000);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
		}
	}

	if (slowDownResponses > 0) {
		throw new Error(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
		);
	}

	throw new Error("Device flow timed out");
}

export async function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredentials> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...copilotControlPlaneHeaders(),
		},
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	return {
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

interface UnconfiguredCopilotModel {
	id: string;
	terms?: string;
}

/** Return only live models whose policy explicitly requires enablement. */
async function getUnconfiguredGitHubCopilotModels(
	token: string,
	enterpriseDomain?: string,
): Promise<UnconfiguredCopilotModel[]> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const response = await fetch(`${baseUrl}/models`, {
		headers: { ...buildCopilotCatalogHeaders(), Authorization: `Bearer ${token}` },
	});
	if (!response.ok) return [];
	const payload = (await response.json()) as unknown;
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		return [];
	}
	return payload.data.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const { id, policy } = entry as {
			id?: unknown;
			policy?: { state?: unknown; terms?: unknown };
		};
		if (typeof id !== "string" || policy?.state !== "unconfigured") return [];
		return [{ id, ...(typeof policy.terms === "string" ? { terms: policy.terms } : {}) }];
	});
}

/** Enable one live model whose policy is explicitly unconfigured. */
async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${encodeURIComponent(modelId)}/policy`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...copilotControlPlaneHeaders(),
				"X-GitHub-Api-Version": copilotApiVersion(),
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Enable only live unconfigured entries after explicit terms acceptance. */
async function enableUnconfiguredGitHubCopilotModels(
	token: string,
	enterpriseDomain: string | undefined,
	confirm: (models: readonly UnconfiguredCopilotModel[]) => Promise<boolean>,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	let models: UnconfiguredCopilotModel[];
	try {
		models = await getUnconfiguredGitHubCopilotModels(token, enterpriseDomain);
	} catch {
		return;
	}
	if (models.length === 0 || !(await confirm(models))) return;
	await Promise.all(
		models.map(async (model) => {
			const success = await enableGitHubCopilotModel(token, model.id, enterpriseDomain);
			onProgress?.(model.id, success);
		}),
	);
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGitHubCopilot(options: {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) {
		throw new Error("Invalid GitHub Enterprise URL/domain");
	}
	const domain = enterpriseDomain || "github.com";

	const device = await startDeviceFlow(domain);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
	);
	const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain ?? undefined);

	options.onProgress?.("Checking model policies...");
	await enableUnconfiguredGitHubCopilotModels(
		credentials.access,
		enterpriseDomain ?? undefined,
		async (models) => {
			const details = models
				.map((model) => `- ${model.id}${model.terms ? `: ${model.terms.slice(0, 500)}` : ""}`)
				.join("\n")
				.slice(0, 4000);
			const answer = await options.onPrompt({
				message: `Enable these GitHub Copilot models and accept their listed terms?\n${details}\nType yes to accept`,
				placeholder: "yes",
				allowEmpty: true,
			});
			if (options.signal?.aborted) throw new Error("Login cancelled");
			return /^(?:y|yes)$/i.test(answer.trim());
		},
		(model, success) => options.onProgress?.(`${success ? "Enabled" : "Could not enable"} ${model}`),
	);
	return credentials;
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
	id: "github-copilot",
	name: "GitHub Copilot",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGitHubCopilot({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as CopilotCredentials;
		return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const creds = credentials as CopilotCredentials;
		const domain = creds.enterpriseUrl ? (normalizeDomain(creds.enterpriseUrl) ?? undefined) : undefined;
		const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
		return models.map((m) => (m.provider === "github-copilot" ? { ...m, baseUrl } : m));
	},
};

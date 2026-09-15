import { COPILOT_CLI_VERSION_FALLBACK, COPILOT_INTEGRATION_ID_DEFAULT } from "./providers/github-copilot-headers.js";

/**
 * Static client identity baked onto every generated Copilot catalog row and used
 * by the OAuth control-plane fallbacks. Prime presents as the official GitHub
 * Copilot CLI (`copilot-developer-cli`): that integration id unlocks the full
 * premium catalog and the 1M context tiers, while the VS Code Chat identity is
 * served a smaller catalog with reduced limits. The live per-request identity
 * (platform, node, term, session ids) is built in providers/github-copilot-headers.ts
 * and merged over these values on every call; keep both in sync by editing only
 * the constants there.
 */
export const COPILOT_CLIENT_USER_AGENT = `copilot/${COPILOT_CLI_VERSION_FALLBACK}`;

export const COPILOT_CLIENT_HEADERS = {
	"User-Agent": COPILOT_CLIENT_USER_AGENT,
	"Editor-Version": COPILOT_CLIENT_USER_AGENT,
	"Copilot-Integration-Id": COPILOT_INTEGRATION_ID_DEFAULT,
} as const;

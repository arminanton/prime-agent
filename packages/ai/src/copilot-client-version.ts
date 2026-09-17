import { COPILOT_CLI_VERSION_FALLBACK, COPILOT_INTEGRATION_ID_DEFAULT } from "./providers/github-copilot-headers.js";

// Use the CLI identity to access all the models that are actually available in the Copilot CLI.
// Keep catalog and OAuth headers in sync with the per-request identity.
export const COPILOT_CLIENT_USER_AGENT = `copilot/${COPILOT_CLI_VERSION_FALLBACK}`;

export const COPILOT_CLIENT_HEADERS = {
	"User-Agent": COPILOT_CLIENT_USER_AGENT,
	"Editor-Version": COPILOT_CLIENT_USER_AGENT,
	"Copilot-Integration-Id": COPILOT_INTEGRATION_ID_DEFAULT,
} as const;

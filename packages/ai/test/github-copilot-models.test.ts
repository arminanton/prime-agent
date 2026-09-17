import { describe, expect, it } from "vitest";
import { getModels } from "../src/models.js";

describe("GitHub Copilot catalog metadata", () => {
	const models = getModels("github-copilot");

	it("uses the CLI identity for every catalog entry", () => {
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.headers, model.id).toEqual({
				"User-Agent": "copilot/1.0.84-5",
				"Editor-Version": "copilot/1.0.84-5",
				"Copilot-Integration-Id": "copilot-developer-cli",
			});
		}
	});
});

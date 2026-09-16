import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, settleWithinBudget } from "../src/utils/settle-within-budget.js";

afterEach(() => vi.useRealTimers());

describe("settleWithinBudget", () => {
	it("returns a value and clears its timer", async () => {
		vi.useFakeTimers();
		expect(await settleWithinBudget("test", 100, Promise.resolve(42))).toMatchObject({ ok: true, value: 42 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains synchronous and asynchronous failures", async () => {
		vi.useFakeTimers();
		const error = new Error("failure");
		expect(await settleWithinBudget("test", 100, () => { throw error; })).toMatchObject({ ok: false, error, timedOut: false });
		expect(await settleWithinBudget("test", 100, Promise.reject(error))).toMatchObject({ ok: false, error, timedOut: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("times out without leaving an unobserved losing rejection", async () => {
		vi.useFakeTimers();
		let reject!: (error: Error) => void;
		const work = new Promise<void>((_resolve, rejectWork) => { reject = rejectWork; });
		const settled = settleWithinBudget("blocked", 50, work);
		await vi.advanceTimersByTimeAsync(50);
		expect(await settled).toMatchObject({ ok: false, timedOut: true, error: new BudgetExceededError("blocked", 50) });
		reject(new Error("late failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

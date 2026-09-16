import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, settleWithinBudget } from "../src/utils/settle-within-budget.js";

afterEach(() => vi.useRealTimers());

describe("settleWithinBudget", () => {
	it.each([Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])("clamps an oversized timer budget %s without an immediate timeout", async (budgetMs) => {
		vi.useFakeTimers();
		const timer = vi.spyOn(globalThis, "setTimeout");
		let finish!: () => void;
		const work = new Promise<void>((resolve) => { finish = resolve; });
		const result = settleWithinBudget("large timer", budgetMs, work);
		try {
			expect(timer).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
			await vi.advanceTimersByTimeAsync(1);
			finish();
			await expect(result).resolves.toMatchObject({ ok: true });
		} finally { timer.mockRestore(); }
	});
	it("calls a zero-argument factory without forwarding a promise callback argument", async () => {
		const factory = vi.fn(() => 42);
		expect(await settleWithinBudget("factory", 100, factory)).toMatchObject({ ok: true, value: 42 });
		expect(factory).toHaveBeenCalledWith();
	});
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

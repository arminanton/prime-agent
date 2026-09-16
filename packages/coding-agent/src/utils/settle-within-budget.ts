export class BudgetExceededError extends Error {
	constructor(readonly stage: string, readonly budgetMs: number) {
		super(`${stage} exceeded its ${budgetMs} ms shutdown budget`);
		this.name = "BudgetExceededError";
	}
}

export type SettleResult<T> =
	| { ok: true; value: T; elapsedMs: number }
	| { ok: false; error: unknown; timedOut: boolean; elapsedMs: number };

/**
 * Bound an await and observe late failures. This does not cancel losing work.
 * Callers must fence late side effects or retain ownership until process exit.
 * A factory starts only after the timer is armed and can throw synchronously.
 */
export async function settleWithinBudget<T>(
	stage: string,
	budgetMs: number,
	work: Promise<T> | (() => T | Promise<T>),
): Promise<SettleResult<T>> {
	const startedAt = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new BudgetExceededError(stage, budgetMs)), Math.max(0, budgetMs));
		timer.unref?.();
	});
	let pending: Promise<T> | undefined;
	try {
		pending = typeof work === "function" ? Promise.resolve().then(work) : work;
		const value = await Promise.race([pending, timeout]);
		return { ok: true, value, elapsedMs: performance.now() - startedAt };
	} catch (error) {
		return { ok: false, error, timedOut: error instanceof BudgetExceededError, elapsedMs: performance.now() - startedAt };
	} finally {
		if (timer) clearTimeout(timer);
		void pending?.catch(() => undefined);
	}
}

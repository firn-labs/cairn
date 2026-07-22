/**
 * Word-level diff, shared between server and client: the personality drift
 * guard (`server/engine/personality.ts`) uses `retainedRatio` to reject
 * rewrites, and the team page renders `wordDiff` so the Product Owner sees
 * every personality revision as a diff.
 */

export interface DiffOp {
	kind: 'same' | 'add' | 'del';
	text: string;
}

function tokenize(text: string): string[] {
	return text.split(/\s+/).filter(Boolean);
}

/** LCS length table for two token arrays; dp[i][j] = LCS of a[i..] and b[j..]. */
function lcsTable(a: string[], b: string[]): number[][] {
	const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	return dp;
}

/** Word-level diff of two texts. Consecutive ops of the same kind are merged. */
export function wordDiff(oldText: string, newText: string): DiffOp[] {
	const a = tokenize(oldText);
	const b = tokenize(newText);
	const dp = lcsTable(a, b);

	const ops: DiffOp[] = [];
	const push = (kind: DiffOp['kind'], text: string) => {
		const last = ops.at(-1);
		if (last && last.kind === kind) last.text += ` ${text}`;
		else ops.push({ kind, text });
	};

	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			push('same', a[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			push('del', a[i]);
			i++;
		} else {
			push('add', b[j]);
			j++;
		}
	}
	while (i < a.length) push('del', a[i++]);
	while (j < b.length) push('add', b[j++]);
	return ops;
}

/**
 * Fraction of the old text's words (case-insensitive, in order) that survive
 * in the new text — 1 means fully retained, 0 means nothing survived.
 * An empty old text counts as fully retained: growth from nothing is not drift.
 */
export function retainedRatio(oldText: string, newText: string): number {
	const a = tokenize(oldText.toLowerCase());
	if (a.length === 0) return 1;
	const b = tokenize(newText.toLowerCase());
	return lcsTable(a, b)[0][0] / a.length;
}

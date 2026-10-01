/** Types for `network-guard-core.mjs` (plain ESM so a spawned relay child can `--import` it). */
export declare function isLoopbackHost(host: unknown): boolean;
export declare function classifyConnect(args: unknown[]): { allowed: boolean; target: string };
export declare function installSocketGuard(refuse: (target: string) => Error): void;
export declare function installFetchGuard(refuse: (target: string) => Error): void;
export declare const CHILD_REFUSAL_MARKER: string;

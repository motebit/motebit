/** Types for `network-guard-core.mjs` (plain ESM so a spawned relay child can `--import` it). */
export declare function isLoopbackHost(host: unknown): boolean;
export declare function classifyConnect(args: unknown[]): { allowed: boolean; target: string };
export declare function installSocketGuard(refuse: (target: string) => Error): void;
export declare function installFetchGuard(refuse: (target: string) => Error): void;
export declare const CHILD_REFUSAL_MARKER: string;
export declare function classifyDgramSend(args: unknown[]): { allowed: boolean; target: string };
export declare function installDgramGuard(refuse: (target: string) => Error): void;
export declare const PROXY_ENV_VARS: readonly string[];
export declare function deleteProxyEnv(env: Record<string, string | undefined>): void;
export declare function proxiedRequestTarget(chunk: unknown): string | null;
export declare function installProxyGuard(refuse: (target: string) => Error): void;
export declare function installWorkerGuard(refuse: (target: string) => Error): void;
export declare function installNetworkGuard(refuse: (target: string) => Error): void;

/**
 * Type declarations for onnxruntime-react-native.
 *
 * The package re-exports from onnxruntime-common, which lacks a `types`
 * condition in its `exports` field, breaking TypeScript resolution under
 * pnpm's strict node_modules layout. We declare the subset we use.
 */
declare module "onnxruntime-react-native" {
  export class InferenceSession {
    static create(path: string): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  export class Tensor {
    constructor(
      type: string,
      data: Float32Array | BigInt64Array | Int32Array | Uint8Array,
      dims: readonly number[],
    );
    readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array | ArrayBuffer;
    readonly dims: readonly number[];
    readonly type: string;
  }
}

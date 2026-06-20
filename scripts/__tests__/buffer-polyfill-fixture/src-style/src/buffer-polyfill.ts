// Fixture: the runtime assignment lives in a src/ module (like desktop/spatial).
// Proves the src/ placement alone satisfies the gate (no index.html present).
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;

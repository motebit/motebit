// Polyfill Web Crypto API for Hermes runtime.
// react-native-quick-crypto provides crypto.subtle + crypto.getRandomValues
// via native JSI bindings — must install on global before any code touches crypto.
import crypto from "react-native-quick-crypto";

if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error -- quick-crypto's type doesn't perfectly match Web Crypto but is compatible
  globalThis.crypto = crypto;
}

import { registerRootComponent } from "expo";
import App from "./src/App";

registerRootComponent(App);

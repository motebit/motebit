// Install Node-shaped globals Hermes doesn't ship (Buffer, crypto) BEFORE
// anything else imports. Must be the first import — see shims/install-globals.ts
// for why separating this into its own file matters (ESM hoisting).
import "./shims/install-globals";

import { registerRootComponent } from "expo";
import App from "./src/App";

registerRootComponent(App);

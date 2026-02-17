/**
 * Expo SecureStore adapter for MotebitRuntime keyring.
 *
 * Wraps expo-secure-store into the KeyringAdapter interface.
 * Data is stored in the device's native keychain (iOS Keychain / Android Keystore).
 */

import * as SecureStore from "expo-secure-store";
import type { KeyringAdapter } from "@motebit/runtime";

export class SecureStoreAdapter implements KeyringAdapter {
  private prefix: string;

  constructor(prefix = "motebit_") {
    this.prefix = prefix;
  }

  async get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(this.prefix + key);
  }
}

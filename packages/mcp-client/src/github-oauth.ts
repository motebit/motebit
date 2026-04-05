/**
 * GitHubOAuthTokenProvider — GitHub OAuth 2.0 token lifecycle.
 *
 * Implements OAuthTokenProvider for GitHub App user access tokens.
 * Handles token refresh against GitHub's OAuth endpoint.
 *
 * GitHub specifics (glucose absorbed through the adapter boundary):
 * - Endpoint: POST https://github.com/login/oauth/access_token
 * - Access tokens expire in 8 hours (expires_in: 28800)
 * - Refresh tokens expire in 6 months
 * - Token rotation: old refresh token invalidated on each refresh
 * - Response uses form-encoded by default; we request JSON via Accept header
 */

import type { OAuthToken, OAuthTokenProvider } from "./index.js";

export interface GitHubOAuthConfig {
  /** GitHub App client ID. */
  clientId: string;
  /** GitHub App client secret. Not required for device flow tokens. */
  clientSecret?: string;
  /** Initial refresh token from the OAuth authorization flow. */
  initialRefreshToken: string;
  /** Override the token endpoint. Default: https://github.com/login/oauth/access_token */
  tokenEndpoint?: string;
  /** Injected fetch for testability. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

/** GitHub token endpoint response (JSON). */
interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  error?: string;
  error_description?: string;
}

const DEFAULT_ENDPOINT = "https://github.com/login/oauth/access_token";

export class GitHubOAuthTokenProvider implements OAuthTokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly tokenEndpoint: string;
  private readonly _fetch: typeof globalThis.fetch;

  /** Track the latest refresh token — GitHub rotates on each use. */
  private currentRefreshToken: string;

  constructor(config: GitHubOAuthConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenEndpoint = config.tokenEndpoint ?? DEFAULT_ENDPOINT;
    this._fetch = config.fetch ?? globalThis.fetch;
    this.currentRefreshToken = config.initialRefreshToken;
  }

  /**
   * Initial token acquisition. Uses the stored refresh token to get
   * the first access token. GitHub doesn't have a separate "initial grant"
   * endpoint — refresh is the mechanism for non-interactive acquisition.
   */
  async getToken(): Promise<OAuthToken> {
    return this.refresh(this.currentRefreshToken);
  }

  /**
   * Refresh an access token using GitHub's OAuth endpoint.
   * The old refresh token is invalidated — the new one from the response
   * must be used for subsequent refreshes.
   */
  async refresh(token: string): Promise<OAuthToken> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: token,
    });
    if (this.clientSecret) {
      params.set("client_secret", this.clientSecret);
    }

    const response = await this._fetch(this.tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`GitHub OAuth token refresh failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as GitHubTokenResponse;

    if (data.error) {
      throw new Error(
        `GitHub OAuth error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`,
      );
    }

    // GitHub rotates refresh tokens — track the new one
    this.currentRefreshToken = data.refresh_token;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
}

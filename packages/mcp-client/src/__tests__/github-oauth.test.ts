/**
 * GitHubOAuthTokenProvider unit tests.
 *
 * Tests against mocked GitHub token endpoint — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubOAuthTokenProvider } from "../github-oauth.js";
import { OAuthCredentialSource } from "../index.js";

// --- Mock GitHub token endpoint ---

function githubTokenResponse(overrides?: Record<string, unknown>): GitHubSuccessResponse {
  return {
    access_token: "ghu_test_access_token",
    token_type: "bearer",
    scope: "",
    expires_in: 28800, // 8 hours
    refresh_token: "ghr_test_new_refresh_token",
    refresh_token_expires_in: 15897600, // 6 months
    ...overrides,
  };
}

interface GitHubSuccessResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  error?: string;
  error_description?: string;
}

function mockFetch(response: GitHubSuccessResponse | (() => GitHubSuccessResponse), status = 200) {
  return vi.fn().mockImplementation(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof response === "function" ? response() : response),
  }));
}

describe("GitHubOAuthTokenProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch(githubTokenResponse());
  });

  function createProvider(
    overrides?: Partial<ConstructorParameters<typeof GitHubOAuthTokenProvider>[0]>,
  ) {
    return new GitHubOAuthTokenProvider({
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      initialRefreshToken: "ghr_initial_refresh",
      fetch: fetchMock,
      ...overrides,
    });
  }

  describe("getToken", () => {
    it("acquires token by refreshing the initial refresh token", async () => {
      const provider = createProvider();
      const token = await provider.getToken();

      expect(token.accessToken).toBe("ghu_test_access_token");
      expect(token.refreshToken).toBe("ghr_test_new_refresh_token");
      expect(token.expiresAt).toBeGreaterThan(Date.now());

      // Should have called the token endpoint with the initial refresh token
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://github.com/login/oauth/access_token");
      expect(init.method).toBe("POST");
      expect(init.headers.Accept).toBe("application/json");

      const body = new URLSearchParams(init.body as string);
      expect(body.get("client_id")).toBe("gh-client-id");
      expect(body.get("client_secret")).toBe("gh-client-secret");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("ghr_initial_refresh");
    });

    it("omits client_secret for device flow tokens", async () => {
      const provider = createProvider({ clientSecret: undefined });
      await provider.getToken();

      const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
      expect(body.has("client_secret")).toBe(false);
    });

    it("uses custom token endpoint when provided", async () => {
      const provider = createProvider({
        tokenEndpoint: "https://github.example.com/oauth/token",
      });
      await provider.getToken();

      expect(fetchMock.mock.calls[0]![0]).toBe("https://github.example.com/oauth/token");
    });
  });

  describe("refresh", () => {
    it("exchanges refresh token for new access token", async () => {
      const provider = createProvider();
      const token = await provider.refresh("ghr_my_refresh");

      expect(token.accessToken).toBe("ghu_test_access_token");
      expect(token.refreshToken).toBe("ghr_test_new_refresh_token");

      const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
      expect(body.get("refresh_token")).toBe("ghr_my_refresh");
    });

    it("converts expires_in to absolute expiresAt", async () => {
      const before = Date.now();
      const provider = createProvider();
      const token = await provider.refresh("ghr_test");
      const after = Date.now();

      // expires_in is 28800 seconds (8 hours)
      const expectedMin = before + 28800 * 1000;
      const expectedMax = after + 28800 * 1000;
      expect(token.expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(token.expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it("tracks rotated refresh token for subsequent calls", async () => {
      let callCount = 0;
      fetchMock = mockFetch(() => {
        callCount++;
        return githubTokenResponse({
          access_token: `ghu_token_${callCount}`,
          refresh_token: `ghr_rotated_${callCount}`,
        });
      });
      const provider = createProvider();

      // First call uses initial refresh token
      await provider.getToken();
      let body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
      expect(body.get("refresh_token")).toBe("ghr_initial_refresh");

      // Second call should use the rotated refresh token from first response
      await provider.getToken();
      body = new URLSearchParams(fetchMock.mock.calls[1]![1].body as string);
      expect(body.get("refresh_token")).toBe("ghr_rotated_1");
    });

    it("throws on HTTP error (fail-closed)", async () => {
      fetchMock = mockFetch(githubTokenResponse(), 500);
      const provider = createProvider();

      await expect(provider.refresh("ghr_test")).rejects.toThrow(
        "GitHub OAuth token refresh failed: HTTP 500",
      );
    });

    it("throws on GitHub OAuth error response", async () => {
      fetchMock = mockFetch({
        ...githubTokenResponse(),
        error: "bad_refresh_token",
        error_description: "The refresh token is invalid or has been revoked",
      });
      const provider = createProvider();

      await expect(provider.refresh("ghr_bad")).rejects.toThrow(
        "GitHub OAuth error: bad_refresh_token — The refresh token is invalid or has been revoked",
      );
    });

    it("throws on GitHub error without description", async () => {
      fetchMock = mockFetch({
        ...githubTokenResponse(),
        error: "server_error",
      });
      const provider = createProvider();

      await expect(provider.refresh("ghr_test")).rejects.toThrow(
        "GitHub OAuth error: server_error",
      );
    });
  });

  describe("full chain: GitHubOAuthTokenProvider → OAuthCredentialSource", () => {
    it("credential source returns GitHub access token", async () => {
      const provider = createProvider();
      const source = new OAuthCredentialSource(provider);

      const cred = await source.getCredential({ serverUrl: "https://api.githubcopilot.com/mcp/" });
      expect(cred).toBe("ghu_test_access_token");
    });

    it("credential source refreshes when token expires", async () => {
      let callCount = 0;
      fetchMock = mockFetch(() => {
        callCount++;
        return githubTokenResponse({
          access_token: `ghu_token_${callCount}`,
          refresh_token: `ghr_rotated_${callCount}`,
          // First token expires immediately, second is fresh
          expires_in: callCount === 1 ? 0 : 28800,
        });
      });
      const provider = createProvider();
      const source = new OAuthCredentialSource(provider);

      // First call: acquires token (already expired)
      const cred1 = await source.getCredential({ serverUrl: "https://api.github.com" });
      expect(cred1).toBe("ghu_token_1");

      // Second call: token expired → refreshes
      const cred2 = await source.getCredential({ serverUrl: "https://api.github.com" });
      expect(cred2).toBe("ghu_token_2");

      // Two fetch calls: initial acquire + refresh
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("propagates GitHub errors through credential source (fail-closed)", async () => {
      fetchMock = mockFetch(githubTokenResponse(), 401);
      const provider = createProvider();
      const source = new OAuthCredentialSource(provider);

      await expect(source.getCredential({ serverUrl: "https://api.github.com" })).rejects.toThrow(
        "GitHub OAuth token refresh failed: HTTP 401",
      );
    });
  });
});

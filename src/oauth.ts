/**
 * Minimal OAuth 2.1 provider for the HTTP transport.
 *
 * The "user" authenticates by pasting the MCP_AUTH_TOKEN into a small HTML form
 * during the authorization step. This provider also doubles as the token
 * verifier so `requireBearerAuth` can validate issued access tokens.
 */

import crypto from "node:crypto";
import type { Request, Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const TOKEN_TTL_S = 3600;

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
}

export class CodMcpOAuthProvider implements OAuthServerProvider {
  private readonly adminToken: string;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, PendingAuth>();
  private readonly tokens = new Map<string, { clientId: string; scopes: string[]; expiresAt: number }>();
  private readonly refreshTokens = new Map<
    string,
    { clientId: string; scopes: string[]; expiresAt: number }
  >();

  clientsStore: OAuthRegisteredClientsStore;

  constructor(adminToken: string) {
    this.adminToken = adminToken;
    this.clientsStore = {
      getClient: (clientId: string) => {
        const existing = this.clients.get(clientId);
        if (existing) return existing;
        // Accept any client_id (e.g. from a previous registration lost on restart).
        // Real authentication is the admin token in the approval form.
        return {
          client_id: clientId,
          client_name: "MCP Client",
          redirect_uris: [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp:tools",
          token_endpoint_auth_method: "none",
        } as unknown as OAuthClientInformationFull;
      },
      registerClient: (client: OAuthClientInformationFull) => {
        this.clients.set(client.client_id, client);
        return client;
      },
    };
  }

  isAdminToken(token: string): boolean {
    return token === this.adminToken;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const stateParam = (params as AuthorizationParams & { state?: string }).state ?? "";
    const key = crypto.randomBytes(16).toString("hex");
    this.codes.set(key, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      scopes: params.scopes ?? [],
    });

    res.type("html").send(`<!DOCTYPE html>
<html><head><title>COD Drop Products MCP — Authorize</title></head>
<body style="font-family:sans-serif;max-width:420px;margin:40px auto">
<h2>Authorize MCP client</h2>
<p>Paste your <code>MCP_AUTH_TOKEN</code> to approve this connection.</p>
<form method="POST" action="/oauth/approve">
  <input type="hidden" name="key" value="${key}" />
  <input type="hidden" name="state" value="${stateParam}" />
  <input type="password" name="token" style="width:100%;padding:8px" placeholder="MCP_AUTH_TOKEN" required />
  <br/><br/>
  <button type="submit" style="padding:8px 24px">Approve</button>
</form>
</body></html>`);
  }

  approveHandler = (req: Request, res: Response): void => {
    const { key, token, state } = req.body as {
      key?: string;
      token?: string;
      state?: string;
    };
    if (!key || !token) {
      res.status(400).send("Missing key or token.");
      return;
    }
    const pending = this.codes.get(key);
    if (!pending) {
      res.status(400).send("Invalid or expired authorization key.");
      return;
    }
    if (token !== this.adminToken) {
      res.status(403).send("Invalid token.");
      return;
    }

    const code = crypto.randomBytes(32).toString("hex");
    this.codes.delete(key);
    this.codes.set(code, pending);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(302, redirectUrl.toString());
  };

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.codes.get(authorizationCode);
    if (!pending) throw new Error("Unknown authorization code.");
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const pending = this.codes.get(authorizationCode);
    if (!pending) throw new Error("Unknown authorization code.");
    this.codes.delete(authorizationCode);

    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;

    this.tokens.set(accessToken, {
      clientId: pending.clientId,
      scopes: pending.scopes,
      expiresAt,
    });
    this.refreshTokens.set(refreshToken, {
      clientId: pending.clientId,
      scopes: pending.scopes,
      expiresAt: expiresAt + 86400,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
  ): Promise<OAuthTokens> {
    const saved = this.refreshTokens.get(refreshToken);
    if (!saved) throw new Error("Invalid refresh token.");
    this.refreshTokens.delete(refreshToken);

    const accessToken = crypto.randomBytes(32).toString("hex");
    const newRefreshToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;

    this.tokens.set(accessToken, {
      clientId: saved.clientId,
      scopes: saved.scopes,
      expiresAt,
    });
    this.refreshTokens.set(newRefreshToken, {
      clientId: saved.clientId,
      scopes: saved.scopes,
      expiresAt: expiresAt + 86400,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const saved = this.tokens.get(token);
    if (!saved) throw new Error("Invalid access token.");
    if (saved.expiresAt < Math.floor(Date.now() / 1000)) {
      this.tokens.delete(token);
      throw new Error("Access token expired.");
    }
    return {
      token,
      clientId: saved.clientId,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    this.tokens.delete(_request.token);
    this.refreshTokens.delete(_request.token);
  }
}

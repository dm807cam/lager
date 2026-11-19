import express from 'express';
import type { RequestHandler } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { bearerUser } from '../http/api.js';
import type { PlatformExtension } from '../http/app.js';
import { authorizeGuard, clientAuthentication, LagerOAuthProvider } from './oauth.js';
import { buildMcpServer } from './tools.js';

// deploy_app carries up to 16 MiB of HTML inside a JSON-RPC message.
const MAX_MESSAGE = '24mb';

/**
 * The SDK's rate limits stay on; whether X-Forwarded-For is trusted is the operator's
 * decision (LAGER_TRUST_PROXY), so express-rate-limit's checks of that setting are off.
 */
const RATE_LIMIT = { validate: { trustProxy: false, xForwardedForHeader: false } };

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};

/** Mounts the OAuth authorization server and `POST /mcp` (stateless Streamable HTTP). */
export const mcpExtension: PlatformExtension = (router, core) => {
  const { config } = core;
  const origin = config.publicUrl.origin;
  // The protected resource is the MCP endpoint itself (RFC 9728, MCP authorization spec), so clients that
  // compare the resource with the URL they connect to find an exact match.
  const resourceUrl = new URL('/mcp', origin);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;

  let auth: RequestHandler | null = null;
  try {
    auth = mcpAuthRouter({
      provider: new LagerOAuthProvider(core),
      issuerUrl: new URL(origin),
      resourceServerUrl: resourceUrl,
      resourceName: 'Lager',
      authorizationOptions: { rateLimit: RATE_LIMIT },
      tokenOptions: { rateLimit: RATE_LIMIT },
      revocationOptions: { rateLimit: RATE_LIMIT },
      // client_secret_expires_at = 0: secrets do not expire (RFC 7591); connectors rarely re-register.
      clientRegistrationOptions: { rateLimit: RATE_LIMIT, clientSecretExpirySeconds: 0 },
    });
  } catch (e) {
    // The SDK refuses a non-https issuer other than localhost; API tokens keep working.
    console.warn(`OAuth for the MCP connector is disabled: ${(e as Error).message} (LAGER_PUBLIC_URL=${config.publicUrl.href})`);
  }
  if (auth) {
    router.post(['/token', '/revoke'], ...clientAuthentication(core));
    router.use('/authorize', authorizeGuard(core));
    router.use(auth);
  }

  router.get('/mcp', methodNotAllowed);
  router.delete('/mcp', methodNotAllowed);
  router.post('/mcp', (req, res, next) => {
    const user = bearerUser(core, req);
    if (!user) {
      res.status(401).set('WWW-Authenticate', challenge)
        .json({ error: { code: 'unauthenticated', message: 'A bearer token (API token or OAuth access token) is required.' } });
      return;
    }
    res.locals.mcpUser = user;
    next();
  }, express.json({ limit: MAX_MESSAGE }), async (req, res) => {
    const server = buildMcpServer(core, res.locals.mcpUser);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      // Closing must never end the process: an unhandled rejection stops Lager (see server.ts).
      transport.close().catch((e: unknown) => { console.error('lager: closing an MCP transport failed:', e); });
      server.close().catch((e: unknown) => { console.error('lager: closing an MCP server failed:', e); });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
};

import type { An5SheetsAdapterConfig } from './config';

/** Deduplicate refresh requests within an adapter; do not expose token responses. */
export function sheetsTokenProvider(config: An5SheetsAdapterConfig) {
  let token = config.accessToken;
  let expiresAt = config.tokenExpiresAt;
  let pending: Promise<string> | undefined;
  return async (force = false): Promise<string | undefined> => {
    if (token && !force && (expiresAt === undefined || expiresAt > Date.now() + 60000)) return token;
    if (!config.refreshToken || !config.oauthClientId) {
      if (force || expiresAt !== undefined) throw new Error('Google access expired. Reconnect your Google account.');
      return token;
    }
    if (!pending) pending = (async () => {
      try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.oauthClientId!, refresh_token: config.refreshToken!, ...(config.oauthClientSecret ? { client_secret: config.oauthClientSecret } : {}) }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error();
        const result = await response.json() as { access_token?: string; expires_in?: number };
        if (!result.access_token || typeof result.access_token !== 'string' || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error();
        token = result.access_token; expiresAt = Date.now() + result.expires_in * 1000;
        return token;
      } catch { throw new Error('Google access expired or was revoked. Reconnect your Google account.'); }
      finally { pending = undefined; }
    })();
    return pending;
  };
}

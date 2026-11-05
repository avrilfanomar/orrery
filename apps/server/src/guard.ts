// What stands between a web page the operator happens to visit and this API
// (ADR 0010). Commands carry no credentials, so the operator's own browser is
// the way in for anyone else. A page cannot read another origin's answers, but
// DNS rebinding gives an attacker's page the server's origin, and any page can
// send a write it cannot read. Listening on loopback stops neither.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sent with every answer. The console loads only its own files, so the policy
 * allows nothing else. No page may frame it, so none can trick a click on one
 * of its actions, and no answer is read as a type other than the one it states.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** Users of the API may not sign as the server's own writers: the change feed would credit them with the webhook's or the collector's authority. */
export const RESERVED_ACTORS: readonly string[] = ['ingest', 'collector'];

/** The host (with port) a Host header names, normalised as a URL would; null when it names none, or carries more than a host. */
function hostOf(header: string): string | null {
  if (!/^[^\s@/\\?#]+$/.test(header) || !URL.canParse(`http://${header}`)) return null;
  return new URL(`http://${header}`).host;
}

/**
 * A name no one else's DNS can point here: an IP address; `localhost` and the
 * names under it, which browsers resolve to loopback themselves; and the names
 * the operator lists (`.name` covers the name and every name under it).
 * Rebinding needs a name its attacker controls, and the browser puts that name
 * in Host.
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = new URL(`http://${host}`).hostname.replace(/\.$/, '');
  if (isIP(name.replace(/^\[(.*)\]$/, '$1'))) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return allowed.some((a) => (a.startsWith('.') ? name === a.slice(1) || name.endsWith(a) : name === a));
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Compares in constant time, so the time a refusal takes says nothing about how much of a guess was right. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/**
 * Answers a refusal, and logs it at warn under the request id, with where it came
 * from and what it named. A refusal is the only trace a probe of the API leaves,
 * so the operator sees it. The log never holds the credentials offered.
 */
export function refuse(req: FastifyRequest, reply: FastifyReply, status: 401 | 403, refused: string, error: string, detail: Record<string, string> = {}): FastifyReply {
  req.log.warn({ refused, ...detail, method: req.method, url: req.url, remote: req.ip }, `refused a request: ${refused}`);
  return reply.code(status).send({ error, code: status === 401 ? 'unauthorized' : 'forbidden' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every request must name the server by a name it answers to. A write must not
 * come from a page of another origin. Clients that are not browsers (curl, the
 * simulator, CI) send no Origin and are unaffected. A request with no Host
 * comes from no browser, so it is let through.
 */
export function guard(app: FastifyInstance, allowedHosts: readonly string[]): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    const header = req.headers.host;
    const host = header === undefined ? null : hostOf(header);
    if (header !== undefined && (host === null || !hostAllowed(host, allowedHosts))) {
      return refuse(req, reply, 403, 'host', `This server does not answer to the name “${header}”. If that is how you reach it, add the name to ORRERY_ALLOWED_HOSTS`, { host: header });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !SAFE_METHODS.has(req.method)) {
      const from = URL.canParse(origin) ? new URL(origin).host : null;
      if (from === null || from !== host) return refuse(req, reply, 403, 'origin', `A page at ${origin} may not change this universe. Changes come from the console itself, or from a client that sends no Origin`, { origin });
    }
  });
}

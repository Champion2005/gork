import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { Page } from './page'
import { renderToReadableStream } from 'react-dom/server'
import * as memory from '../bot/memory'
import * as config from '../bot/config'
import * as audit from '../bot/audit'
import * as dashboardUsers from '../bot/dashboard-users'
import * as discordOAuth from '../bot/discord-oauth'
import { getSessionSecret } from '../bot/session'
import { migrateFromLegacy } from '../bot/storage'

// Migrate files to persistent storage if needed
['db.json', 'usage-events.jsonl', 'audit-log.jsonl', 'bot-config.json', 'dashboard-users.json', 'dashboard-session-secret.txt']
    .forEach(migrateFromLegacy)

const { outputs } = await Bun.build({ entrypoints: ['./site/page.tsx'], target: 'browser' })
const js = await outputs[0].text()

type SessionPayload = {
  exp: number
  csrf: string
  discordId: string
  displayName: string
  role: dashboardUsers.DashboardRole
  source: 'oauth'
}
type Principal = {
  discordId: string
  displayName: string
  role: dashboardUsers.DashboardRole
  source: 'oauth'
}
const SESSION_COOKIE = 'gork_session'
const OAUTH_STATE_COOKIE = 'gork_oauth_state'
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000
const sessionSecret = getSessionSecret()
const trustProxyHeaders = process.env.TRUST_PROXY_HEADERS == 'true'
const rateBuckets = new Map<string, number[]>()
const revokedTokens = new Map<string, number>()
let lastRatePruneAt = 0
let lastRevokedPruneAt = 0

const parseJsonBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await req.json()
    if (typeof body === 'object' && body !== null) return body as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

const getString = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === 'string' ? body[key].trim() : ''

const getStringList = (body: Record<string, unknown>, key: string) =>
  Array.isArray(body[key]) ? body[key].map((item) => typeof item == 'string' ? item.trim() : '').filter(Boolean) : []

const parseCookies = (cookieHeader: string | null) =>
  Object.fromEntries((cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, ...rest] = part.split('=')
      try {
        return [key, decodeURIComponent(rest.join('='))]
      } catch {
        return [key, '']
      }
    }))

const secureEq = (a: string, b: string) => {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  if (aa.length != bb.length) return false
  return timingSafeEqual(aa, bb)
}

const signPayload = (payload64: string) =>
  createHmac('sha256', sessionSecret).update(payload64).digest('base64url')

const encodeSession = (payload: SessionPayload) => {
  const payload64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${payload64}.${signPayload(payload64)}`
}

const decodeSession = (token: string | undefined): SessionPayload | null => {
  const now = Date.now()
  if (now - lastRevokedPruneAt > 60_000) {
    lastRevokedPruneAt = now
    for (const [sig, exp] of revokedTokens.entries()) {
      if (exp <= now) revokedTokens.delete(sig)
    }
    if (revokedTokens.size > 10_000) {
      const oldest = [...revokedTokens.entries()].sort((a, b) => a[1] - b[1])
      for (const [sig] of oldest.slice(0, revokedTokens.size - 10_000)) revokedTokens.delete(sig)
    }
  }
  if (!token) return null
  const [payload64, signature] = token.split('.')
  if (!payload64 || !signature) return null
  const revokedUntil = revokedTokens.get(signature)
  if (revokedUntil && revokedUntil > now) return null
  if (revokedUntil && revokedUntil <= now) revokedTokens.delete(signature)
  if (!secureEq(signPayload(payload64), signature)) return null
  try {
    const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf-8')) as SessionPayload
    if (!payload?.exp || payload.exp < Date.now()) return null
    if (!payload?.csrf || !payload?.discordId || !payload?.displayName || !payload?.role || !payload?.source) return null
    return payload
  } catch {
    return null
  }
}

const ipFromReq = (req: Request) => {
  if (!trustProxyHeaders) return 'unknown'
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return fwd || 'unknown'
}

const isHttps = (req: Request) => {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (proto) return proto == 'https'
  return new URL(req.url).protocol == 'https:'
}

const makeCookie = (token: string, req: Request) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}${isHttps(req) ? '; Secure' : ''}`

const clearCookie = (req: Request) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`

const makeStateCookie = (token: string, req: Request) =>
  `${OAUTH_STATE_COOKIE}=${encodeURIComponent(token)}; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(req) ? '; Secure' : ''}`

const clearStateCookie = (req: Request) =>
  `${OAUTH_STATE_COOKIE}=; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`

const readSession = (req: Request) => {
  const cookies = parseCookies(req.headers.get('cookie'))
  return decodeSession(cookies[SESSION_COOKIE])
}

const hitRateLimit = (bucketKey: string, limit: number, windowMs: number) => {
  const now = Date.now()
  if (now - lastRatePruneAt > 60_000) {
    lastRatePruneAt = now
    for (const [key, values] of rateBuckets.entries()) {
      const fresh = values.filter((ts) => now - ts < 60 * 60 * 1000)
      if (fresh.length) rateBuckets.set(key, fresh)
      else rateBuckets.delete(key)
    }
    if (rateBuckets.size > 5000) {
      const oldest = [...rateBuckets.entries()]
        .map(([key, values]) => [key, Math.max(...values)] as const)
        .sort((a, b) => a[1] - b[1])
      const removeCount = rateBuckets.size - 5000
      for (const [key] of oldest.slice(0, removeCount)) rateBuckets.delete(key)
    }
  }

  const prev = (rateBuckets.get(bucketKey) ?? []).filter((ts) => now - ts < windowMs)
  if (prev.length >= limit) {
    rateBuckets.set(bucketKey, prev)
    return false
  }
  prev.push(now)
  rateBuckets.set(bucketKey, prev)
  return true
}

const hitGuardedRateLimit = (bucketPrefix: string, ip: string, limit: number, windowMs: number) =>
  hitRateLimit(`${bucketPrefix}:ip:${ip}`, limit, windowMs)
  && hitRateLimit(`${bucketPrefix}:global`, limit, windowMs)

const resolvePrincipal = (session: SessionPayload | null): Principal | null => {
  if (!session) return null
  const account = dashboardUsers.findAccount(session.discordId)
  if (!account) return null
  return {
    discordId: account.discordId,
    displayName: account.displayName,
    role: account.role,
    source: 'oauth',
  }
}

const requireAuth = (req: Request) => {
  const session = readSession(req)
  const principal = resolvePrincipal(session)
  if (!principal) return { session: null as SessionPayload | null, principal: null as Principal | null, response: new Response('Unauthorized', { status: 401 }) }
  return { session, principal, response: null as Response | null }
}

const requireAdmin = (req: Request) => {
  const authResult = requireAuth(req)
  if (authResult.response) return authResult
  if (authResult.principal!.role != 'admin') {
    return { ...authResult, response: new Response('Forbidden', { status: 403 }) }
  }
  return authResult
}

const requireCsrf = (req: Request, session: SessionPayload) => {
  const csrf = req.headers.get('x-csrf-token')?.trim()
  if (!csrf || !secureEq(csrf, session.csrf)) return new Response('Invalid CSRF token', { status: 403 })
  return null
}

const responseFromError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const status = message.includes('exists') ? 409 : 400
  return new Response(message, { status })
}

const ensureWriteAllowed = () => {
  if (config.loadConfig().readOnlyMode) return new Response('Dashboard is in read-only mode', { status: 423 })
  return null
}

const getPublicOrigin = (req: Request) => {
  if (trustProxyHeaders) {
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'http'
    const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    if (host) return `${proto}://${host}`
  }
  return new URL(req.url).origin
}

console.log('server at :6767')
Bun.serve({
  port: 6767,
  hostname: '0.0.0.0',
  fetch: async (req, server) => {
    const path = new URL(req.url).pathname
    const directIp = server.requestIP(req)?.address
    const ip = directIp || ipFromReq(req)

    if (path == '/dist.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } })
    if (path == '/style.css') return new Response(Bun.file('./site/output.css'))
    if (path == '/favicon.ico') return new Response(null, { status: 204 })

    if (path == '/auth/status') {
      const session = readSession(req)
      const principal = resolvePrincipal(session)
      return Response.json({
        authenticated: Boolean(principal),
        discordId: principal?.discordId ?? null,
        displayName: principal?.displayName ?? null,
        role: principal?.role ?? null,
        sessionSource: principal?.source ?? null,
        csrfToken: session?.csrf ?? null,
        discordOAuthConfigured: discordOAuth.isDiscordOAuthConfigured(),
        updatedAt: null,
        accountCount: dashboardUsers.listAccounts().length,
        systemConfigured: {
          sync: Boolean(process.env.GITHUB_SYNC_TOKEN?.trim()),
          redeploy: Boolean(process.env.COOLIFY_WEBHOOK?.trim())
        }
      })
    }

    if (path == '/auth/discord/start') {
      if (req.method != 'GET') return new Response('Method not allowed', { status: 405 })
      if (!discordOAuth.isDiscordOAuthConfigured()) return new Response('Discord OAuth is not configured', { status: 503 })
      if (!hitGuardedRateLimit('write', ip, 60, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const state = randomBytes(24).toString('hex')
      const redirectUri = new URL('/auth/discord/callback', getPublicOrigin(req)).toString()
      const headers = new Headers({
        Location: discordOAuth.buildDiscordAuthorizeUrl({ state, redirectUri }),
        'Set-Cookie': makeStateCookie(state, req),
      })
      return new Response(null, { status: 303, headers })
    }

    if (path == '/auth/discord/callback') {
      if (req.method != 'GET') return new Response('Method not allowed', { status: 405 })
      if (!discordOAuth.isDiscordOAuthConfigured()) return new Response('Discord OAuth is not configured', { status: 503 })
      const url = new URL(req.url)
      const code = url.searchParams.get('code')?.trim() ?? ''
      const state = url.searchParams.get('state')?.trim() ?? ''
      const cookies = parseCookies(req.headers.get('cookie'))
      const expectedState = cookies[OAUTH_STATE_COOKIE]
      if (!code) return new Response('Missing OAuth code', { status: 400 })
      if (!state || !expectedState || !secureEq(state, expectedState)) return new Response('Invalid OAuth state', { status: 400 })
      const redirectUri = new URL('/auth/discord/callback', getPublicOrigin(req)).toString()
      try {
        const identity = await discordOAuth.exchangeDiscordCode({ code, redirectUri })
        const account = dashboardUsers.syncAccount({ discordId: identity.discordId, displayName: identity.displayName })
        const token = encodeSession({
          exp: Date.now() + sessionTtlMs,
          csrf: randomBytes(24).toString('hex'),
          discordId: account.discordId,
          displayName: account.displayName,
          role: account.role,
          source: 'oauth',
        })
        const headers = new Headers({ Location: '/' })
        headers.append('Set-Cookie', makeCookie(token, req))
        headers.append('Set-Cookie', clearStateCookie(req))
        return new Response(null, {
          status: 303,
          headers,
        })
      } catch (error) {
        return responseFromError(error)
      }
    }

    if (path == '/system/sync') {
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr

      const token = process.env.GITHUB_SYNC_TOKEN?.trim()
      const repo = process.env.GITHUB_REPO?.trim() || 'Champion2005/gork'
      if (!token) return new Response('GITHUB_SYNC_TOKEN is not configured', { status: 503 })

      const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync-upstream.yml/dispatches`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Gork-Dashboard'
        },
        body: JSON.stringify({ ref: 'main' })
      })

      if (!res.ok) return new Response(await res.text(), { status: res.status })
      audit.logAudit({ actor: principal!.displayName, ip, action: 'system.sync' })
      return Response.json({ ok: true })
    }

    if (path == '/system/redeploy') {
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr

      const webhook = process.env.COOLIFY_WEBHOOK?.trim()
      if (!webhook) return new Response('COOLIFY_WEBHOOK is not configured', { status: 503 })

      const res = await fetch(webhook, { method: 'GET' })
      if (!res.ok) return new Response(await res.text(), { status: res.status })
      audit.logAudit({ actor: principal!.displayName, ip, action: 'system.redeploy' })
      return Response.json({ ok: true })
    }

    if (path == '/logout') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE]
      const signature = token?.split('.')?.[1]
      const session = decodeSession(token)
      if (signature && session) revokedTokens.set(signature, session.exp)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie(req) },
      })
    }

    if (path == '/accounts') {
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      if (req.method == 'GET') return Response.json({ accounts: dashboardUsers.listAccounts() })
      return new Response('Discord OAuth accounts are created automatically on first login', { status: 410 })
    }

    if (path == '/accounts/role') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 120, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const discordId = getString(body, 'discordId')
      const role = getString(body, 'role') == 'admin' ? 'admin' : 'user'
      try {
        if (!discordId) return new Response('"discordId" is required', { status: 400 })
        const account = dashboardUsers.setRole({ discordId, role })
        if (!account) return new Response('Account not found', { status: 404 })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'account.role.update', userId: account.discordId, displayName: account.displayName, details: { role: account.role } })
        return Response.json({ ok: true, account });
      } catch (error) {
        return responseFromError(error)
      }
    }

    if (path == '/accounts/reset-password') {
      return new Response('Discord OAuth accounts do not use passwords', { status: 410 })
    }

    if (path == '/load') {
      const { response } = requireAuth(req)
      if (response) return response
      return Response.json({ users: memory.listUsers() })
    }

    if (path == '/analytics') {
      const { response } = requireAdmin(req)
      if (response) return response
      return Response.json(memory.getUsageAnalytics())
    }

    if (path == '/audit') {
      const { response } = requireAdmin(req)
      if (response) return response
      const limit = Math.max(1, Math.min(500, Number(new URL(req.url).searchParams.get('limit')) || 200))
      return Response.json({ rows: audit.listAudit(limit) })
    }

    if (path == '/config') {
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      if (req.method == 'GET') return Response.json(config.loadConfig())
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 180, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const patch = body as Partial<config.BotConfig>
      const next = config.updateConfig(patch)
      audit.logAudit({ actor: principal!.displayName, ip, action: 'config.update', details: patch })
      return Response.json(next)
    }

    const isFactWritePath = [
      '/add',
      '/edit',
      '/delete',
      '/facts/add',
      '/facts/edit',
      '/facts/delete',
      '/facts/bulk-delete',
      '/facts/dedupe',
      '/facts/cleanup-low-value',
      '/facts/delete-profile',
    ].includes(path)

    if (isFactWritePath) {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 180, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const { session, principal, response } = requireAuth(req)
      if (response) return response
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const readOnlyErr = ensureWriteAllowed()
      if (readOnlyErr) return readOnlyErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })

      const user = getString(body, 'user')
      const userId = getString(body, 'userId') || undefined
      const displayName = getString(body, 'displayName') || undefined
      const fact = getString(body, 'fact')
      const targetUserId = userId || principal!.discordId
      const targetDisplayName = principal!.role == 'admin' ? displayName || user || principal!.displayName : principal!.displayName
      if (principal!.role != 'admin' && userId && userId != principal!.discordId) {
        return new Response('Users can only edit their own facts', { status: 403 })
      }

      if (path == '/add' || path == '/facts/add') {
        if (!fact) return new Response('"fact" is required', { status: 400 })
        const out = memory.addFact({ user: principal!.role == 'admin' ? user || targetUserId : principal!.displayName, userId: targetUserId, displayName: targetDisplayName, fact })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.add', userId: out.userId, displayName: out.displayName, after: fact })
        return Response.json({ ok: true, userId: out.userId })
      }

      if (path == '/delete' || path == '/facts/delete') {
        if (!fact) return new Response('"fact" is required', { status: 400 })
        memory.deleteFact({ user: principal!.role == 'admin' ? user || targetUserId : principal!.displayName, userId: targetUserId, fact })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.delete', userId: targetUserId, displayName: targetDisplayName, before: fact })
        return Response.json({ ok: true })
      }

      if (path == '/edit' || path == '/facts/edit') {
        const oldFact = getString(body, 'oldFact')
        const newFact = getString(body, 'newFact')
        if (!oldFact || !newFact) return new Response('"oldFact" and "newFact" are required', { status: 400 })
        memory.editFact({ user: principal!.role == 'admin' ? user || targetUserId : principal!.displayName, userId: targetUserId, oldFact, newFact })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.edit', userId: targetUserId, displayName: targetDisplayName, before: oldFact, after: newFact })
        return Response.json({ ok: true })
      }

      if (path == '/facts/bulk-delete') {
        const facts = getStringList(body, 'facts')
        if (!facts.length) return new Response('"facts" must be a non-empty array', { status: 400 })
        const removed = memory.bulkDeleteFacts({ userId: targetUserId, facts })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.bulk-delete', userId: targetUserId, displayName: targetDisplayName, details: { removed } })
        return Response.json({ ok: true, removed })
      }

      if (path == '/facts/dedupe') {
        const removed = memory.dedupeFacts({ userId: targetUserId })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.dedupe', userId: targetUserId, displayName: targetDisplayName, details: { removed } })
        return Response.json({ ok: true, removed })
      }

      if (path == '/facts/cleanup-low-value') {
        const removed = memory.cleanupLowValueFacts({ userId: targetUserId })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.cleanup-low-value', userId: targetUserId, displayName: targetDisplayName, details: { removed } })
        return Response.json({ ok: true, removed })
      }

      if (path == '/facts/delete-profile') {
        if (principal!.role != 'admin') return new Response('Only admins can delete profiles', { status: 403 })
        const success = memory.deleteUserProfile({ userId: targetUserId })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'fact.delete-profile', userId: targetUserId, displayName: targetDisplayName })
        return Response.json({ ok: success })
      }
    }

    if (path.startsWith('/auth/') || path.startsWith('/system/') || path.startsWith('/facts/') || ['/load', '/analytics', '/audit', '/config', '/accounts'].includes(path)) {
      return Response.json({ error: 'API route not found', path }, { status: 404 })
    }

    return renderToReadableStream(<Page />, { bootstrapModules: ['/dist.js'] }).then((s) => new Response(s))
  }
})

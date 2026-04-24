import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { Page } from './page'
import { renderToReadableStream } from 'react-dom/server'
import * as memory from '../bot/memory'
import * as config from '../bot/config'
import * as audit from '../bot/audit'

const { outputs } = await Bun.build({ entrypoints: ['./site/page.tsx'], target: 'browser' })
const js = await outputs[0].text()

type SessionPayload = { exp: number; csrf: string; actor: string }
const SESSION_COOKIE = 'gork_session'
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000
const dashboardPassword = process.env.DASHBOARD_PASSWORD ?? process.env.DISCORD_TOKEN ?? process.env.OPENROUTER_API_KEY
const sessionSecret = process.env.DASHBOARD_SESSION_SECRET ?? dashboardPassword ?? randomBytes(24).toString('hex')
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
    if (!payload?.csrf || !payload?.actor) return null
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

const requireAuth = (req: Request) => {
  const session = readSession(req)
  if (!session) return { session: null as SessionPayload | null, response: new Response('Unauthorized', { status: 401 }) }
  return { session, response: null as Response | null }
}

const requireCsrf = (req: Request, session: SessionPayload) => {
  const csrf = req.headers.get('x-csrf-token')?.trim()
  if (!csrf || !secureEq(csrf, session.csrf)) return new Response('Invalid CSRF token', { status: 403 })
  return null
}

const ensureWriteAllowed = () => {
  if (config.loadConfig().readOnlyMode) return new Response('Dashboard is in read-only mode', { status: 423 })
  return null
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

    if (path == '/auth/status') {
      const session = readSession(req)
      return Response.json({
        authenticated: Boolean(session),
        actor: session?.actor ?? null,
        csrfToken: session?.csrf ?? null,
        passwordRequired: Boolean(dashboardPassword),
      })
    }

    if (path == '/login') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitRateLimit(`login:ip:${ip}`, 12, 10 * 60 * 1000)
        || !hitRateLimit('login:global', 5000, 10 * 60 * 1000)) {
        return new Response('Too many login attempts', { status: 429 })
      }
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      if (!dashboardPassword) return new Response('Dashboard password is not configured', { status: 500 })
      const password = getString(body, 'password')
      const actor = getString(body, 'actor') || 'admin'
      if (!secureEq(password, dashboardPassword)) return new Response('Invalid credentials', { status: 401 })

      const token = encodeSession({ exp: Date.now() + sessionTtlMs, csrf: randomBytes(24).toString('hex'), actor })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': makeCookie(token, req) },
      })
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

    if (path == '/load') {
      const { response } = requireAuth(req)
      if (response) return response
      return Response.json({ users: memory.listUsers() })
    }

    if (path == '/analytics') {
      const { response } = requireAuth(req)
      if (response) return response
      return Response.json(memory.getUsageAnalytics())
    }

    if (path == '/audit') {
      const { response } = requireAuth(req)
      if (response) return response
      const limit = Math.max(1, Math.min(500, Number(new URL(req.url).searchParams.get('limit')) || 200))
      return Response.json({ rows: audit.listAudit(limit) })
    }

    if (path == '/config') {
      const { session, response } = requireAuth(req)
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
      audit.logAudit({ actor: session!.actor, ip, action: 'config.update', details: patch })
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
    ].includes(path)

    if (isFactWritePath) {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 180, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const { session, response } = requireAuth(req)
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

      if (path == '/add' || path == '/facts/add') {
        if (!user && !userId) return new Response('"user" or "userId" is required', { status: 400 })
        if (!fact) return new Response('"fact" is required', { status: 400 })
        const out = memory.addFact({ user: user || userId!, userId, displayName, fact })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.add', userId: out.userId, displayName: out.displayName, after: fact })
        return Response.json({ ok: true, userId: out.userId })
      }

      if (path == '/delete' || path == '/facts/delete') {
        if (!user && !userId) return new Response('"user" or "userId" is required', { status: 400 })
        if (!fact) return new Response('"fact" is required', { status: 400 })
        memory.deleteFact({ user: user || userId!, userId, fact })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.delete', userId, displayName, before: fact })
        return Response.json({ ok: true })
      }

      if (path == '/edit' || path == '/facts/edit') {
        const oldFact = getString(body, 'oldFact')
        const newFact = getString(body, 'newFact')
        if (!user && !userId) return new Response('"user" or "userId" is required', { status: 400 })
        if (!oldFact || !newFact) return new Response('"oldFact" and "newFact" are required', { status: 400 })
        memory.editFact({ user: user || userId!, userId, oldFact, newFact })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.edit', userId, displayName, before: oldFact, after: newFact })
        return Response.json({ ok: true })
      }

      if (path == '/facts/bulk-delete') {
        const targetUserId = userId || user
        const facts = getStringList(body, 'facts')
        if (!targetUserId) return new Response('"userId" is required', { status: 400 })
        if (!facts.length) return new Response('"facts" must be a non-empty array', { status: 400 })
        const removed = memory.bulkDeleteFacts({ userId: targetUserId, facts })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.bulk-delete', userId: targetUserId, details: { removed } })
        return Response.json({ ok: true, removed })
      }

      if (path == '/facts/dedupe') {
        const targetUserId = userId || user
        if (!targetUserId) return new Response('"userId" is required', { status: 400 })
        const removed = memory.dedupeFacts({ userId: targetUserId })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.dedupe', userId: targetUserId, details: { removed } })
        return Response.json({ ok: true, removed })
      }

      if (path == '/facts/cleanup-low-value') {
        const targetUserId = userId || user
        if (!targetUserId) return new Response('"userId" is required', { status: 400 })
        const removed = memory.cleanupLowValueFacts({ userId: targetUserId })
        audit.logAudit({ actor: session!.actor, ip, action: 'fact.cleanup-low-value', userId: targetUserId, details: { removed } })
        return Response.json({ ok: true, removed })
      }
    }

    return renderToReadableStream(<Page />, { bootstrapModules: ['/dist.js'] }).then((s) => new Response(s))
  }
})

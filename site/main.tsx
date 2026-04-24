import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { Page } from './page'
import { renderToReadableStream } from 'react-dom/server'
import * as memory from '../bot/memory'
import * as config from '../bot/config'
import * as audit from '../bot/audit'
import * as auth from '../bot/auth'
import * as dashboardUsers from '../bot/dashboard-users'
import { getSessionSecret } from '../bot/session'

const { outputs } = await Bun.build({ entrypoints: ['./site/page.tsx'], target: 'browser' })
const js = await outputs[0].text()

type SessionPayload = {
  exp: number
  csrf: string
  discordId: string
  displayName: string
  role: dashboardUsers.DashboardRole
  source: 'account' | 'legacy'
}
type Principal = {
  discordId: string
  displayName: string
  role: dashboardUsers.DashboardRole
  source: 'account' | 'legacy'
}
const SESSION_COOKIE = 'gork_session'
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
  if (session.source == 'legacy') {
    return {
      discordId: session.discordId,
      displayName: session.displayName,
      role: session.role,
      source: 'legacy',
    }
  }
  const account = dashboardUsers.findAccount(session.discordId)
  if (!account) return null
  return {
    discordId: account.discordId,
    displayName: account.displayName,
    role: account.role,
    source: 'account',
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
      const principal = resolvePrincipal(session)
      const authStatus = auth.getAuthStatus()
      return Response.json({
        authenticated: Boolean(principal),
        discordId: principal?.discordId ?? null,
        displayName: principal?.displayName ?? null,
        role: principal?.role ?? null,
        sessionSource: principal?.source ?? null,
        csrfToken: session?.csrf ?? null,
        legacyPasswordConfigured: authStatus.passwordConfigured,
        legacyAuthSource: authStatus.authSource,
        updatedAt: authStatus.updatedAt,
        accountCount: dashboardUsers.listAccounts().length,
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
      const discordId = getString(body, 'discordId') || getString(body, 'username')
      const password = getString(body, 'password')
      const account = discordId ? dashboardUsers.verifyCredentials(discordId, password) : null
      if (account) {
        const token = encodeSession({
          exp: Date.now() + sessionTtlMs,
          csrf: randomBytes(24).toString('hex'),
          discordId: account.discordId,
          displayName: account.displayName,
          role: account.role,
          source: 'account',
        })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': makeCookie(token, req) },
        })
      }

      if (!auth.verifyPassword(password)) return new Response('Invalid credentials', { status: 401 })
      const token = encodeSession({
        exp: Date.now() + sessionTtlMs,
        csrf: randomBytes(24).toString('hex'),
        discordId: discordId || 'legacy-admin',
        displayName: 'admin',
        role: 'admin',
        source: 'legacy',
      })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': makeCookie(token, req) },
      })
    }

    if (path == '/signup') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitRateLimit(`signup:ip:${ip}`, 12, 60 * 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const discordId = getString(body, 'discordId')
      const displayName = getString(body, 'displayName')
      const password = getString(body, 'password')
      try {
        if (!discordId) return new Response('"discordId" is required', { status: 400 })
        const account = dashboardUsers.createAccount({ discordId, displayName, password, role: 'user' })
        audit.logAudit({ actor: account.displayName, ip, action: 'account.signup', userId: account.discordId, displayName: account.displayName })
        const token = encodeSession({
          exp: Date.now() + sessionTtlMs,
          csrf: randomBytes(24).toString('hex'),
          discordId: account.discordId,
          displayName: account.displayName,
          role: account.role,
          source: 'account',
        })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': makeCookie(token, req) },
        })
      } catch (error) {
        return responseFromError(error)
      }
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

    if (path == '/account/password') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 60, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const { session, principal, response } = requireAuth(req)
      if (response) return response
      if (principal!.source != 'account') return new Response('Legacy admin sessions cannot use account passwords', { status: 403 })
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const currentPassword = getString(body, 'currentPassword')
      const newPassword = getString(body, 'newPassword')
      try {
        if (!newPassword) return new Response('"newPassword" is required', { status: 400 })
        const updated = dashboardUsers.changePassword({
          discordId: principal!.discordId,
          currentPassword,
          newPassword,
        })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'account.password.update', userId: updated.discordId, displayName: updated.displayName })
        return Response.json(updated)
      } catch (error) {
        return responseFromError(error)
      }
    }

    if (path == '/auth/password') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 60, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const currentPassword = getString(body, 'currentPassword')
      const newPassword = getString(body, 'newPassword')
      try {
        if (!newPassword) return new Response('"newPassword" is required', { status: 400 })
        const status = auth.setPassword(currentPassword, newPassword)
        audit.logAudit({ actor: principal!.displayName, ip, action: 'auth.password.update', details: { authSource: status.authSource } })
        return Response.json(status)
      } catch (error) {
        return responseFromError(error)
      }
    }

    if (path == '/accounts') {
      const { session, principal, response } = requireAdmin(req)
      if (response) return response
      if (req.method == 'GET') return Response.json({ accounts: dashboardUsers.listAccounts() })
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })
      if (!hitGuardedRateLimit('write', ip, 120, 60 * 1000)) return new Response('Too many requests', { status: 429 })
      const csrfErr = requireCsrf(req, session!)
      if (csrfErr) return csrfErr
      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })
      const discordId = getString(body, 'discordId')
      const displayName = getString(body, 'displayName')
      const password = getString(body, 'password')
      const role = getString(body, 'role') == 'admin' ? 'admin' : 'user'
      try {
        if (!discordId) return new Response('"discordId" is required', { status: 400 })
        const account = dashboardUsers.createAccount({ discordId, displayName, password, role })
        audit.logAudit({ actor: principal!.displayName, ip, action: 'account.create', userId: account.discordId, displayName: account.displayName, details: { role: account.role } })
        return Response.json({ ok: true, account })
      } catch (error) {
        return responseFromError(error)
      }
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
        return Response.json({ ok: true, account })
      } catch (error) {
        return responseFromError(error)
      }
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
      const { session, response } = requireAdmin(req)
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
    }

    return renderToReadableStream(<Page />, { bootstrapModules: ['/dist.js'] }).then((s) => new Response(s))
  }
})

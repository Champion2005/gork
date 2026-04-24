import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { atomicWriteJson, atomicWriteText, storagePath } from './storage'

export type UserIdentity = { id: string; name: string }
export type UserMemory = {
    facts: string[]
    displayName?: string
    discordId?: string
    mentions?: number
    cost?: number
    total_tokens_in?: number
    total_tokens_out?: number
    total_tokens_cache?: number
    last_tokens_in?: number
    last_tokens_out?: number
    last_tokens_cache?: number
    [key: string]: unknown
}
export type Memory = Record<string, UserMemory>
type UsageSample = { userId: string; displayName: string; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
type UsageEvent = UsageSample & { at: string }

const DB_FILE = storagePath('db.json')
const USAGE_FILE = storagePath('usage-events.jsonl')

if (!existsSync(DB_FILE)) atomicWriteText(DB_FILE, '{}')
if (!existsSync(USAGE_FILE)) atomicWriteText(USAGE_FILE, '')

const numberOrZero = (value: unknown): number => typeof value == 'number' && Number.isFinite(value) ? value : 0
const now = () => new Date().toISOString()
const isLikelyDiscordId = (value: string) => /^\d{5,}$/.test(value)
const lc = (value: string) => value.trim().toLowerCase()

const normalizeUser = (value: unknown): UserMemory => {
    const user = typeof value == 'object' && value !== null ? value as UserMemory : { facts: [] }
    return {
        ...user,
        facts: Array.isArray(user.facts)
            ? [...new Set(user.facts.map((f) => typeof f == 'string' ? f.trim() : '').filter(Boolean))]
            : [],
        displayName: typeof user.displayName == 'string' && user.displayName.trim() ? user.displayName.trim() : undefined,
        discordId: typeof user.discordId == 'string' && user.discordId.trim() ? user.discordId.trim() : undefined,
        mentions: numberOrZero(user.mentions),
        cost: numberOrZero(user.cost),
        total_tokens_in: numberOrZero(user.total_tokens_in),
        total_tokens_out: numberOrZero(user.total_tokens_out),
        total_tokens_cache: numberOrZero(user.total_tokens_cache),
        last_tokens_in: numberOrZero(user.last_tokens_in),
        last_tokens_out: numberOrZero(user.last_tokens_out),
        last_tokens_cache: numberOrZero(user.last_tokens_cache),
    }
}

const normalizeMemory = (value: unknown): Memory => {
    const raw = typeof value == 'object' && value !== null ? value as Record<string, unknown> : {}
    return Object.fromEntries(Object.entries(raw).map(([key, row]) => [key, normalizeUser(row)]))
}

const readMemoryFile = (): Memory => normalizeMemory(JSON.parse(readFileSync(DB_FILE, 'utf-8')))
const writeMemoryFile = (mem: Memory) => atomicWriteJson(DB_FILE, mem, 4)

export const load = (): Memory => readMemoryFile()
export const save = (mem: Memory) => atomicWriteJson(DB_FILE, mem, 4)

const resolveUserKey = (mem: Memory, user: string, userId?: string, displayName?: string) => {
    if (userId && mem[userId]) return userId
    if (userId) return userId
    if (mem[user]) return user

    const byDisplayName = Object.entries(mem)
        .find(([, row]) => row.displayName && lc(row.displayName) == lc(user))?.[0]
    if (byDisplayName) return byDisplayName

    if (isLikelyDiscordId(user)) return user
    if (displayName && isLikelyDiscordId(displayName)) return displayName
    return user
}

const ensureUser = (mem: Memory, key: string, displayName?: string, discordId?: string): UserMemory => {
    mem[key] = normalizeUser(mem[key])
    if (displayName && displayName.trim()) mem[key].displayName = displayName.trim()
    if (discordId && discordId.trim()) mem[key].discordId = discordId.trim()
    if (!mem[key].displayName) mem[key].displayName = mem[key].discordId ?? key
    return mem[key]
}

export const listUsers = () =>
    Object.entries(load()).map(([id, row]) => {
        const user = normalizeUser(row)
        return {
            id,
            displayName: user.displayName ?? user.discordId ?? id,
            facts: user.facts,
            mentions: user.mentions ?? 0,
            cost: user.cost ?? 0,
            total_tokens_in: user.total_tokens_in ?? 0,
            total_tokens_out: user.total_tokens_out ?? 0,
            total_tokens_cache: user.total_tokens_cache ?? 0,
            last_tokens_in: user.last_tokens_in ?? 0,
            last_tokens_out: user.last_tokens_out ?? 0,
            last_tokens_cache: user.last_tokens_cache ?? 0,
            discordId: user.discordId ?? (isLikelyDiscordId(id) ? id : undefined),
        }
    })

export const upsertUserIdentity = ({ userId, displayName }: { userId: string; displayName: string }) => {
    const mem = load()
    ensureUser(mem, userId, displayName, userId)
    save(mem)
}

export const addFact = ({ user, fact, userId, displayName }: { user: string; fact: string; userId?: string; displayName?: string }) => {
    const mem = load()
    const key = resolveUserKey(mem, user.trim(), userId?.trim(), displayName?.trim())
    const row = ensureUser(mem, key, displayName ?? user, userId)
    row.facts = [...new Set([...row.facts, fact.trim()].filter(Boolean))]
    save(mem)
    return { userId: key, displayName: row.displayName ?? key }
}

export const deleteFact = ({ user, fact, userId }: { user: string; fact: string; userId?: string }) => {
    const mem = load()
    const key = resolveUserKey(mem, user.trim(), userId?.trim())
    if (!mem[key]) return false
    const row = ensureUser(mem, key)
    row.facts = row.facts.filter((entry) => entry != fact)
    save(mem)
    return true
}

export const editFact = ({ user, oldFact, newFact, userId }: { user: string; oldFact: string; newFact: string; userId?: string }) => {
    const mem = load()
    const key = resolveUserKey(mem, user.trim(), userId?.trim())
    if (!mem[key]) return false
    const row = ensureUser(mem, key)
    const index = row.facts.indexOf(oldFact)
    if (index == -1) return false
    row.facts[index] = newFact.trim()
    row.facts = [...new Set(row.facts.filter(Boolean))]
    save(mem)
    return true
}

export const bulkDeleteFacts = ({ userId, facts }: { userId: string; facts: string[] }) => {
    const mem = load()
    if (!mem[userId]) return 0
    const row = ensureUser(mem, userId)
    const before = row.facts.length
    const toDelete = new Set(facts.map((fact) => fact.trim()).filter(Boolean))
    row.facts = row.facts.filter((fact) => !toDelete.has(fact))
    save(mem)
    return before - row.facts.length
}

export const dedupeFacts = ({ userId }: { userId: string }) => {
    const mem = load()
    if (!mem[userId]) return 0
    const row = ensureUser(mem, userId)
    const before = row.facts.length
    const seen = new Set<string>()
    row.facts = row.facts.filter((fact) => {
        const key = lc(fact)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
    save(mem)
    return before - row.facts.length
}

const isLowValueFact = (fact: string) => {
    const trimmed = fact.trim()
    const lower = trimmed.toLowerCase()
    if (!trimmed) return true
    if (trimmed.length < 4) return true
    if (/^n+$/i.test(trimmed)) return true
    if (lower.includes('no explicit fact')) return true
    if (lower.includes('no personal facts')) return true
    if (lower.includes('google search')) return true
    return false
}

export const cleanupLowValueFacts = ({ userId }: { userId: string }) => {
    const mem = load()
    if (!mem[userId]) return 0
    const row = ensureUser(mem, userId)
    const before = row.facts.length
    row.facts = row.facts.filter((fact) => !isLowValueFact(fact))
    save(mem)
    return before - row.facts.length
}

export const deleteUserProfile = ({ userId }: { userId: string }) => {
    const mem = load()
    if (!mem[userId]) return false
    delete mem[userId]
    save(mem)
    return true
}

const appendUsageEvent = (event: UsageEvent) => appendFileSync(USAGE_FILE, `${JSON.stringify(event)}\n`)

export const addUsageSample = ({ userId, displayName, inputTokens, outputTokens, cachedTokens, cost }: UsageSample) => {
    const mem = load()
    const row = ensureUser(mem, userId, displayName, userId)
    row.mentions = (row.mentions ?? 0) + 1
    row.cost = (row.cost ?? 0) + numberOrZero(cost)
    row.total_tokens_in = (row.total_tokens_in ?? 0) + numberOrZero(inputTokens)
    row.total_tokens_out = (row.total_tokens_out ?? 0) + numberOrZero(outputTokens)
    row.total_tokens_cache = (row.total_tokens_cache ?? 0) + numberOrZero(cachedTokens)
    row.last_tokens_in = numberOrZero(inputTokens)
    row.last_tokens_out = numberOrZero(outputTokens)
    row.last_tokens_cache = numberOrZero(cachedTokens)
    save(mem)
    appendUsageEvent({ userId, displayName: displayName.trim() || userId, inputTokens, outputTokens, cachedTokens, cost, at: now() })
}

export const loadUsageEvents = (limit = 5000): UsageEvent[] =>
    readFileSync(USAGE_FILE, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-Math.max(1, limit))
        .map((line) => {
            try {
                return JSON.parse(line) as UsageEvent
            } catch {
                return null
            }
        })
        .filter((row): row is UsageEvent => row !== null)

const dayKey = (isoDate: string) => isoDate.slice(0, 10)
const weekKey = (date: Date) => {
    const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    const weekday = (copy.getUTCDay() + 6) % 7
    copy.setUTCDate(copy.getUTCDate() - weekday)
    return copy.toISOString().slice(0, 10)
}

export const getUsageAnalytics = () => {
    const events = loadUsageEvents()
    const daily = new Map<string, { date: string; mentions: number; cost: number; tokensIn: number; tokensOut: number; tokensCache: number }>()
    const weekly = new Map<string, { weekStart: string; mentions: number; cost: number; tokensIn: number; tokensOut: number; tokensCache: number }>()
    const topUsers7d = new Map<string, { userId: string; displayName: string; cost: number; mentions: number }>()
    const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000

    for (const event of events) {
        const date = new Date(event.at)
        if (!Number.isFinite(date.getTime())) continue

        const day = dayKey(event.at)
        const dayRow = daily.get(day) ?? { date: day, mentions: 0, cost: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 }
        dayRow.mentions += 1
        dayRow.cost += numberOrZero(event.cost)
        dayRow.tokensIn += numberOrZero(event.inputTokens)
        dayRow.tokensOut += numberOrZero(event.outputTokens)
        dayRow.tokensCache += numberOrZero(event.cachedTokens)
        daily.set(day, dayRow)

        const week = weekKey(date)
        const weekRow = weekly.get(week) ?? { weekStart: week, mentions: 0, cost: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 }
        weekRow.mentions += 1
        weekRow.cost += numberOrZero(event.cost)
        weekRow.tokensIn += numberOrZero(event.inputTokens)
        weekRow.tokensOut += numberOrZero(event.outputTokens)
        weekRow.tokensCache += numberOrZero(event.cachedTokens)
        weekly.set(week, weekRow)

        if (date.getTime() >= since7d) {
            const top = topUsers7d.get(event.userId) ?? { userId: event.userId, displayName: event.displayName || event.userId, cost: 0, mentions: 0 }
            top.cost += numberOrZero(event.cost)
            top.mentions += 1
            top.displayName = event.displayName || top.displayName
            topUsers7d.set(event.userId, top)
        }
    }

    const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
    const weeklyRows = [...weekly.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).slice(-12)
    const total7dCost = dailyRows.slice(-7).reduce((sum, row) => sum + row.cost, 0)
    const avgDailyCost7d = total7dCost / 7

    return {
        daily: dailyRows,
        weekly: weeklyRows,
        burnRate: {
            costLast7d: total7dCost,
            avgDailyCost7d,
            projectedMonthlyCost: avgDailyCost7d * 30,
        },
        topUsers7d: [...topUsers7d.values()].sort((a, b) => b.cost - a.cost).slice(0, 10),
    }
}

export const buildFacts = (users: UserIdentity[]) => {
    const mem = load()
    const userIds = new Set(users.map((user) => user.id))
    const names = new Set(users.map((user) => lc(user.name)))

    return Object.entries(mem)
        .filter(([id, row]) => userIds.has(id) || (row.displayName ? names.has(lc(row.displayName)) : false))
        .map(([id, row]) => {
            const user = normalizeUser(row)
            const label = user.displayName ?? user.discordId ?? id
            return `${label} (${id}):\n${user.facts.map((fact) => ` - ${fact}`).join('\n')}`
        })
        .join('\n')
}

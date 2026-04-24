import { existsSync, readFileSync, writeFileSync } from 'fs';

export type UserMemory = {
    facts: string[]
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
type Memory = Record<string, UserMemory>
type UsageSample = { user: string; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }

if(!existsSync('db.json')) writeFileSync('db.json', '{}')
export const load = (): Memory => JSON.parse(readFileSync('db.json', 'utf-8'))
export const save = (mem: Memory) => writeFileSync('db.json', JSON.stringify(mem, null, 4))

const numberOrZero = (value: unknown): number => typeof value == 'number' && Number.isFinite(value) ? value : 0

const normalizeUser = (value: unknown): UserMemory => {
    const user = typeof value == 'object' && value !== null ? value as UserMemory : { facts: [] }
    return {
        ...user,
        facts: Array.isArray(user.facts) ? user.facts.filter((f): f is string => typeof f == 'string') : [],
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

const ensureUser = (mem: Memory, user: string): UserMemory => {
    mem[user] = normalizeUser(mem[user])
    return mem[user]
}

export const addFact = ({ user, fact }: { user: string, fact: string }) => {
    const m = load()
    const row = ensureUser(m, user)
    row.facts = [...new Set([...row.facts, fact])]
    save(m)
}

export const deleteFact = ({ user, fact }: { user: string, fact: string }) => {
    const m: Memory = load()
    if (!m[user]) return
    const row = ensureUser(m, user)
    row.facts = row.facts.filter(f => f != fact)
    save(m)
}

export const editFact = ({ user, oldFact, newFact }: { user: string, oldFact: string, newFact: string }) => {
    const m: Memory = load()
    if (!m[user]) return
    const row = ensureUser(m, user)
    const idx = row.facts.indexOf(oldFact)
    if (idx !== -1) {
        row.facts[idx] = newFact
        save(m)
    }
}

export const addUsageSample = ({ user, inputTokens, outputTokens, cachedTokens, cost }: UsageSample) => {
    const m = load()
    const row = ensureUser(m, user)
    row.mentions = (row.mentions ?? 0) + 1
    row.cost = (row.cost ?? 0) + numberOrZero(cost)
    row.total_tokens_in = (row.total_tokens_in ?? 0) + numberOrZero(inputTokens)
    row.total_tokens_out = (row.total_tokens_out ?? 0) + numberOrZero(outputTokens)
    row.total_tokens_cache = (row.total_tokens_cache ?? 0) + numberOrZero(cachedTokens)
    row.last_tokens_in = numberOrZero(inputTokens)
    row.last_tokens_out = numberOrZero(outputTokens)
    row.last_tokens_cache = numberOrZero(cachedTokens)
    save(m)
}

export const buildFacts = (users: string[]) => 
    Object.entries(load())
        .filter(([name]) => users.includes(name))
        .map(([name, row]) => `${name}:\n${normalizeUser(row).facts.map((fact) => ` - ${fact}`).join('\n')}`).join('\n')

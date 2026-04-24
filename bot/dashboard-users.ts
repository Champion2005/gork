import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { atomicWriteJson, atomicWriteText, storagePath } from './storage'

export type DashboardRole = 'admin' | 'user'
type StoredAccount = {
    discordId: string
    displayName: string
    role: DashboardRole
    passwordSalt: string
    passwordHash: string
    createdAt: string
    updatedAt: string
    lastSeenAt?: string
}

export type DashboardAccount = Omit<StoredAccount, 'passwordSalt' | 'passwordHash'>

const USERS_FILE = storagePath('dashboard-users.json')
const MIN_PASSWORD_LENGTH = 12

const ensureFile = () => {
    if (!existsSync(USERS_FILE)) atomicWriteText(USERS_FILE, '[]')
}

const normalizeDiscordId = (value: string) => value.trim()
const normalizeDisplayName = (value: string | undefined, fallback: string) =>
    typeof value == 'string' && value.trim() ? value.trim() : fallback
const normalizeRole = (value: unknown): DashboardRole => value == 'admin' ? 'admin' : 'user'
const now = () => new Date().toISOString()
const secureEq = (a: string, b: string) => {
    const aa = Buffer.from(a)
    const bb = Buffer.from(b)
    if (aa.length != bb.length) return false
    return timingSafeEqual(aa, bb)
}

const hashPassword = (password: string, salt = randomBytes(16).toString('hex')) => {
    const hash = scryptSync(password, salt, 64).toString('base64url')
    return { salt, hash }
}

const normalizeAccount = (value: unknown): StoredAccount | null => {
    const raw = typeof value == 'object' && value !== null ? value as Partial<StoredAccount> : null
    if (!raw) return null
    if (typeof raw.discordId != 'string' || !raw.discordId.trim()) return null
    if (typeof raw.passwordSalt != 'string' || typeof raw.passwordHash != 'string') return null
    if (typeof raw.createdAt != 'string' || typeof raw.updatedAt != 'string') return null
    return {
        discordId: normalizeDiscordId(raw.discordId),
        displayName: normalizeDisplayName(raw.displayName, normalizeDiscordId(raw.discordId)),
        role: normalizeRole(raw.role),
        passwordSalt: raw.passwordSalt,
        passwordHash: raw.passwordHash,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        lastSeenAt: typeof raw.lastSeenAt == 'string' ? raw.lastSeenAt : undefined,
    }
}

const loadAll = (): StoredAccount[] => {
    ensureFile()
    try {
        const raw = JSON.parse(readFileSync(USERS_FILE, 'utf-8')) as unknown
        return Array.isArray(raw) ? raw.map(normalizeAccount).filter((row): row is StoredAccount => row !== null) : []
    } catch (error) {
        console.error('CRITICAL: Failed to parse dashboard-users.json', error)
        throw error
    }
}

const saveAll = (rows: StoredAccount[]) => atomicWriteJson(USERS_FILE, rows)

const toPublic = ({ passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...rest }: StoredAccount): DashboardAccount => rest

export const listAccounts = (): DashboardAccount[] => loadAll().map(toPublic)

export const findAccount = (discordId: string) =>
    loadAll().find((row) => row.discordId == normalizeDiscordId(discordId))

export const hasAccounts = () => loadAll().length > 0

export const verifyCredentials = (discordId: string, password: string) => {
    const row = findAccount(discordId)
    if (!row) return null
    const derived = scryptSync(password, row.passwordSalt, 64).toString('base64url')
    return secureEq(derived, row.passwordHash) ? toPublic(row) : null
}

export const createAccount = ({
    discordId,
    displayName,
    password,
    role = 'user',
}: {
    discordId: string
    displayName?: string
    password: string
    role?: DashboardRole
}) => {
    const id = normalizeDiscordId(discordId)
    if (!id) throw new Error('Discord ID is required')
    if (!/^\d{5,}$/.test(id)) throw new Error('Discord ID must be numeric')
    if (password.trim().length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)

    const rows = loadAll()
    if (rows.some((row) => row.discordId == id)) throw new Error('Account already exists')

    const { salt, hash } = hashPassword(password.trim())
    const timestamp = now()
    const row: StoredAccount = {
        discordId: id,
        displayName: normalizeDisplayName(displayName, id),
        role,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: timestamp,
        updatedAt: timestamp,
    }
    saveAll([...rows, row])
    return toPublic(row)
}

export const upsertSeenIdentity = ({ discordId, displayName }: { discordId: string; displayName: string }) => {
    const id = normalizeDiscordId(discordId)
    const rows = loadAll()
    let changed = false
    const next = rows.map((row) => {
        if (row.discordId != id) return row
        changed = true
        return {
            ...row,
            displayName: normalizeDisplayName(displayName, row.displayName),
            lastSeenAt: now(),
            updatedAt: now(),
        }
    })
    if (changed) saveAll(next)
    return changed
}

export const setRole = ({ discordId, role }: { discordId: string; role: DashboardRole }) => {
    const id = normalizeDiscordId(discordId)
    const rows = loadAll()
    let found = false
    const timestamp = now()
    const next = rows.map((row) => {
        if (row.discordId != id) return row
        found = true
        return { ...row, role, updatedAt: timestamp }
    })
    if (!found) return null
    saveAll(next)
    return toPublic(next.find((row) => row.discordId == id)!)
}

export const changePassword = ({ discordId, currentPassword, newPassword }: { discordId: string; currentPassword: string; newPassword: string }) => {
    const id = normalizeDiscordId(discordId)
    const rows = loadAll()
    const row = rows.find((entry) => entry.discordId == id)
    if (!row) throw new Error('Account not found')
    const derived = scryptSync(currentPassword.trim(), row.passwordSalt, 64).toString('base64url')
    if (!secureEq(derived, row.passwordHash)) throw new Error('Current password is incorrect')
    if (newPassword.trim().length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)

    const { salt, hash } = hashPassword(newPassword.trim())
    const updatedAt = now()
    const next = rows.map((entry) => entry.discordId == id ? { ...entry, passwordSalt: salt, passwordHash: hash, updatedAt } : entry)
    saveAll(next)
    return toPublic(next.find((entry) => entry.discordId == id)!)
}

export const resetPassword = ({ discordId, newPassword }: { discordId: string; newPassword: string }) => {
    const id = normalizeDiscordId(discordId)
    const rows = loadAll()
    const row = rows.find((entry) => entry.discordId == id)
    if (!row) throw new Error('Account not found')
    if (newPassword.trim().length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)

    const { salt, hash } = hashPassword(newPassword.trim())
    const updatedAt = now()
    const next = rows.map((entry) => entry.discordId == id ? { ...entry, passwordSalt: salt, passwordHash: hash, updatedAt } : entry)
    saveAll(next)
    return toPublic(next.find((entry) => entry.discordId == id)!)
}

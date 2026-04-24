import { existsSync, readFileSync } from 'fs'
import { atomicWriteJson, atomicWriteText, storagePath } from './storage'

export type DashboardRole = 'admin' | 'user'
type StoredAccount = {
    discordId: string
    displayName: string
    role: DashboardRole
    createdAt: string
    updatedAt: string
    lastSeenAt?: string
}

export type DashboardAccount = StoredAccount

const USERS_FILE = storagePath('dashboard-users.json')
const PRIMARY_ADMIN_ID = process.env.GORK_ADMIN_DISCORD_ID?.trim() || '673358575506292746'

const ensureFile = () => {
    if (!existsSync(USERS_FILE)) atomicWriteText(USERS_FILE, '[]')
}

const normalizeDiscordId = (value: string) => value.trim()
const normalizeDisplayName = (value: string | undefined, fallback: string) =>
    typeof value == 'string' && value.trim() ? value.trim() : fallback
const normalizeRole = (value: unknown): DashboardRole => value == 'admin' ? 'admin' : 'user'
const enforceAdminRole = (row: StoredAccount): StoredAccount =>
    row.discordId == PRIMARY_ADMIN_ID ? { ...row, role: 'admin' } : row
const now = () => new Date().toISOString()

const normalizeAccount = (value: unknown): StoredAccount | null => {
    const raw = typeof value == 'object' && value !== null ? value as Partial<StoredAccount> : null
    if (!raw) return null
    if (typeof raw.discordId != 'string' || !raw.discordId.trim()) return null
    if (typeof raw.createdAt != 'string' || typeof raw.updatedAt != 'string') return null
    return enforceAdminRole({
        discordId: normalizeDiscordId(raw.discordId),
        displayName: normalizeDisplayName(raw.displayName, normalizeDiscordId(raw.discordId)),
        role: normalizeRole(raw.role),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        lastSeenAt: typeof raw.lastSeenAt == 'string' ? raw.lastSeenAt : undefined,
    })
}

const loadAll = (): StoredAccount[] => {
    ensureFile()
    try {
        const raw = JSON.parse(readFileSync(USERS_FILE, 'utf-8')) as unknown
        const rows = Array.isArray(raw) ? raw.map(normalizeAccount).filter((row): row is StoredAccount => row !== null) : []
        const sanitized = rows.map(enforceAdminRole)
        if (Array.isArray(raw) && JSON.stringify(raw) !== JSON.stringify(sanitized)) saveAll(sanitized)
        return sanitized
    } catch (error) {
        console.error('CRITICAL: Failed to parse dashboard-users.json', error)
        throw error
    }
}

const saveAll = (rows: StoredAccount[]) => atomicWriteJson(USERS_FILE, rows)

export const listAccounts = (): DashboardAccount[] => loadAll()

export const findAccount = (discordId: string) =>
    loadAll().find((row) => row.discordId == normalizeDiscordId(discordId))

export const hasAccounts = () => loadAll().length > 0

export const syncAccount = ({
    discordId,
    displayName,
}: {
    discordId: string
    displayName?: string
}) => {
    const id = normalizeDiscordId(discordId)
    if (!id) throw new Error('Discord ID is required')
    if (!/^\d{5,}$/.test(id)) throw new Error('Discord ID must be numeric')

    const rows = loadAll()
    const timestamp = now()
    const next = rows.some((row) => row.discordId == id)
        ? rows.map((row) => row.discordId == id
            ? enforceAdminRole({
                ...row,
                displayName: normalizeDisplayName(displayName, row.displayName),
                lastSeenAt: timestamp,
                updatedAt: timestamp,
                role: row.role == 'admin' || id == PRIMARY_ADMIN_ID ? 'admin' : row.role,
            })
            : row)
        : [...rows, enforceAdminRole({
            discordId: id,
            displayName: normalizeDisplayName(displayName, id),
            role: id == PRIMARY_ADMIN_ID ? 'admin' : 'user',
            createdAt: timestamp,
            updatedAt: timestamp,
            lastSeenAt: timestamp,
        })]
    saveAll(next.map(enforceAdminRole))
    return next.find((row) => row.discordId == id)!
}

export const upsertSeenIdentity = ({ discordId, displayName }: { discordId: string; displayName: string }) => {
    syncAccount({ discordId, displayName })
    return true
}

export const setRole = ({ discordId, role }: { discordId: string; role: DashboardRole }) => {
    const id = normalizeDiscordId(discordId)
    const rows = loadAll()
    let found = false
    const timestamp = now()
    const next = rows.map((row) => {
        if (row.discordId != id) return row
        found = true
        return enforceAdminRole({ ...row, role: id == PRIMARY_ADMIN_ID ? 'admin' : role, updatedAt: timestamp })
    })
    if (!found) return null
    saveAll(next)
    return next.find((row) => row.discordId == id)!
}

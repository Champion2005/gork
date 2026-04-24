import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { atomicWriteJson, storagePath } from './storage'

type StoredPassword = {
    salt: string
    hash: string
    updatedAt: string
}

const AUTH_FILE = storagePath('dashboard-auth.json')
const MIN_PASSWORD_LENGTH = 12

const legacyPassword = () => process.env.DASHBOARD_PASSWORD?.trim() ?? ''
const fallbackPassword = () => legacyPassword() || process.env.DISCORD_TOKEN?.trim() || process.env.OPENROUTER_API_KEY?.trim() || ''

const secureEq = (a: string, b: string) => {
    const aa = Buffer.from(a)
    const bb = Buffer.from(b)
    if (aa.length != bb.length) return false
    return timingSafeEqual(aa, bb)
}

const loadStored = (): StoredPassword | null => {
    if (!existsSync(AUTH_FILE)) return null
    try {
        const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf-8')) as Partial<StoredPassword>
        if (typeof raw.salt != 'string' || typeof raw.hash != 'string' || typeof raw.updatedAt != 'string') return null
        return raw as StoredPassword
    } catch {
        return null
    }
}

const hashPassword = (password: string, salt = randomBytes(16).toString('hex')) => {
    const hash = scryptSync(password, salt, 64).toString('base64url')
    return { salt, hash }
}

const verifyStored = (candidate: string, stored: StoredPassword) => {
    const derived = scryptSync(candidate, stored.salt, 64).toString('base64url')
    return secureEq(derived, stored.hash)
}

export const getAuthStatus = () => {
    const stored = loadStored()
    if (stored) {
        return {
            passwordConfigured: true,
            authSource: 'stored' as const,
            updatedAt: stored.updatedAt,
        }
    }

    const fallback = fallbackPassword()
    if (fallback) {
        return {
            passwordConfigured: true,
            authSource: legacyPassword() ? 'env' as const : 'legacy-env' as const,
            updatedAt: null,
        }
    }

    return {
        passwordConfigured: false,
        authSource: 'none' as const,
        updatedAt: null,
    }
}

export const verifyPassword = (candidate: string) => {
    const stored = loadStored()
    if (stored) return verifyStored(candidate, stored)
    const fallback = fallbackPassword()
    if (!fallback) return false
    return secureEq(candidate, fallback)
}

export const setPassword = (currentPassword: string, newPassword: string) => {
    const current = currentPassword.trim()
    const next = newPassword.trim()
    if (next.length < MIN_PASSWORD_LENGTH) throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`)

    const stored = loadStored()
    if (stored) {
        if (!verifyStored(current, stored)) throw new Error('Current password is incorrect')
    } else {
        const fallback = fallbackPassword()
        if (fallback) {
            if (!secureEq(current, fallback)) throw new Error('Current password is incorrect')
        } else if (current) {
            throw new Error('Current password is incorrect')
        }
    }

    const updatedAt = new Date().toISOString()
    const { salt, hash } = hashPassword(next)
    atomicWriteJson(AUTH_FILE, { salt, hash, updatedAt })
    return getAuthStatus()
}

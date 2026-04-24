import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'

export type AuditEvent = {
    id: string
    at: string
    actor: string
    ip: string
    action: string
    userId?: string
    displayName?: string
    before?: unknown
    after?: unknown
    details?: Record<string, unknown>
}

const AUDIT_FILE = 'audit-log.jsonl'

const ensureAuditFile = () => {
    if (!existsSync(AUDIT_FILE)) writeFileSync(AUDIT_FILE, '')
}

const now = () => new Date().toISOString()
const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export const logAudit = (event: Omit<AuditEvent, 'id' | 'at'>) => {
    ensureAuditFile()
    const row: AuditEvent = { id: randomId(), at: now(), ...event }
    appendFileSync(AUDIT_FILE, `${JSON.stringify(row)}\n`)
    return row
}

export const listAudit = (limit = 200): AuditEvent[] => {
    ensureAuditFile()
    const rows = readFileSync(AUDIT_FILE, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line) as AuditEvent
            } catch {
                return null
            }
        })
        .filter((row): row is AuditEvent => row !== null)

    return rows.slice(-Math.max(1, limit)).reverse()
}

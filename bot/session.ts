import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { atomicWriteText, storagePath } from './storage'

const SESSION_FILE = storagePath('dashboard-session-secret.txt')

const readSecretFile = () => {
    if (!existsSync(SESSION_FILE)) {
        atomicWriteText(SESSION_FILE, randomBytes(32).toString('hex'))
    }
    return readFileSync(SESSION_FILE, 'utf-8').trim()
}

export const getSessionSecret = () =>
    process.env.DASHBOARD_SESSION_SECRET?.trim() || readSecretFile()

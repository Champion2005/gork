import { existsSync, readFileSync, writeFileSync } from 'fs'

export type BotConfig = {
    model: string
    historyDepth: number
    replyMaxLength: number
    generalBrief: boolean
    degeneracyMode: boolean
    webSearchEnabled: boolean
    readOnlyMode: boolean
    mutedUserIds: string[]
    deniedUserIds: string[]
}

const CONFIG_FILE = 'bot-config.json'
const defaults: BotConfig = {
    model: 'x-ai/grok-4.20',
    historyDepth: 12,
    replyMaxLength: 1990,
    generalBrief: true,
    degeneracyMode: true,
    webSearchEnabled: true,
    readOnlyMode: false,
    mutedUserIds: [],
    deniedUserIds: [],
}

const toBool = (value: unknown, fallback: boolean) => typeof value == 'boolean' ? value : fallback
const toNum = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = typeof value == 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.floor(parsed)))
}
const toStringList = (value: unknown) => {
    if (!Array.isArray(value)) return []
    return [...new Set(value
        .map((item) => typeof item == 'string' ? item.trim() : '')
        .filter(Boolean))]
}

const normalize = (value: unknown): BotConfig => {
    const raw = typeof value == 'object' && value !== null ? value as Partial<BotConfig> : {}
    return {
        model: typeof raw.model == 'string' && raw.model.trim() ? raw.model.trim() : defaults.model,
        historyDepth: toNum(raw.historyDepth, defaults.historyDepth, 2, 40),
        replyMaxLength: toNum(raw.replyMaxLength, defaults.replyMaxLength, 100, 1990),
        generalBrief: toBool(raw.generalBrief, defaults.generalBrief),
        degeneracyMode: toBool(raw.degeneracyMode, defaults.degeneracyMode),
        webSearchEnabled: toBool(raw.webSearchEnabled, defaults.webSearchEnabled),
        readOnlyMode: toBool(raw.readOnlyMode, defaults.readOnlyMode),
        mutedUserIds: toStringList(raw.mutedUserIds),
        deniedUserIds: toStringList(raw.deniedUserIds),
    }
}

const ensureConfigFile = () => {
    if (!existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2))
}

export const loadConfig = (): BotConfig => {
    ensureConfigFile()
    return normalize(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))
}

export const saveConfig = (next: BotConfig) => writeFileSync(CONFIG_FILE, JSON.stringify(normalize(next), null, 2))

export const updateConfig = (patch: Partial<BotConfig>) => {
    const current = loadConfig()
    const merged = normalize({ ...current, ...patch })
    saveConfig(merged)
    return merged
}

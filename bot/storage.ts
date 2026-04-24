import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

const defaultRoot = () => {
    const dataDir = process.env.GORK_DATA_DIR?.trim()
    if (dataDir) return dataDir
    return existsSync('/data') ? '/data' : process.cwd()
}

export const storageRoot = () => {
    const root = defaultRoot()
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return root
}

export const storagePath = (...parts: string[]) => join(storageRoot(), ...parts)

export const atomicWriteText = (path: string, text: string) => {
    const tmpPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(tmpPath, text, 'utf-8')
    renameSync(tmpPath, path)
}

export const atomicWriteJson = (path: string, data: unknown, indent = 2) => {
    atomicWriteText(path, JSON.stringify(data, null, indent))
}

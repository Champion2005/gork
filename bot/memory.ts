import { existsSync, readFileSync, writeFileSync } from 'fs';
type Memory = Record<string, { facts: string[] }>

if(!existsSync('db.json')) writeFileSync('db.json', '{}')
export const load = (): Record<string, { facts: string[] }> => JSON.parse(readFileSync('db.json', 'utf-8'))
export const save = (mem: Record<string, { facts: string[] }>) => writeFileSync('db.json', JSON.stringify(mem, null, 4))

export const addFact = ({ user, fact }: { user: string, fact: string }) => {
    const m: Memory = { [user]: { facts: [] }, ...load() }
    m[user].facts = [...new Set([...m[user].facts, fact])]
    save(m)
}

export const deleteFact = ({ user, fact }: { user: string, fact: string }) => {
    const m: Memory = load()
    if (!m[user]) return
    m[user].facts = m[user].facts.filter(f => f != fact)
    save(m)
}

export const buildFacts = (users: string[]) => 
    Object.entries(load())
        .filter(([k]) => users.includes(k))
        .map(([k, v]) => `${k}:\n${v.facts.map((f) => ` - ${f}`).join('\n')}`).join('\n')
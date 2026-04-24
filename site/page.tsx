import { hydrateRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { App, Btn, Card, D, H1, H2, Input } from 'b44ui';

const add = (user: string, fact: string) => fetch('/add', { method: 'POST', body: JSON.stringify({ user, fact }) }).then(() => location.reload())
const del = (user: string, fact: string) => fetch('/delete', { method: 'POST', body: JSON.stringify({ user, fact }) }).then(() => location.reload())
const edit = (user: string, oldFact: string, newFact: string) => fetch('/edit', { method: 'POST', body: JSON.stringify({ user, oldFact, newFact }) }).then(() => location.reload())

export const Page = () => {
    const [data, setData] = useState<Record<string, { facts: string[] }>>({})
    const [user, setUser] = useState('b4444'), [fact, setFact] = useState('yeah')
    const [editingFact, setEditingFact] = useState<{ u: string, f: string } | null>(null)
    const [editValue, setEditValue] = useState('')

    useEffect(() => void fetch('/load').then(res => res.json()).then(setData) , [])

    return <>
        <head>
            <meta charSet='utf-8' />
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/B44ken/b44ui@main/dist/styles.css" />
            <title>dashbork</title>
        </head>
        <App align='center'>
            <H1 p={6}>fun facts</H1>
            {Object.entries(data).map(([u, { facts }]) => <Card wd={0.6} key={u}>
                <D row align='mid'><H2>{u}</H2><Btn click={() => setUser(u)}>add</Btn></D>
                {facts.map(f => <D key={f} style={{ textAlign: 'left' }}>
                    {editingFact?.u === u && editingFact?.f === f ? (
                        <D row align='mid'>
                            <Btn sm ghost click={() => setEditingFact(null)}>x</Btn>
                            <Input grow state={[editValue, setEditValue]} />
                            <D p={2}></D>
                            <Btn click={() => edit(u, f, editValue)}>save</Btn>
                        </D>
                    ) : (
                        <D row align='mid'>
                            <Btn sm ghost click={() => del(u, f)}>×</Btn>
                            <Btn sm ghost click={() => { setEditingFact({ u, f }); setEditValue(f); }}>✎</Btn>
                            <D>{f}</D>
                        </D>
                    )}
                </D>)}
                {u == user && <D row style={{ textAlign: 'left' }}>
                    <Btn sm ghost click={() => setUser(u)}>x</Btn>
                    <Input grow state={[fact, setFact]} placeholder='fun fact' />
                    <D p={2}></D>
                    <Btn click={() => add(user, fact)}>ok</Btn>
                </D>}
            </Card>)}
        </App>
    </>
}

if(typeof window != 'undefined') hydrateRoot(document, <Page />)
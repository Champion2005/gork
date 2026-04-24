import { hydrateRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'

type MemoryData = Record<string, { facts: string[] }>
type EditingState = { user: string; oldFact: string } | null

const postJson = async (path: string, data: Record<string, string>) => {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
}

export const Page = () => {
    const [data, setData] = useState<MemoryData>({})
    const [user, setUser] = useState('')
    const [fact, setFact] = useState('')
    const [editingFact, setEditingFact] = useState<EditingState>(null)
    const [editValue, setEditValue] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const loadData = async () => {
        const res = await fetch('/load')
        setData(await res.json())
    }

    const runAction = async (action: () => Promise<void>) => {
        setBusy(true)
        setError('')
        try {
            await action()
            await loadData()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const add = async () => {
        const cleanUser = user.trim()
        const cleanFact = fact.trim()
        if (!cleanUser || !cleanFact) {
            setError('Both user and fact are required')
            return
        }

        await runAction(async () => {
            await postJson('/add', { user: cleanUser, fact: cleanFact })
            setFact('')
        })
    }

    const del = async (targetUser: string, targetFact: string) => {
        await runAction(() => postJson('/delete', { user: targetUser, fact: targetFact }))
    }

    const edit = async (targetUser: string, oldFact: string, newFact: string) => {
        const cleanFact = newFact.trim()
        if (!cleanFact) {
            setError('Fact cannot be empty')
            return
        }

        await runAction(async () => {
            await postJson('/edit', { user: targetUser, oldFact, newFact: cleanFact })
            setEditingFact(null)
            setEditValue('')
        })
    }

    useEffect(() => { void loadData() }, [])

    return <>
        <head>
            <meta charSet='utf-8' />
            <meta name='viewport' content='width=device-width, initial-scale=1' />
            <script src='https://cdn.tailwindcss.com'></script>
            <title>gork memory dashboard</title>
        </head>
        <main className='min-h-screen bg-slate-950 text-slate-100'>
            <div className='mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6'>
                <header className='rounded-xl border border-slate-800 bg-slate-900 p-5'>
                    <h1 className='text-2xl font-semibold'>Gork Memory Dashboard</h1>
                    <p className='mt-2 text-sm text-slate-300'>Manage user facts in one place.</p>
                </header>

                <section className='rounded-xl border border-slate-800 bg-slate-900 p-5'>
                    <h2 className='mb-4 text-lg font-medium'>Add fact</h2>
                    <div className='grid gap-3 sm:grid-cols-[1fr_2fr_auto]'>
                        <input
                            className='rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring'
                            value={user}
                            onChange={e => setUser(e.target.value)}
                            placeholder='username'
                            disabled={busy}
                        />
                        <input
                            className='rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring'
                            value={fact}
                            onChange={e => setFact(e.target.value)}
                            placeholder='fun fact'
                            disabled={busy}
                        />
                        <button
                            className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
                            onClick={() => void add()}
                            disabled={busy}
                        >
                            Add
                        </button>
                    </div>
                    {error && <p className='mt-3 text-sm text-red-300'>{error}</p>}
                </section>

                <section className='space-y-4'>
                    {Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([u, { facts }]) => (
                        <article className='rounded-xl border border-slate-800 bg-slate-900 p-5' key={u}>
                            <div className='mb-3 flex items-center justify-between gap-2'>
                                <h3 className='text-base font-semibold'>{u}</h3>
                                <button
                                    className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800'
                                    onClick={() => setUser(u)}
                                    disabled={busy}
                                >
                                    Use in Add form
                                </button>
                            </div>

                            {facts.length === 0 && <p className='text-sm text-slate-400'>No facts saved yet.</p>}
                            <ul className='space-y-2'>
                                {facts.map((f, i) => (
                                    <li className='rounded-md border border-slate-800 bg-slate-950 p-3' key={`${u}-${i}-${f}`}>
                                        {editingFact?.user === u && editingFact.oldFact === f ? (
                                            <div className='flex flex-col gap-2 sm:flex-row'>
                                                <input
                                                    className='flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none ring-blue-500 focus:ring'
                                                    value={editValue}
                                                    onChange={e => setEditValue(e.target.value)}
                                                    disabled={busy}
                                                />
                                                <div className='flex gap-2'>
                                                    <button
                                                        className='rounded-md bg-blue-600 px-3 py-2 text-sm hover:bg-blue-500 disabled:opacity-60'
                                                        onClick={() => void edit(u, f, editValue)}
                                                        disabled={busy}
                                                    >
                                                        Save
                                                    </button>
                                                    <button
                                                        className='rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60'
                                                        onClick={() => { setEditingFact(null); setEditValue('') }}
                                                        disabled={busy}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                                                <p className='text-sm text-slate-200'>{f}</p>
                                                <div className='flex shrink-0 gap-2'>
                                                    <button
                                                        className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800 disabled:opacity-60'
                                                        onClick={() => { setEditingFact({ user: u, oldFact: f }); setEditValue(f) }}
                                                        disabled={busy}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        className='rounded-md border border-red-800 px-3 py-1 text-xs text-red-200 hover:bg-red-950 disabled:opacity-60'
                                                        onClick={() => void del(u, f)}
                                                        disabled={busy}
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </article>
                    ))}
                </section>
            </div>
        </main>
    </>
}

if(typeof window != 'undefined') hydrateRoot(document, <Page />)

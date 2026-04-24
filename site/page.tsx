import { hydrateRoot } from 'react-dom/client'
import { useEffect, useMemo, useState } from 'react'

type AuthState = {
    authenticated: boolean
    discordId: string | null
    displayName: string | null
    role: 'admin' | 'user' | null
    csrfToken: string | null
    sessionSource: 'account' | 'legacy' | null
    legacyPasswordConfigured: boolean
    legacyAuthSource: 'stored' | 'env' | 'legacy-env' | 'none'
    updatedAt: string | null
    accountCount: number
    discordOAuthConfigured: boolean
}
type UserRow = {
    id: string
    displayName: string
    facts: string[]
    mentions: number
    cost: number
    total_tokens_in: number
    total_tokens_out: number
    total_tokens_cache: number
}
type DashboardAccountRow = {
    discordId: string
    displayName: string
    role: 'admin' | 'user'
    createdAt: string
    updatedAt: string
    lastSeenAt?: string
}
type BotConfig = {
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
type AuditRow = {
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
type Analytics = {
    daily: { date: string; mentions: number; cost: number; tokensIn: number; tokensOut: number; tokensCache: number }[]
    weekly: { weekStart: string; mentions: number; cost: number; tokensIn: number; tokensOut: number; tokensCache: number }[]
    burnRate: { costLast7d: number; avgDailyCost7d: number; projectedMonthlyCost: number }
    topUsers7d: { userId: string; displayName: string; cost: number; mentions: number }[]
}

type Tab = 'facts' | 'leaderboard' | 'account' | 'users' | 'analytics' | 'config' | 'audit'
type SortKey = 'displayName' | 'mentions' | 'total_tokens_in' | 'total_tokens_out' | 'total_tokens_cache' | 'cost'
type SortDirection = 'asc' | 'desc'

const numberFmt = new Intl.NumberFormat('en-US')
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 6 })

const parseList = (text: string) =>
    [...new Set(text
        .split(/[\n,]/g)
        .map((item) => item.trim())
        .filter(Boolean))]

const fmtJson = (value: unknown) => {
    if (typeof value == 'string') return value
    return JSON.stringify(value)
}

export const Page = () => {
    const [auth, setAuth] = useState<AuthState>({
        authenticated: false,
        discordId: null,
        displayName: null,
        role: null,
        csrfToken: null,
        sessionSource: null,
        legacyPasswordConfigured: false,
        legacyAuthSource: 'none',
        updatedAt: null,
        accountCount: 0,
        discordOAuthConfigured: false,
    })
    const [loginDiscordId, setLoginDiscordId] = useState('')
    const [loginPassword, setLoginPassword] = useState('')
    const [loginError, setLoginError] = useState('')
    const [signupDiscordId, setSignupDiscordId] = useState('')
    const [signupDisplayName, setSignupDisplayName] = useState('')
    const [signupPassword, setSignupPassword] = useState('')
    const [signupConfirmPassword, setSignupConfirmPassword] = useState('')
    const [signupError, setSignupError] = useState('')
    const [authView, setAuthView] = useState<'login' | 'signup'>('login')
    const [activeTab, setActiveTab] = useState<Tab>('facts')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const [users, setUsers] = useState<UserRow[]>([])
    const [accounts, setAccounts] = useState<DashboardAccountRow[]>([])
    const [analytics, setAnalytics] = useState<Analytics | null>(null)
    const [auditRows, setAuditRows] = useState<AuditRow[]>([])
    const [cfg, setCfg] = useState<BotConfig | null>(null)

    const [addUserId, setAddUserId] = useState('')
    const [addDisplayName, setAddDisplayName] = useState('')
    const [addFact, setAddFact] = useState('')
    const [editing, setEditing] = useState<{ userId: string; oldFact: string } | null>(null)
    const [editValue, setEditValue] = useState('')
    const [selectedFacts, setSelectedFacts] = useState<Record<string, string[]>>({})

    const [sortState, setSortState] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'cost', direction: 'desc' })
    const [mutedInput, setMutedInput] = useState('')
    const [deniedInput, setDeniedInput] = useState('')
    const [accountCurrentPassword, setAccountCurrentPassword] = useState('')
    const [accountNewPassword, setAccountNewPassword] = useState('')
    const [accountConfirmPassword, setAccountConfirmPassword] = useState('')
    const [bootstrapCurrentPassword, setBootstrapCurrentPassword] = useState('')
    const [bootstrapNewPassword, setBootstrapNewPassword] = useState('')
    const [createAccountDiscordId, setCreateAccountDiscordId] = useState('')
    const [createAccountDisplayName, setCreateAccountDisplayName] = useState('')
    const [createAccountPassword, setCreateAccountPassword] = useState('')
    const [createAccountRole, setCreateAccountRole] = useState<'admin' | 'user'>('user')
    const [resetAccountDiscordId, setResetAccountDiscordId] = useState('')
    const [resetAccountPassword, setResetAccountPassword] = useState('')

    const csrfHeaders = () => auth.csrfToken ? { 'x-csrf-token': auth.csrfToken } : {}

    const postJson = async (path: string, body: Record<string, unknown>) => {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
            body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(await res.text())
        return await res.json()
    }

    const refreshAuth = async () => {
        const res = await fetch('/auth/status')
        setAuth(await res.json())
    }

    const loadUsers = async () => {
        const res = await fetch('/load')
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        setUsers(Array.isArray(data.users) ? data.users : [])
    }

    const loadAccounts = async () => {
        const res = await fetch('/accounts')
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        setAccounts(Array.isArray(data.accounts) ? data.accounts : [])
    }

    const loadAnalytics = async () => {
        const res = await fetch('/analytics')
        if (!res.ok) throw new Error(await res.text())
        setAnalytics(await res.json())
    }

    const loadAudit = async () => {
        const res = await fetch('/audit?limit=200')
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        setAuditRows(Array.isArray(data.rows) ? data.rows : [])
    }

    const loadConfig = async () => {
        const res = await fetch('/config')
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        setCfg(data)
        setMutedInput((data.mutedUserIds ?? []).join('\n'))
        setDeniedInput((data.deniedUserIds ?? []).join('\n'))
    }

    const reloadAll = async () => {
        await loadUsers()
        if (auth.role == 'admin') {
            await Promise.all([loadAccounts(), loadAnalytics(), loadAudit(), loadConfig()])
        } else {
            setAccounts([])
            setAnalytics(null)
            setAuditRows([])
            setCfg(null)
        }
    }

    const run = async (action: () => Promise<void>) => {
        setBusy(true)
        setError('')
        try {
            await action()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const doLogin = () => run(async () => {
        setLoginError('')
        await postJson('/login', { discordId: loginDiscordId.trim(), password: loginPassword })
        setLoginPassword('')
        await refreshAuth()
    })

    const doSignup = () => run(async () => {
        setSignupError('')
        const discordId = signupDiscordId.trim()
        const displayName = signupDisplayName.trim()
        const password = signupPassword
        if (!discordId) throw new Error('Discord ID is required')
        if (signupPassword !== signupConfirmPassword) throw new Error('Passwords do not match')
        await postJson('/signup', { discordId, displayName, password })
        setSignupDiscordId('')
        setSignupDisplayName('')
        setSignupPassword('')
        setSignupConfirmPassword('')
        await refreshAuth()
    })

    const doLogout = () => run(async () => {
        await postJson('/logout', {})
        setUsers([])
        setAccounts([])
        setAnalytics(null)
        setAuditRows([])
        setCfg(null)
        setAddUserId('')
        setAddDisplayName('')
        setAddFact('')
        setEditing(null)
        setEditValue('')
        setSelectedFacts({})
        setLoginDiscordId('')
        setSignupDiscordId('')
        setSignupDisplayName('')
        setLoginPassword('')
        setSignupPassword('')
        setSignupConfirmPassword('')
        setAccountCurrentPassword('')
        setAccountNewPassword('')
        setAccountConfirmPassword('')
        setBootstrapCurrentPassword('')
        setBootstrapNewPassword('')
        setCreateAccountDiscordId('')
        setCreateAccountDisplayName('')
        setCreateAccountPassword('')
        setCreateAccountRole('user')
        setResetAccountDiscordId('')
        setResetAccountPassword('')
        await refreshAuth()
    })

    const createFact = () => run(async () => {
        const userId = auth.role == 'admin' ? addUserId.trim() : (auth.discordId ?? addUserId.trim())
        const displayName = addDisplayName.trim()
        const fact = addFact.trim()
        if (!fact) throw new Error('Fact is required')
        if (!userId) throw new Error('Discord user ID is required')
        await postJson('/facts/add', { userId, displayName, user: displayName || userId, fact })
        setAddFact('')
        await reloadAll()
    })

    const deleteFact = (userId: string, displayName: string, fact: string) => run(async () => {
        await postJson('/facts/delete', { userId, user: displayName, fact })
        await reloadAll()
    })

    const editFact = (userId: string, displayName: string, oldFact: string, newFact: string) => run(async () => {
        if (!newFact.trim()) throw new Error('Fact cannot be empty')
        await postJson('/facts/edit', { userId, user: displayName, oldFact, newFact: newFact.trim() })
        setEditing(null)
        setEditValue('')
        await reloadAll()
    })

    const bulkDelete = (userId: string) => run(async () => {
        const facts = selectedFacts[userId] ?? []
        if (!facts.length) throw new Error('No facts selected')
        await postJson('/facts/bulk-delete', { userId, facts })
        setSelectedFacts((prev) => ({ ...prev, [userId]: [] }))
        await reloadAll()
    })

    const dedupe = (userId: string) => run(async () => {
        await postJson('/facts/dedupe', { userId })
        await reloadAll()
    })

    const cleanupLowValue = (userId: string) => run(async () => {
        await postJson('/facts/cleanup-low-value', { userId })
        await reloadAll()
    })

    const saveAccountPassword = () => run(async () => {
        if (!accountNewPassword.trim()) throw new Error('New password is required')
        if (accountNewPassword !== accountConfirmPassword) throw new Error('Passwords do not match')
        await postJson('/account/password', {
            currentPassword: accountCurrentPassword,
            newPassword: accountNewPassword,
        })
        setAccountCurrentPassword('')
        setAccountNewPassword('')
        setAccountConfirmPassword('')
        await refreshAuth()
        await reloadAll()
    })

    const saveBootstrapPassword = () => run(async () => {
        if (!bootstrapNewPassword.trim()) throw new Error('New password is required')
        await postJson('/auth/password', {
            currentPassword: bootstrapCurrentPassword,
            newPassword: bootstrapNewPassword,
        })
        setBootstrapCurrentPassword('')
        setBootstrapNewPassword('')
        await refreshAuth()
    })

    const createDashboardAccount = () => run(async () => {
        const discordId = createAccountDiscordId.trim()
        const displayName = createAccountDisplayName.trim()
        const password = createAccountPassword
        if (!discordId) throw new Error('Discord ID is required')
        await postJson('/accounts', {
            discordId,
            displayName,
            password,
            role: createAccountRole,
        })
        setCreateAccountDiscordId('')
        setCreateAccountDisplayName('')
        setCreateAccountPassword('')
        setCreateAccountRole('user')
        await reloadAll()
    })

    const resetDashboardAccountPassword = () => run(async () => {
        const discordId = resetAccountDiscordId.trim()
        const newPassword = resetAccountPassword
        if (!discordId) throw new Error('Discord ID is required')
        if (!newPassword.trim()) throw new Error('New password is required')
        await postJson('/accounts/reset-password', { discordId, newPassword })
        setResetAccountDiscordId('')
        setResetAccountPassword('')
        await reloadAll()
    })

    const changeAccountRole = (discordId: string, role: 'admin' | 'user') => run(async () => {
        await postJson('/accounts/role', { discordId, role })
        const selfChange = discordId == auth.discordId
        await refreshAuth()
        if (!selfChange) await reloadAll()
    })

    const saveConfig = () => run(async () => {
        if (!cfg) return
        const next: BotConfig = {
            ...cfg,
            mutedUserIds: parseList(mutedInput),
            deniedUserIds: parseList(deniedInput),
        }
        const updated = await postJson('/config', next) as BotConfig
        setCfg(updated)
        setMutedInput((updated.mutedUserIds ?? []).join('\n'))
        setDeniedInput((updated.deniedUserIds ?? []).join('\n'))
        await reloadAll()
    })

    const toggleFactSelection = (userId: string, fact: string, checked: boolean) => {
        setSelectedFacts((prev) => {
            const before = new Set(prev[userId] ?? [])
            if (checked) before.add(fact)
            else before.delete(fact)
            return { ...prev, [userId]: [...before] }
        })
    }

    const leaderboardRows = useMemo(() => users
        .filter((user) => user.id.toLowerCase() != 'gork')
        .sort((a, b) => {
            const value = sortState.key == 'displayName'
                ? a.displayName.localeCompare(b.displayName)
                : a[sortState.key] - b[sortState.key]
            return sortState.direction == 'asc' ? value : -value
        }), [users, sortState])

    const setSort = (key: SortKey) =>
        setSortState((prev) => prev.key == key
            ? { key, direction: prev.direction == 'asc' ? 'desc' : 'asc' }
            : { key, direction: key == 'displayName' ? 'asc' : 'desc' })

    const sortArrow = (key: SortKey) =>
        sortState.key == key ? (sortState.direction == 'asc' ? '▲' : '▼') : ''

    useEffect(() => {
        void (async () => {
            await refreshAuth()
        })()
    }, [])

    useEffect(() => {
        if (!auth.authenticated) return
        void reloadAll()
    }, [auth.authenticated, auth.role])

    useEffect(() => {
        if (auth.role == 'user' && auth.discordId) {
            setAddUserId(auth.discordId)
            if (!addDisplayName.trim() && auth.displayName) setAddDisplayName(auth.displayName)
        }
    }, [auth.discordId, auth.displayName, auth.role])

    useEffect(() => {
        const visibleTabs: Tab[] = auth.role == 'admin'
            ? ['facts', 'leaderboard', 'account', 'users', 'analytics', 'config', 'audit']
            : ['facts', 'leaderboard', 'account']
        if (!visibleTabs.includes(activeTab)) setActiveTab('facts')
    }, [activeTab, auth.role, auth.authenticated])

    const navTabs: [Tab, string][] = auth.role == 'admin'
        ? [
            ['facts', 'Facts'],
            ['leaderboard', 'Leaderboard'],
            ['account', 'Account'],
            ['users', 'Dashboard Users'],
            ['analytics', 'Analytics'],
            ['config', 'Config & Safety'],
            ['audit', 'Audit Log'],
        ]
        : [
            ['facts', 'Facts'],
            ['leaderboard', 'Leaderboard'],
            ['account', 'Account'],
        ]

    return <>
        <head>
            <meta charSet='utf-8' />
            <meta name='viewport' content='width=device-width, initial-scale=1' />
            <link href='/style.css' rel='stylesheet' />
            <title>gork dashboard</title>
        </head>
        <main className='min-h-screen bg-slate-950 text-white'>
            <div className='mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6'>
                <header className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                    <div className='flex flex-wrap items-start justify-between gap-4'>
                        <div>
                            <h1 className='text-2xl font-semibold'>Gork Admin Dashboard</h1>
                            <p className='mt-2 text-sm text-white/80'>Facts, usage analytics, config, and security controls.</p>
                            {auth.authenticated && <p className='mt-2 text-xs text-white/70'>
                                Signed in as <span className='font-medium text-white'>{auth.displayName ?? auth.discordId}</span>
                                {' '}· <span className='font-medium text-white'>{auth.role}</span>
                                {' '}· source <span className='font-medium text-white'>{auth.sessionSource}</span>
                                {auth.updatedAt && <span> · updated {new Date(auth.updatedAt).toLocaleString()}</span>}
                            </p>}
                        </div>
                        {auth.authenticated && <div className='text-right text-sm text-white/80'>
                            <p>{auth.discordId}</p>
                            <button className='mt-2 rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800' onClick={doLogout} disabled={busy}>Logout</button>
                        </div>}
                    </div>
                </header>

                {!auth.authenticated && <section className='mx-auto max-w-md'>
                    <article className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                        <h2 className='mb-4 text-lg font-semibold'>Login</h2>
                        <div className='space-y-3'>
                            <p className='text-sm text-white/75'>
                                Sign in with Discord OAuth. Your Discord account becomes your dashboard identity.
                            </p>
                            <button
                                className='w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-60'
                                onClick={() => window.location.assign('/auth/discord/start')}
                                disabled={busy || !auth.discordOAuthConfigured}
                            >
                                Continue with Discord
                            </button>
                            {!auth.discordOAuthConfigured && <p className='text-sm text-amber-300'>
                                Discord OAuth is not configured yet.
                            </p>}
                        </div>
                    </article>
                    {error && <section className='mt-4 rounded-xl border border-red-800 bg-red-950/40 p-3 text-sm text-red-200'>{error}</section>}
                </section>}

                {auth.authenticated && <>
                    <nav className='flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3 text-white'>
                        {navTabs.map(([key, label]) => (
                            <button
                                key={key}
                                className={`rounded-md px-4 py-2 text-sm font-medium transition ${activeTab == key ? 'bg-blue-600' : 'border border-slate-700 hover:bg-slate-800'}`}
                                onClick={() => setActiveTab(key as Tab)}
                            >
                                {label}
                            </button>
                        ))}
                    </nav>

                    {error && <section className='rounded-xl border border-red-800 bg-red-950/40 p-3 text-sm text-red-200'>{error}</section>}

                    {activeTab == 'facts' && <section className='space-y-4'>
                        <article className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                            <h2 className='mb-4 text-lg font-semibold'>Facts</h2>
                            <p className='mb-4 text-sm text-white/75'>
                                {auth.role == 'admin'
                                    ? 'Admins can edit any Discord-linked fact row.'
                                    : 'You can edit the fact rows for your linked Discord ID.'}
                            </p>
                            <div className='grid gap-3 md:grid-cols-4'>
                                <input className='rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white'
                                    value={addUserId}
                                    onChange={(e) => setAddUserId(e.target.value)}
                                    placeholder='discord user id'
                                    disabled={busy || auth.role == 'user'} />
                                <input className='rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white'
                                    value={addDisplayName}
                                    onChange={(e) => setAddDisplayName(e.target.value)}
                                    placeholder='display name'
                                    disabled={busy} />
                                <input className='rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm md:col-span-2 text-white'
                                    value={addFact}
                                    onChange={(e) => setAddFact(e.target.value)}
                                    placeholder='fact'
                                    disabled={busy} />
                            </div>
                            <button className='mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-60' onClick={createFact} disabled={busy}>
                                Add Fact
                            </button>
                        </article>

                        {users.map((user) => {
                            const canEdit = auth.role == 'admin' || user.id == auth.discordId
                            return <article key={user.id} className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                                <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
                                    <div>
                                        <h3 className='text-base font-semibold'>{user.displayName}</h3>
                                        <p className='text-xs text-white/70'>{user.id}</p>
                                    </div>
                                    {canEdit && <div className='flex gap-2'>
                                        <button className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800'
                                            onClick={() => { setAddUserId(user.id); setAddDisplayName(user.displayName) }}
                                            disabled={busy}>
                                            Use in Add form
                                        </button>
                                        <button className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800'
                                            onClick={() => dedupe(user.id)} disabled={busy}>
                                            Merge Duplicates
                                        </button>
                                        <button className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800'
                                            onClick={() => cleanupLowValue(user.id)} disabled={busy}>
                                            Cleanup Low-Value
                                        </button>
                                    </div>}
                                </div>

                                {user.facts.length === 0 && <p className='text-sm text-white/70'>No facts saved.</p>}
                                <ul className='space-y-2'>
                                    {user.facts.map((fact, idx) => (
                                        <li key={`${user.id}-${idx}-${fact}`} className='rounded-md border border-slate-800 bg-slate-950 p-3'>
                                            {editing?.userId == user.id && editing.oldFact == fact
                                                ? <div className='flex flex-col gap-2 sm:flex-row'>
                                                    <input className='flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white'
                                                        value={editValue}
                                                        onChange={(e) => setEditValue(e.target.value)}
                                                        disabled={busy} />
                                                    <button className='rounded-md bg-blue-600 px-3 py-2 text-sm hover:bg-blue-500' onClick={() => editFact(user.id, user.displayName, fact, editValue)} disabled={busy}>Save</button>
                                                    <button className='rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800' onClick={() => { setEditing(null); setEditValue('') }} disabled={busy}>Cancel</button>
                                                </div>
                                                : <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                                                    <label className='flex items-start gap-3 text-sm'>
                                                        <input
                                                            type='checkbox'
                                                            checked={(selectedFacts[user.id] ?? []).includes(fact)}
                                                            onChange={(e) => toggleFactSelection(user.id, fact, e.target.checked)}
                                                            disabled={busy}
                                                        />
                                                        <span>{fact}</span>
                                                    </label>
                                                    {canEdit && <div className='flex gap-2'>
                                                        <button className='rounded-md border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800'
                                                            onClick={() => { setEditing({ userId: user.id, oldFact: fact }); setEditValue(fact) }}
                                                            disabled={busy}>
                                                            Edit
                                                        </button>
                                                        <button className='rounded-md border border-red-800 px-3 py-1 text-xs text-red-200 hover:bg-red-950'
                                                            onClick={() => deleteFact(user.id, user.displayName, fact)}
                                                            disabled={busy}>
                                                            Delete
                                                        </button>
                                                    </div>}
                                                </div>}
                                        </li>
                                    ))}
                                </ul>
                                {auth.role == 'admin' && (selectedFacts[user.id] ?? []).length > 0 && <button
                                    className='mt-3 rounded-md border border-red-800 px-3 py-2 text-xs text-red-200 hover:bg-red-950'
                                    onClick={() => bulkDelete(user.id)}
                                    disabled={busy}
                                >
                                    Bulk Delete Selected ({(selectedFacts[user.id] ?? []).length})
                                </button>}
                            </article>
                        })}
                    </section>}

                    {activeTab == 'leaderboard' && <section className='overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-white'>
                        <div className='overflow-x-auto'>
                            <table className='min-w-full border-collapse text-sm'>
                                <thead className='bg-slate-950/70'>
                                    <tr>
                                        {[
                                            ['displayName', 'User'],
                                            ['mentions', 'Mentions'],
                                            ['total_tokens_in', 'Tokens In'],
                                            ['total_tokens_out', 'Tokens Out'],
                                            ['total_tokens_cache', 'Tokens Cache'],
                                            ['cost', 'Cost'],
                                        ].map(([key, label]) => (
                                            <th key={key} className='border-b border-slate-800 px-4 py-3 text-left font-medium text-white'>
                                                <button className='inline-flex items-center gap-2 hover:text-white' onClick={() => setSort(key as SortKey)}>
                                                    {label}<span className='text-xs text-white/70'>{sortArrow(key as SortKey)}</span>
                                                </button>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {leaderboardRows.map((row) => (
                                        <tr key={row.id} className='border-b border-slate-800/70 hover:bg-slate-950/40 text-white'>
                                            <td className='px-4 py-3'>
                                                <div className='font-medium'>{row.displayName}</div>
                                                <div className='text-xs text-white/70'>{row.id}</div>
                                            </td>
                                            <td className='px-4 py-3'>{numberFmt.format(row.mentions)}</td>
                                            <td className='px-4 py-3'>{numberFmt.format(row.total_tokens_in)}</td>
                                            <td className='px-4 py-3'>{numberFmt.format(row.total_tokens_out)}</td>
                                            <td className='px-4 py-3'>{numberFmt.format(row.total_tokens_cache)}</td>
                                            <td className='px-4 py-3'>{moneyFmt.format(row.cost)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>}

                    {activeTab == 'users' && auth.role == 'admin' && <section className='space-y-4'>
                        <article className='overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-white'>
                            <div className='overflow-x-auto'>
                                <table className='min-w-full border-collapse text-sm'>
                                    <thead className='bg-slate-950/70'>
                                        <tr>
                                            {['Discord ID', 'Display Name', 'Role', 'Created', 'Updated', 'Last Seen'].map((label) =>
                                                <th key={label} className='border-b border-slate-800 px-4 py-3 text-left font-medium text-white'>{label}</th>)}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {accounts.map((account) => (
                                            <tr key={account.discordId} className='border-b border-slate-800/70 hover:bg-slate-950/40 text-white'>
                                                <td className='px-4 py-3'>{account.discordId}</td>
                                                <td className='px-4 py-3'>{account.displayName}</td>
                                                <td className='px-4 py-3'>
                                                    <select className='rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white'
                                                        value={account.role}
                                                        onChange={(e) => changeAccountRole(account.discordId, e.target.value as 'admin' | 'user')}
                                                        disabled={busy}>
                                                        <option value='user'>user</option>
                                                        <option value='admin'>admin</option>
                                                    </select>
                                                </td>
                                                <td className='px-4 py-3'>{new Date(account.createdAt).toLocaleString()}</td>
                                                <td className='px-4 py-3'>{new Date(account.updatedAt).toLocaleString()}</td>
                                                <td className='px-4 py-3'>{account.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : '-'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </article>
                    </section>}

                    {activeTab == 'analytics' && auth.role == 'admin' && <section className='space-y-4'>
                        <article className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                            <h2 className='mb-3 text-lg font-semibold'>Burn Rate</h2>
                            <div className='grid gap-3 sm:grid-cols-3'>
                                <div className='rounded-md border border-slate-800 bg-slate-950 p-3'>
                                    <p className='text-xs text-white/70'>Cost (7 days)</p>
                                    <p className='text-lg font-semibold'>{moneyFmt.format(analytics?.burnRate.costLast7d ?? 0)}</p>
                                </div>
                                <div className='rounded-md border border-slate-800 bg-slate-950 p-3'>
                                    <p className='text-xs text-white/70'>Avg daily cost</p>
                                    <p className='text-lg font-semibold'>{moneyFmt.format(analytics?.burnRate.avgDailyCost7d ?? 0)}</p>
                                </div>
                                <div className='rounded-md border border-slate-800 bg-slate-950 p-3'>
                                    <p className='text-xs text-white/70'>Projected monthly</p>
                                    <p className='text-lg font-semibold'>{moneyFmt.format(analytics?.burnRate.projectedMonthlyCost ?? 0)}</p>
                                </div>
                            </div>
                        </article>

                        <article className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                            <h2 className='mb-3 text-lg font-semibold'>Top Users (7 days)</h2>
                            <div className='space-y-2'>
                                {(analytics?.topUsers7d ?? []).map((row) => (
                                    <div key={row.userId} className='flex items-center justify-between rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm'>
                                        <div>
                                            <p className='font-medium'>{row.displayName}</p>
                                            <p className='text-xs text-white/70'>{row.userId}</p>
                                        </div>
                                        <div className='text-right'>
                                            <p>{moneyFmt.format(row.cost)}</p>
                                            <p className='text-xs text-white/70'>{row.mentions} mentions</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </article>
                    </section>}

                    {activeTab == 'account' && <section className='space-y-4'>
                        <article className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                            <h2 className='mb-4 text-lg font-semibold'>Account</h2>
                            <p className='mb-4 text-sm text-white/75'>
                                Discord ID: <span className='font-medium text-white'>{auth.discordId ?? '-'}</span>
                                {' '}· role: <span className='font-medium text-white'>{auth.role ?? '-'}</span>
                            </p>
                            <p className='text-sm text-white/75'>
                                Signed in through Discord OAuth. Admins can change roles from Dashboard Users.
                            </p>
                        </article>
                    </section>}

                    {activeTab == 'config' && cfg && <section className='rounded-xl border border-slate-800 bg-slate-900 p-5 text-white'>
                        <h2 className='mb-4 text-lg font-semibold'>Bot Configuration & Safety Controls</h2>
                        <div className='grid gap-3 md:grid-cols-3'>
                            <label className='text-sm'>
                                <span className='mb-1 block text-white/80'>Model</span>
                                <input className='w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white'
                                    value={cfg.model}
                                    onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
                                    disabled={busy} />
                            </label>
                            <label className='text-sm'>
                                <span className='mb-1 block text-white/80'>History depth</span>
                                <input className='w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white'
                                    type='number'
                                    value={cfg.historyDepth}
                                    onChange={(e) => setCfg({ ...cfg, historyDepth: Number(e.target.value) })}
                                    disabled={busy} />
                            </label>
                            <label className='text-sm'>
                                <span className='mb-1 block text-white/80'>Reply max length</span>
                                <input className='w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white'
                                    type='number'
                                    value={cfg.replyMaxLength}
                                    onChange={(e) => setCfg({ ...cfg, replyMaxLength: Number(e.target.value) })}
                                    disabled={busy} />
                            </label>
                        </div>

                        <div className='mt-4 grid gap-3 md:grid-cols-2'>
                            {[
                                ['generalBrief', 'General channel brief replies'],
                                ['degeneracyMode', 'Degeneracy mode in #degeneracy'],
                                ['webSearchEnabled', 'Enable web-search tool'],
                                ['readOnlyMode', 'Emergency read-only mode'],
                            ].map(([key, label]) => (
                                <label key={key} className='flex items-center gap-3 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm'>
                                    <input
                                        type='checkbox'
                                        checked={Boolean(cfg[key as keyof BotConfig])}
                                        onChange={(e) => setCfg({ ...cfg, [key]: e.target.checked })}
                                        disabled={busy}
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>

                        <div className='mt-4 grid gap-3 md:grid-cols-2'>
                            <label className='text-sm'>
                                <span className='mb-1 block text-white/80'>Muted user IDs (newline/comma separated)</span>
                                <textarea className='h-32 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white'
                                    value={mutedInput}
                                    onChange={(e) => setMutedInput(e.target.value)}
                                    disabled={busy} />
                            </label>
                            <label className='text-sm'>
                                <span className='mb-1 block text-white/80'>Denied user IDs (no response)</span>
                                <textarea className='h-32 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white'
                                    value={deniedInput}
                                    onChange={(e) => setDeniedInput(e.target.value)}
                                    disabled={busy} />
                            </label>
                        </div>

                        <button className='mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-60'
                            onClick={saveConfig}
                            disabled={busy}>
                            Save Config
                        </button>
                    </section>}

                    {activeTab == 'audit' && <section className='overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-white'>
                        <div className='overflow-x-auto'>
                            <table className='min-w-full border-collapse text-sm'>
                                <thead className='bg-slate-950/70'>
                                    <tr>
                                        {['Time', 'Actor', 'Action', 'Target', 'IP', 'Details'].map((label) =>
                                            <th key={label} className='border-b border-slate-800 px-3 py-2 text-left font-medium text-white'>{label}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {auditRows.map((row) => (
                                        <tr key={row.id} className='border-b border-slate-800/70 align-top hover:bg-slate-950/40 text-white'>
                                            <td className='px-3 py-2 whitespace-nowrap'>{new Date(row.at).toLocaleString()}</td>
                                            <td className='px-3 py-2'>{row.actor}</td>
                                            <td className='px-3 py-2'>{row.action}</td>
                                            <td className='px-3 py-2'>
                                                <div>{row.displayName || '-'}</div>
                                                <div className='text-xs text-white/70'>{row.userId || ''}</div>
                                            </td>
                                            <td className='px-3 py-2'>{row.ip}</td>
                                            <td className='px-3 py-2 text-xs text-white/80'>
                                                {row.before !== undefined && <div>before: {fmtJson(row.before)}</div>}
                                                {row.after !== undefined && <div>after: {fmtJson(row.after)}</div>}
                                                {row.details && <div>details: {fmtJson(row.details)}</div>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>}
                </>}
            </div>
        </main>
    </>
}

if (typeof window != 'undefined') hydrateRoot(document, <Page />)

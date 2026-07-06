import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react'
import { load, save } from './lib/storage'
import { joinCode, uid } from './lib/id'
import type { AppState, Expense, Group, Member } from './types'

const STORAGE_KEY = 'appstate'

const initial: AppState = load<AppState>(STORAGE_KEY, {
  groups: [],
  activeGroupId: null,
})

type Action =
  | { type: 'createGroup'; name: string; nickname: string }
  | { type: 'joinGroup'; name: string; code: string; nickname: string }
  | { type: 'setActive'; groupId: string | null }
  | { type: 'renameGroup'; groupId: string; name: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'addMember'; groupId: string; nickname: string }
  | { type: 'renameMe'; groupId: string; nickname: string }
  | { type: 'addExpense'; groupId: string; expense: Expense }
  | { type: 'updateExpense'; groupId: string; expense: Expense }
  | { type: 'deleteExpense'; groupId: string; expenseId: string }

function mapGroup(state: AppState, id: string, fn: (g: Group) => Group): AppState {
  return { ...state, groups: state.groups.map((g) => (g.id === id ? fn(g) : g)) }
}

function newGroup(name: string, nickname: string, code: string): Group {
  const myId = uid('m_')
  const me: Member = { id: myId, nickname: nickname || '我', isMe: true }
  return {
    id: uid('g_'),
    name: name || '未命名群组',
    code,
    createdAt: Date.now(),
    myMemberId: myId,
    members: [me],
    expenses: [],
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'createGroup': {
      const g = newGroup(action.name, action.nickname, joinCode())
      return { groups: [...state.groups, g], activeGroupId: g.id }
    }
    case 'joinGroup': {
      // Web 演示：加入即在本机创建同码群组占位；原生/联网版会从对端同步成员与账目
      const g = newGroup(action.name, action.nickname, action.code)
      return { groups: [...state.groups, g], activeGroupId: g.id }
    }
    case 'setActive':
      return { ...state, activeGroupId: action.groupId }
    case 'renameGroup':
      return mapGroup(state, action.groupId, (g) => ({ ...g, name: action.name }))
    case 'deleteGroup': {
      const groups = state.groups.filter((g) => g.id !== action.groupId)
      const activeGroupId =
        state.activeGroupId === action.groupId
          ? groups[0]?.id ?? null
          : state.activeGroupId
      return { groups, activeGroupId }
    }
    case 'addMember':
      return mapGroup(state, action.groupId, (g) => ({
        ...g,
        members: [...g.members, { id: uid('m_'), nickname: action.nickname }],
      }))
    case 'renameMe':
      return mapGroup(state, action.groupId, (g) => ({
        ...g,
        members: g.members.map((m) =>
          m.id === g.myMemberId ? { ...m, nickname: action.nickname } : m,
        ),
      }))
    case 'addExpense':
      return mapGroup(state, action.groupId, (g) => ({
        ...g,
        expenses: [action.expense, ...g.expenses],
      }))
    case 'updateExpense':
      return mapGroup(state, action.groupId, (g) => ({
        ...g,
        expenses: g.expenses.map((e) =>
          e.id === action.expense.id ? action.expense : e,
        ),
      }))
    case 'deleteExpense':
      return mapGroup(state, action.groupId, (g) => ({
        ...g,
        expenses: g.expenses.filter((e) => e.id !== action.expenseId),
      }))
    default:
      return state
  }
}

interface Ctx {
  state: AppState
  dispatch: React.Dispatch<Action>
  activeGroup: Group | null
}

const StoreContext = createContext<Ctx | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    save(STORAGE_KEY, state)
  }, [state])

  const activeGroup = useMemo(
    () => state.groups.find((g) => g.id === state.activeGroupId) ?? null,
    [state.groups, state.activeGroupId],
  )

  return (
    <StoreContext.Provider value={{ state, dispatch, activeGroup }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore(): Ctx {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

import type { Task, Warehouse, Location, SteelCoil } from '@/types'

/** 本地库存数据库 HTTP 服务地址（npm run db:serve 启动，默认 127.0.0.1:3001） */
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:3001'

export interface AppData {
  warehouse: Warehouse
  locations: Location[]
  coils: SteelCoil[]
  tasks: Task[]
}

/** 从数据库加载全量主应用数据；服务不可达时抛错由调用方降级 */
export async function fetchAppData(): Promise<AppData> {
  const res = await fetch(`${API_BASE}/api/app/data`)
  if (!res.ok) throw new Error(`加载数据库数据失败：HTTP ${res.status}`)
  return res.json()
}

/** 新建调度任务（写入数据库） */
export async function postTask(task: Task): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/app/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  })
  if (!res.ok) throw new Error(`新建任务失败：HTTP ${res.status}`)
  return res.json()
}

/** 更新任务状态（写入数据库） */
export async function putTaskStatus(id: string, status: Task['status']): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/app/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(`更新任务状态失败：HTTP ${res.status}`)
  return res.json()
}

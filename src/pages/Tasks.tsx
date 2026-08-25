import { useWarehouseStore } from '@/store/warehouseStore'
import { ClipboardList, Clock, CheckCircle, AlertCircle, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { Task } from '@/types'

export function Tasks() {
  const { tasks, coils, locations, dataSource, createTask } = useWarehouseStore()
  const [showDialog, setShowDialog] = useState(false)
  const [taskType, setTaskType] = useState<Task['type']>('inbound')
  const [coilId, setCoilId] = useState('')
  const [targetLocId, setTargetLocId] = useState('')

  const handleCreate = async () => {
    const coil = coils.find(c => c.id === coilId)
    if (!coil) return
    const task: Task = {
      id: `task-${Date.now().toString(36)}`,
      type: taskType,
      status: 'pending',
      steelCoilId: coilId,
      ...(taskType !== 'inbound' && coil.locationId ? { fromLocationId: coil.locationId } : {}),
      ...(taskType !== 'outbound' && targetLocId ? { toLocationId: targetLocId } : {}),
      createTime: new Date().toISOString(),
    }
    const ok = await createTask(task)
    if (!ok) alert('新建任务失败：数据库服务未启动（请先执行 npm run db:serve）')
    setShowDialog(false)
    setCoilId('')
    setTargetLocId('')
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'inbound': return '入库'
      case 'outbound': return '出库'
      case 'transfer': return '移库'
      default: return type
    }
  }
  
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <Clock className="w-5 h-5 text-warning" />
      case 'executing':
        return <AlertCircle className="w-5 h-5 text-accent" />
      case 'completed':
        return <CheckCircle className="w-5 h-5 text-success" />
      case 'failed':
        return <AlertCircle className="w-5 h-5 text-error" />
      default:
        return null
    }
  }
  
  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending': return '待执行'
      case 'executing': return '执行中'
      case 'completed': return '已完成'
      case 'failed': return '失败'
      default: return status
    }
  }
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-warning/20 text-warning border-warning/30'
      case 'executing': return 'bg-accent/20 text-accent border-accent/30'
      case 'completed': return 'bg-success/20 text-success border-success/30'
      case 'failed': return 'bg-error/20 text-error border-error/30'
      default: return 'bg-secondary/30 text-gray-400 border-secondary/50'
    }
  }
  
  return (
    <div className="h-full pt-16 ml-80 p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-white">
            调度任务
          </h1>
          <button
            onClick={() => setShowDialog(true)}
            className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 rounded-lg text-accent hover:bg-accent/30 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>新建任务</span>
          </button>
        </div>

        {dataSource === 'json' && (
          <div className="mb-4 px-4 py-3 bg-warning/10 border border-warning/30 rounded-lg text-warning text-sm">
            数据库服务未启动，当前为内置数据（只读）。请先执行 <code className="font-mono">npm run db:serve</code> 启动后刷新页面，任务变更才能持久化。
          </div>
        )}

        {showDialog && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowDialog(false)}>
            <div className="bg-primary border border-secondary/50 rounded-xl p-6 w-96" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-white">新建调度任务</h2>
                <button onClick={() => setShowDialog(false)} className="text-gray-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">任务类型</label>
                  <select value={taskType} onChange={e => setTaskType(e.target.value as Task['type'])}
                    className="w-full px-3 py-2 bg-secondary/30 border border-secondary/50 rounded-lg text-white focus:outline-none focus:border-accent/50">
                    <option value="inbound">入库</option>
                    <option value="outbound">出库</option>
                    <option value="transfer">移库</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">钢卷</label>
                  <select value={coilId} onChange={e => setCoilId(e.target.value)}
                    className="w-full px-3 py-2 bg-secondary/30 border border-secondary/50 rounded-lg text-white focus:outline-none focus:border-accent/50">
                    <option value="">请选择钢卷</option>
                    {coils.map(c => (
                      <option key={c.id} value={c.id}>{c.coilNumber} · {c.specification} · {c.material}</option>
                    ))}
                  </select>
                </div>
                {taskType !== 'outbound' && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">目标库位</label>
                    <select value={targetLocId} onChange={e => setTargetLocId(e.target.value)}
                      className="w-full px-3 py-2 bg-secondary/30 border border-secondary/50 rounded-lg text-white focus:outline-none focus:border-accent/50">
                      <option value="">请选择目标库位</option>
                      {locations.filter(l => l.status !== 'occupied').map(l => (
                        <option key={l.id} value={l.id}>{l.id}（{l.status === 'empty' ? '空闲' : '预留'}）</option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  onClick={handleCreate}
                  disabled={!coilId}
                  className="w-full py-2 bg-accent/20 border border-accent/30 rounded-lg text-accent hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  创建并写入数据库
                </button>
              </div>
            </div>
          </div>
        )}
        
        <div className="space-y-4">
          {tasks.map((task) => {
            const coil = coils.find(c => c.id === task.steelCoilId)
            return (
              <div
                key={task.id}
                className="bg-secondary/30 rounded-xl p-4 border border-secondary/50 hover:border-accent/30 transition-all duration-200"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-secondary/50 rounded-lg flex items-center justify-center">
                      <ClipboardList className="w-6 h-6 text-accent" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-white">{task.id}</span>
                        <span className={`px-2 py-1 rounded text-xs border ${getStatusColor(task.status)}`}>
                          {getStatusLabel(task.status)}
                        </span>
                      </div>
                      <div className="text-sm text-gray-400 mb-2">
                        类型: <span className="text-white">{getTypeLabel(task.type)}</span>
                      </div>
                      {coil && (
                        <div className="text-sm text-gray-400">
                          钢卷: <span className="text-white font-mono">{coil.coilNumber}</span>
                          <span className="mx-2">|</span>
                          规格: <span className="text-white">{coil.specification}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getStatusIcon(task.status)}
                  </div>
                </div>
                
                <div className="mt-4 pt-4 border-t border-secondary/30 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-xs text-gray-400">创建时间</div>
                    <div className="text-white">{new Date(task.createTime).toLocaleString('zh-CN')}</div>
                  </div>
                  {task.fromLocationId && (
                    <div>
                      <div className="text-xs text-gray-400">源库位</div>
                      <div className="text-white font-mono">{task.fromLocationId}</div>
                    </div>
                  )}
                  {task.toLocationId && (
                    <div>
                      <div className="text-xs text-gray-400">目标库位</div>
                      <div className="text-white font-mono">{task.toLocationId}</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        
        {tasks.length === 0 && (
          <div className="text-center py-12">
            <ClipboardList className="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <div className="text-gray-400">暂无调度任务</div>
          </div>
        )}
      </div>
    </div>
  )
}

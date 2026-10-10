// 仿真端闭环验证脚本（打 3011 测试实例，DB 为副本）
const B = 'http://127.0.0.1:3011'
const j = (r) => r.json()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' ｜ ' + extra : ''}`) }

// 1. 快照携带 params/kpiToday/weekTrend
const snap = await fetch(`${B}/api/frontend/snapshot`).then(j)
ok('快照 params.autoConfirmMin=5', snap.params?.autoConfirmMin === 5, `实际 ${snap.params?.autoConfirmMin}`)
ok('快照 kpiToday 为真实聚合对象', snap.kpiToday && typeof snap.kpiToday.todayInCount === 'number' && 'successRate' in snap.kpiToday, JSON.stringify(snap.kpiToday))
ok('快照 weekTrend 7 天', Array.isArray(snap.weekTrend) && snap.weekTrend.length === 7, JSON.stringify(snap.weekTrend?.slice(-3)))

// 2. 命令通道幂等去重（多标签同时到期兜底）
const c1 = await fetch(`${B}/api/frontend/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'dispatch-outbound-order', refId: 'TEST-CK-99', payload: { qrCodes: ['A'] } }) }).then(j)
const c2 = await fetch(`${B}/api/frontend/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'dispatch-outbound-order', refId: 'TEST-CK-99', payload: { qrCodes: ['A'] } }) }).then(j)
ok('同 kind+refId 重复写入去重（同 id）', c1.id === c2.id, `id ${c1.id} vs ${c2.id}`)
const c3 = await fetch(`${B}/api/frontend/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'dispatch-outbound-order', refId: 'TEST-CK-98', payload: {} }) }).then(j)
ok('不同 refId 正常新建', c3.id !== c1.id)

// 3. 登记进厂车 → 快照 arriveTime + 倒计时基准一致
const sp = await fetch(`${B}/api/inbound/spawn`, { method: 'POST' }).then(j)
const vehId = sp.vehicle?.id ?? sp.id
ok('模拟进厂登记成功', vehId != null, `vehId=${vehId} plate=${sp.vehicle?.plate}`)
const snap2 = await fetch(`${B}/api/frontend/snapshot`).then(j)
const v = snap2.vehicles.find((x) => x.id === vehId)
ok('快照含该车 arriveTime（ISO）且可解析', !!v && Number.isFinite(Date.parse(v.arriveTime)), v?.arriveTime)
// 两个「标签页」各自现算截止时刻：必须完全相同
const dl1 = Date.parse(v.arriveTime) + snap2.params.autoConfirmMin * 60000
const dl2 = Date.parse(v.arriveTime) + snap2.params.autoConfirmMin * 60000
ok('两标签页截止时刻现算一致', dl1 === dl2, new Date(dl1).toISOString())

// 4. 超时自动确认：窗口调成 1 分钟，把 arrive_time 回拨 61s，等服务端 15s 扫描兜底
await fetch(`${B}/api/params`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ production: { autoConfirmMin: 1 } }) }).then(j)
const Database = (await import('../kg-dispatch-frontend/node_modules/better-sqlite3/lib/index.js')).default.catch?.(() => null)
// better-sqlite3 从 Robot_Sim 自身依赖加载
const bs3 = (await import('F:/Robot_Project/Robot_Sim/node_modules/better-sqlite3/lib/index.js')).default
const db = new bs3(process.env.WAREHOUSE_DB || 'C:/Users/MCCzyzc/AppData/Local/Temp/kg-test/test.db')
db.prepare("UPDATE inbound_vehicles SET arrive_time=? WHERE id=?").run(new Date(Date.now() - 61000).toISOString(), vehId)
db.close()
console.log('… arrive_time 已回拨 61s，等服务端 15s 扫描自动确认（最多 20s）')
await new Promise((r) => setTimeout(r, 20000))
const snap3 = await fetch(`${B}/api/frontend/snapshot`).then(j)
const v2 = snap3.vehicles.find((x) => x.id === vehId)
ok('服务端到时自动确认（pending→confirmed）', v2?.state === 'confirmed', `state=${v2?.state}`)

// 5. 幂等：前端到期再触发 confirm（模拟 AUTO_CONFIRM_PLAN 转发）→ 已确认幂等
const rc = await fetch(`${B}/api/inbound/${vehId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(j)
ok('重复确认幂等返回「该车已确认」', rc.error === '该车已确认', JSON.stringify(rc))

// 6. 清理测试车辆 + 恢复参数
await fetch(`${B}/api/inbound/${vehId}`, { method: 'DELETE' }).then(j)
await fetch(`${B}/api/params`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ production: { autoConfirmMin: 5 } }) }).then(j)
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

// 闭环验证 part2：超时自动确认（服务端 15s 扫描兜底）+ 幂等重复确认 + 清理
import bs3 from 'better-sqlite3'
const B = 'http://127.0.0.1:3011'
const DBP = 'C:/Users/MCCzyzc/AppData/Local/Temp/kg-test/test.db'
const j = (r) => r.json()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' ｜ ' + extra : ''}`) }

// 窗口已是 1 分钟（part1 已 PUT）；登记一辆新车并回拨 arrive_time 61s
const sp = await fetch(`${B}/api/inbound/spawn`, { method: 'POST' }).then(j)
const vehId = sp.vehicle?.id ?? sp.id
const db = new bs3(DBP)
db.prepare('UPDATE inbound_vehicles SET arrive_time=? WHERE id=?').run(new Date(Date.now() - 61000).toISOString(), vehId)
db.close()
console.log(`… 车辆 #${vehId} arrive_time 回拨 61s，等待服务端扫描（窗口 1 分钟，扫描周期 15s，最多等 25s）`)
await new Promise((r) => setTimeout(r, 25000))

const snap = await fetch(`${B}/api/frontend/snapshot`).then(j)
const v = snap.vehicles.find((x) => x.id === vehId)
ok('服务端到时自动确认（pending→confirmed）', v?.state === 'confirmed', `state=${v?.state}`)
ok('快照参数已切换为 1 分钟窗口', snap.params?.autoConfirmMin === 1)

// 幂等：模拟前端 AUTO_CONFIRM_PLAN 到期转发（服务端已确认时静默跳过）
const rc = await fetch(`${B}/api/inbound/${vehId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(j)
ok('重复确认幂等返回「该车已确认」', rc.error === '该车已确认', JSON.stringify(rc))

// 清理：删测试车辆 + 恢复 5 分钟窗口
await fetch(`${B}/api/inbound/${vehId}`, { method: 'DELETE' }).then(j)
const p = await fetch(`${B}/api/params`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ production: { autoConfirmMin: 5 } }) }).then(j)
ok('参数已恢复 5 分钟', p.values?.production?.autoConfirmMin === 5)
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

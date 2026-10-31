export function readBatteryState(reader) {
  const sec = reader.readInt32(), nanosec = reader.readUint32(), frame_id = reader.readString()
  const result = { header: { stamp: { sec, nanosec }, frame_id } }
  for (const name of ['voltage', 'temperature', 'current', 'charge', 'capacity', 'design_capacity', 'percentage']) result[name] = reader.readFloat32()
  for (const name of ['power_supply_status', 'power_supply_health', 'power_supply_technology']) result[name] = reader.readUint8()
  result.present = reader.readUint8() !== 0
  result.cell_voltage = reader.readFloat32Array()
  result.cell_temperature = reader.readFloat32Array()
  result.location = reader.readString()
  result.serial_number = reader.readString()
  return result
}

export function batteryView(data, receivedAt, now, connected) {
  const fresh = connected && receivedAt > 0 && now - receivedAt < 15000
  const finite = v => typeof v === 'number' && Number.isFinite(v)
  const present = fresh && data && data.present !== false
  const percentage = present && finite(data.percentage) && data.percentage >= 0 && data.percentage <= 1 ? Math.round(data.percentage * 100) : null
  const voltage = present && finite(data.voltage) && data.voltage > 0 ? data.voltage : null
  const status = present ? ({ 1: '充电中', 2: '放电中', 3: '未充电', 4: '已充满' }[data.power_supply_status] || '状态未知') : ''
  const label = !connected ? '电池未连接' : !data ? '等待电池数据' : !fresh ? '电池数据已过期' : !present ? '未检测到电池' : percentage === null ? '电量未知' : `电量 ${percentage}%`
  return { percentage, voltage, status, label, fresh, low: percentage !== null && percentage <= 20 }
}

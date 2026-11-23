// Precompute the RViz flat arrow geometry once per cloud, in its ROS frame.
export function readParticleCloud(reader) {
  const stamp = reader.readInt32() + reader.readUint32() / 1e9
  const frame = reader.readString()
  const count = reader.readUint32()
  if (!frame) return null
  if (count) reader.align(8)
  if (count > Math.floor((reader.view.byteLength - reader.pos) / 64)) return null
  const path = new Path2D()
  for (let i = 0; i < count; i++) {
    const x = reader.readFloat64(), y = reader.readFloat64()
    reader.readFloat64() // z
    const qx = reader.readFloat64(), qy = reader.readFloat64()
    const qz = reader.readFloat64(), qw = reader.readFloat64()
    const weight = reader.readFloat64()
    if (![x, y, qx, qy, qz, qw, weight].every(Number.isFinite)) continue
    const length = 0.02 + 0.28 * Math.min(1, Math.max(0, weight))
    const yaw = Math.atan2(2 * (qw*qz + qx*qy), 1 - 2 * (qy*qy + qz*qz))
    const dx = length * Math.cos(yaw), dy = length * Math.sin(yaw)
    path.moveTo(x, y)
    path.lineTo(x + dx, y + dy)
    path.lineTo(x + 0.75 * dx - 0.2 * dy, y + 0.75 * dy + 0.2 * dx)
    path.moveTo(x + dx, y + dy)
    path.lineTo(x + 0.75 * dx + 0.2 * dy, y + 0.75 * dy - 0.2 * dx)
  }
  return { frame, stamp, path, count }
}

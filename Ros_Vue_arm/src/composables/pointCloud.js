// PointCloud2 fields and row strides are specified by the publisher.
export function readPointCloud(reader) {
  const stamp = reader.readInt32() * 1000 + reader.readUint32() / 1e6
  const frame = reader.readString()
  const height = reader.readUint32()
  const width = reader.readUint32()
  const fieldCount = reader.readUint32()
  if (fieldCount > 256) throw new Error('点云字段数量无效')
  const axes = {}
  for (let i = 0; i < fieldCount; i++) {
    const name = reader.readString()
    const offset = reader.readUint32()
    const type = reader.readUint8()
    const count = reader.readUint32()
    if (['x', 'y', 'z'].includes(name) && count === 1 && (type === 7 || type === 8)) {
      axes[name] = { offset, type }
    }
  }
  const littleEndian = reader.readUint8() === 0
  const pointStep = reader.readUint32()
  const rowStep = reader.readUint32()
  const bytes = reader.readUint32()
  const fields = [axes.x, axes.y, axes.z]
  if (fields.some(f => !f || f.offset + (f.type === 7 ? 4 : 8) > pointStep) ||
      rowStep < width * pointStep || height * rowStep > bytes || reader.pos + bytes > reader.view.byteLength) {
    throw new Error('点云布局无效')
  }
  const total = height * width
  const stride = Math.max(1, Math.ceil(total / 120000))
  const points = new Float32Array(3 * Math.ceil(total / stride))
  let n = 0
  for (let i = 0; i < total; i += stride) {
    const base = reader.pos + Math.floor(i / width) * rowStep + (i % width) * pointStep
    for (let axis = 0; axis < 3; axis++) {
      const { offset, type } = fields[axis]
      points[n + axis] = type === 7 ? reader.view.getFloat32(base + offset, littleEndian)
                                    : reader.view.getFloat64(base + offset, littleEndian)
    }
    if (Number.isFinite(points[n]) && Number.isFinite(points[n + 1]) && Number.isFinite(points[n + 2])) n += 3
  }
  return { positions: points.subarray(0, n), total, frame, stamp }
}

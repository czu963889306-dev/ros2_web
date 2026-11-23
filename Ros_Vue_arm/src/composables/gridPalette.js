// Byte order matches the ImageData buffer on the current platform.
function makePalette(costmap) {
  const rgba = new Uint8Array(256 * 4)
  for (let value = 0; value < 256; value++) {
    let color
    if (value === 255) {
      color = [112, 137, 134, 255] // OccupancyGrid uses -1 for unknown.
    } else if (value >= 128) {
      color = [255, Math.floor(255 * (value - 128) / 126), 0, 255]
    } else if (value > 100) {
      color = [0, 255, 0, 255]
    } else if (!costmap) {
      const gray = 255 - Math.floor(255 * value / 100)
      color = [gray, gray, gray, 255]
    } else if (value === 0) {
      color = [0, 0, 0, 0]
    } else if (value === 99) {
      color = [0, 255, 255, 255]
    } else if (value === 100) {
      color = [255, 0, 255, 255]
    } else {
      const red = Math.floor(255 * value / 100)
      color = [red, 0, 255 - red, 255]
    }
    rgba.set(color, value * 4)
  }
  return new Uint32Array(rgba.buffer)
}

export const mapPalette = makePalette(false)
export const costmapPalette = makePalette(true)

export function renderGrid(grid, canvas, palette) {
  const { width, height } = grid.info
  if (!width || !height || grid.data?.length !== width * height) return null
  canvas ??= document.createElement('canvas')
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(width, height)
  const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height)
  // ROS starts at the bottom-left and ImageData starts at the top-left.
  for (let y = 0; y < height; y++) {
    const src = y * width
    const dest = (height - 1 - y) * width
    for (let x = 0; x < width; x++) pixels[dest + x] = palette[grid.data[src + x] & 255]
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

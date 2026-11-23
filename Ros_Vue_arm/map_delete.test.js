import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { installMapSaving } from './map_save.js'
import { PointStore } from './navigation.js'

test('deleting a map preserves active maps and shared rasters and removes only its presets', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-delete-'))
  const store = new PointStore(path.join(dir, 'points.json'), () => dir)
  const base = name => path.join(dir, name)
  for (const [name, image] of [['活动', 'shared.pgm'], ['old', './shared.pgm'], ['other.v1', 'other image.png']])
    fs.writeFileSync(base(name + '.yaml'), 'image: ' + JSON.stringify(image))
  for (const name of ['shared.pgm','other image.png']) fs.writeFileSync(base(name), 'pixels')
  for (const map of ['活动', 'old', 'other.v1'])
    store.save({ mapPath: base(map), name: '厨房', x: 0, y: 0, yaw: 0 })
  const app = express()
  installMapSaving(app, { loadConfig: () => ({ maps_dir: dir }), navigationMap: () => base('活动'), pointStore: store })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true }) })
  const remove = (name, headers = { 'X-Map-Delete': '1' }) =>
    fetch('http://127.0.0.1:' + server.address().port + '/api/maps/' + encodeURIComponent(name), { method: 'DELETE', headers })
  assert.equal((await remove('活动')).status, 409)
  assert.equal((await remove('../old')).status, 400)
  assert.equal((await remove('old', {})).status, 403)
  assert.equal((await remove('old', { Origin: 'http://elsewhere.test', 'X-Map-Delete':'1' })).status, 403)
  assert.deepEqual(await (await remove('old')).json(), { success: true, removedPoints: 1 })
  assert(fs.existsSync(base('shared.pgm')))
  assert.deepEqual(await (await remove('other.v1')).json(), { success: true, removedPoints: 1 })
  assert(!fs.existsSync(base('other image.png')))
  assert.equal((await remove('other.v1')).status, 404)
  assert.deepEqual(store.read().map(p => p.mapPath), [base('活动')])
  assert.deepEqual(fs.readdirSync(dir).sort(), ['points.json', 'shared.pgm', '活动.yaml'])
})

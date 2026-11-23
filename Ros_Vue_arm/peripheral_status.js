import fs from 'node:fs/promises';
import path from 'node:path';

const depthCameraNames = {
  '0401': 'Orbbec Astra',
  '0402': 'Orbbec Astra S',
  '0403': 'Orbbec Astra Pro',
  '0404': 'Orbbec Astra Mini',
  '0407': 'Orbbec Astra Mini S',
  '0532': 'Orbbec Astra+',
  '0604': 'Orbbec Astra Depth',
  '060d': 'Orbbec Astra Pro Plus'
};

const read = async (directory, file) => (await fs.readFile(path.join(directory, file), 'utf8')).trim();
const optionalRead = (directory, file) => read(directory, file).catch(error => {
  if (error.code === 'ENOENT' || error.code === 'ENODEV') return '';
  throw error;
});

export async function readCameras(root = '/sys/bus/usb/devices') {
  const entries = await fs.readdir(root);
  // A USB camera can expose several video and metadata interfaces. Group by USB device.
  const interfaces = await Promise.all(entries.filter(entry => entry.includes(':')).map(async entry => {
    const directory = path.join(root, entry);
    const [type, subtype] = await Promise.all([
      optionalRead(directory, 'bInterfaceClass'),
      optionalRead(directory, 'bInterfaceSubClass')
    ]);
    return type.toLowerCase() === '0e' && subtype === '01' ? entry.split(':')[0] : null;
  }));
  const uvc = new Set(interfaces.filter(Boolean));

  const cameras = await Promise.all(entries.filter(entry => !entry.includes(':')).map(async entry => {
    const directory = path.join(root, entry);
    const [vendor, productId] = await Promise.all([
      optionalRead(directory, 'idVendor'), optionalRead(directory, 'idProduct')
    ]);
    if (!vendor || !productId) return null;
    const depth = vendor === '2bc5' ? depthCameraNames[productId] : null;
    if (!depth && !uvc.has(entry)) return null;
    const product = await optionalRead(directory, 'product');
    return {
      name: depth || product || 'USB 相机（' + vendor + ':' + productId + '）',
      type: depth ? 'depth' : 'uvc'
    };
  }));
  return cameras.filter(Boolean);
}

export function voiceModuleStatus(config, cards, pcm) {
  // The voice assistant uses a flat YAML config and defaults to this USB module.
  const devices = { INPUT_DEVICE: 'plughw:CARD=UACDemoV10,DEV=0', OUTPUT_DEVICE: 'plughw:CARD=UACDemoV10,DEV=0' };
  for (const match of config.matchAll(/^[ \t]*(INPUT_DEVICE|OUTPUT_DEVICE)[ \t]*:[ \t]*(.*)$/gm)) {
    const value = match[2].split(/ +#/)[0].trim().replace(/^(['"])(.*)\1$/, '$2');
    devices[match[1]] = value;
  }
  const cardNumbers = new Map([...cards.matchAll(/^\s*(\d+)\s+\[([^\]]+)\]/gm)]
    .map(([, index, id]) => [id.trim(), Number(index)]));
  const endpoints = [...pcm.matchAll(/^(\d+)-(\d+):([^\r\n]*)/gm)];
  const checks = Object.entries(devices).map(([setting, device]) => {
    const hardware = /^(?:plughw|hw):(?:CARD=)?([\w-]+)(?:,(?:DEV=)?(\d+))?$/.exec(device);
    if (!hardware) return null;
    const [, card, index = '0'] = hardware;
    const cardNumber = /^\d+$/.test(card) ? Number(card) : cardNumbers.get(card);
    const direction = setting === 'INPUT_DEVICE' ? 'capture' : 'playback';
    return endpoints.some(([, c, d, capabilities]) =>
      Number(c) === cardNumber && Number(d) === Number(index)
      && new RegExp('\\b' + direction + '\\s+[1-9]\\d*').test(capabilities));
  });
  if (checks.includes(false)) return false;
  return checks.includes(null) ? null : true;
}

export async function readVoiceModule(voiceConfig, root = '/proc/asound') {
  const [config, cards, pcm] = await Promise.all([
    fs.readFile(voiceConfig, 'utf8'), read(root, 'cards'), optionalRead(root, 'pcm')
  ]);
  return voiceModuleStatus(config, cards, pcm);
}

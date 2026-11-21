import { crc32, deflateRawSync } from 'node:zlib'

export function zipFixture(contents, { compress = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [file, bytes] of Object.entries(contents)) {
    const encoded = compress ? deflateRawSync(bytes) : bytes
    const name = Buffer.from(file)
    const crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(compress ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(encoded.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(compress ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(encoded.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, encoded)
    centrals.push(central, name)
    offset += local.length + name.length + encoded.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(centrals.reduce((total, item) => total + item.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

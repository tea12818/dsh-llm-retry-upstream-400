// Minimal read-only Electron ASAR reader.
// Usage:
//   node asar.mjs list <asar> [prefixFilter]        -> list file paths
//   node asar.mjs cat  <asar> <innerPath>           -> print file content
import fs from 'node:fs'

const ASAR = process.argv[2]
const mode = process.argv[3]

function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const buf = Buffer.alloc(headerSize)
  fs.readSync(fd, buf, 0, headerSize, 8)
  const jsonLen = buf.readUInt32LE(4)
  const json = buf.subarray(8, 8 + jsonLen).toString('utf8')
  fs.closeSync(fd)
  return { header: JSON.parse(json), dataOffset: 8 + headerSize }
}

function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name
      if (child.files) walk(child, p, out)
      else out.push({ path: p, offset: child.offset, size: child.size, unpacked: !!child.unpacked, link: child.link })
    }
  }
}

const { header, dataOffset } = readHeader(ASAR)
const files = []
walk(header, '', files)

if (mode === 'extract') {
  const prefix = process.argv[4]
  const outDir = process.argv[5]
  const fd = fs.openSync(ASAR, 'r')
  let n = 0
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue
    const dest = outDir + '/' + f.path.slice(prefix.length)
    fs.mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true })
    let data
    if (f.unpacked) {
      data = fs.readFileSync(ASAR + '.unpacked/' + f.path)
    } else {
      const b = Buffer.alloc(f.size)
      fs.readSync(fd, b, 0, f.size, dataOffset + Number(f.offset))
      data = b
    }
    fs.writeFileSync(dest, data)
    n++
  }
  fs.closeSync(fd)
  console.log('extracted ' + n + ' files to ' + outDir)
} else if (mode === 'list') {
  const filter = process.argv[4] || ''
  for (const f of files) if (f.path.includes(filter)) console.log(f.path)
} else if (mode === 'cat') {
  const inner = process.argv[4]
  const f = files.find((x) => x.path === inner) || files.find((x) => x.path.endsWith(inner))
  if (!f) {
    console.error('not found: ' + inner)
    process.exit(1)
  }
  let data
  if (f.unpacked) {
    data = fs.readFileSync(ASAR + '.unpacked/' + f.path)
  } else if (f.link) {
    const target = files.find((x) => x.path === f.link)
    data = fs.readFileSync(ASAR, { start: 0 })
    const fd = fs.openSync(ASAR, 'r')
    const b = Buffer.alloc(target.size)
    fs.readSync(fd, b, 0, target.size, dataOffset + Number(target.offset))
    fs.closeSync(fd)
    data = b
  } else {
    const fd = fs.openSync(ASAR, 'r')
    const b = Buffer.alloc(f.size)
    fs.readSync(fd, b, 0, f.size, dataOffset + Number(f.offset))
    fs.closeSync(fd)
    data = b
  }
  process.stdout.write(data)
}

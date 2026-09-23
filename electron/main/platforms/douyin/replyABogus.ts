const CUSTOM_BASE64 = {
  s3: 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe',
  s4: 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
} as const

const WINDOW_PROFILE = '1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32'
const TEXT_ENCODER = new TextEncoder()

export interface ReplyABogusOptions {
  nowMs?: number
  randomInt?: (minimum: number, maximum: number) => number
}

function rotateLeft(value: number, amount: number): number {
  const shift = amount % 32
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

function sm3F(round: number, x: number, y: number, z: number): number {
  return round < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0
}

function sm3G(round: number, x: number, y: number, z: number): number {
  return round < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0
}

function sm3P0(value: number): number {
  return (value ^ rotateLeft(value, 9) ^ rotateLeft(value, 17)) >>> 0
}

function sm3P1(value: number): number {
  return (value ^ rotateLeft(value, 15) ^ rotateLeft(value, 23)) >>> 0
}

function readUint32BigEndian(bytes: number[], offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function sm3Compress(state: number[], block: number[]): number[] {
  const words = Array.from({ length: 16 }, (_, index) => readUint32BigEndian(block, index * 4))
  for (let index = 16; index < 68; index += 1) {
    const expanded = sm3P1(
      (words[index - 16] ^ words[index - 9] ^ rotateLeft(words[index - 3], 15)) >>> 0,
    )
    words.push((expanded ^ rotateLeft(words[index - 13], 7) ^ words[index - 6]) >>> 0)
  }
  const derivedWords = Array.from(
    { length: 64 },
    (_, index) => (words[index] ^ words[index + 4]) >>> 0,
  )

  let [a, b, c, d, e, f, g, h] = state
  for (let round = 0; round < 64; round += 1) {
    const constant = round < 16 ? 0x79cc4519 : 0x7a879d8a
    const ss1 = rotateLeft((rotateLeft(a, 12) + e + rotateLeft(constant, round)) >>> 0, 7)
    const ss2 = (ss1 ^ rotateLeft(a, 12)) >>> 0
    const tt1 = (sm3F(round, a, b, c) + d + ss2 + derivedWords[round]) >>> 0
    const tt2 = (sm3G(round, e, f, g) + h + ss1 + words[round]) >>> 0
    ;[d, c, b, a] = [c, rotateLeft(b, 9), a, tt1]
    ;[h, g, f, e] = [g, rotateLeft(f, 19), e, sm3P0(tt2)]
  }

  const compressed = [a, b, c, d, e, f, g, h]
  return state.map((value, index) => (value ^ compressed[index]) >>> 0)
}

function sm3(input: Uint8Array | number[]): number[] {
  const state = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
  ]
  const bytes = [...input]
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)

  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  for (const value of [high, low]) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }

  let digest = state
  for (let offset = 0; offset < bytes.length; offset += 64) {
    digest = sm3Compress(digest, bytes.slice(offset, offset + 64))
  }

  return digest.flatMap(value => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function doubleSm3(input: Uint8Array | number[]): number[] {
  return sm3(sm3(input))
}

function rc4(input: Uint8Array | number[], key: Uint8Array | number[]): number[] {
  const state = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) % 256
    ;[state[index], state[j]] = [state[j], state[index]]
  }

  let i = 0
  j = 0
  return [...input].map(value => {
    i = (i + 1) % 256
    j = (j + state[i]) % 256
    ;[state[i], state[j]] = [state[j], state[i]]
    return value ^ state[(state[i] + state[j]) % 256]
  })
}

function customBase64(input: number[], tableName: keyof typeof CUSTOM_BASE64): string {
  const table = CUSTOM_BASE64[tableName]
  let output = ''
  for (let offset = 0; offset + 2 < input.length; offset += 3) {
    const value = (input[offset] << 16) | (input[offset + 1] << 8) | input[offset + 2]
    output += table[(value & 0xfc0000) >>> 18]
    output += table[(value & 0x03f000) >>> 12]
    output += table[(value & 0x000fc0) >>> 6]
    output += table[value & 0x00003f]
  }
  return output
}

function generateRandomPrefix(randomInt: (minimum: number, maximum: number) => number): number[] {
  const mix = (randomValue: number, mask: [number, number]) => [
    (randomValue & 0xff & 0xaa) | (mask[0] & 0x55),
    (randomValue & 0xff & 0x55) | (mask[0] & 0xaa),
    ((randomValue >>> 8) & 0xff & 0xaa) | (mask[1] & 0x55),
    ((randomValue >>> 8) & 0xff & 0x55) | (mask[1] & 0xaa),
  ]

  return (
    [
      [3, 45],
      [1, 0],
      [1, 5],
    ] as Array<[number, number]>
  ).flatMap(mask => mix(randomInt(0, 9999), mask))
}

function buildPayload(query: string, userAgent: string, nowMs: number): number[] {
  const args = [0, 1, 8]
  const suffix = TEXT_ENCODER.encode('cus')
  const urlDigest = doubleSm3(TEXT_ENCODER.encode(`${query}cus`))
  const suffixDigest = doubleSm3(suffix)
  const encryptedUa = rc4(TEXT_ENCODER.encode(userAgent), [0, 1, args[2]])
  const encodedUa = customBase64(encryptedUa, 's3')
  const uaDigest = sm3(TEXT_ENCODER.encode(encodedUa))
  const timestamp = Math.trunc(nowMs)
  const fields: number[] = []

  fields[8] = 3
  fields[10] = timestamp
  fields[18] = 44
  fields[20] = (timestamp >>> 24) & 0xff
  fields[21] = (timestamp >>> 16) & 0xff
  fields[22] = (timestamp >>> 8) & 0xff
  fields[23] = timestamp & 0xff
  fields[24] = Math.floor(timestamp / 256 ** 4)
  fields[25] = Math.floor(timestamp / 256 ** 5)

  for (const [index, shift] of [24, 16, 8, 0].entries()) {
    fields[26 + index] = (args[0] >>> shift) & 0xff
    fields[34 + index] = (args[2] >>> shift) & 0xff
  }
  fields[30] = Math.floor(args[1] / 256) & 0xff
  fields[31] = args[1] & 0xff
  fields[32] = (args[1] >>> 24) & 0xff
  fields[33] = (args[1] >>> 16) & 0xff
  fields[38] = urlDigest[21]
  fields[39] = urlDigest[22]
  fields[40] = suffixDigest[21]
  fields[41] = suffixDigest[22]
  fields[42] = uaDigest[23]
  fields[43] = uaDigest[24]

  for (const [index, shift] of [24, 16, 8, 0].entries()) {
    fields[44 + index] = (timestamp >>> shift) & 0xff
  }
  fields[48] = fields[8]
  fields[49] = Math.floor(timestamp / 256 ** 4)
  fields[50] = Math.floor(timestamp / 256 ** 5)

  const pageId = 6241
  for (const [index, shift] of [24, 16, 8, 0].entries()) {
    fields[52 + index] = (pageId >>> shift) & 0xff
  }
  const aid = 6383
  fields[57] = aid & 0xff
  fields[58] = (aid >>> 8) & 0xff
  fields[59] = (aid >>> 16) & 0xff
  fields[60] = (aid >>> 24) & 0xff

  const windowProfile = [...TEXT_ENCODER.encode(WINDOW_PROFILE)]
  fields[65] = windowProfile.length & 0xff
  fields[66] = (windowProfile.length >>> 8) & 0xff
  fields[70] = 0
  fields[71] = 0

  const checksumIndexes = [
    18, 20, 26, 30, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37, 44, 45,
    46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
  ]
  fields[72] = checksumIndexes.reduce((checksum, index) => checksum ^ fields[index], 0)

  const payloadIndexes = [
    18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28, 32,
    60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
  ]
  return rc4([...payloadIndexes.map(index => fields[index]), ...windowProfile, fields[72]], [121])
}

export function signReplyABogus(
  query: string,
  userAgent: string,
  options: ReplyABogusOptions = {},
): string {
  const randomInt =
    options.randomInt ??
    ((minimum: number, maximum: number) =>
      minimum + Math.floor(Math.random() * (maximum - minimum + 1)))
  const prefix = generateRandomPrefix(randomInt)
  const payload = buildPayload(query, userAgent, options.nowMs ?? Date.now())
  return `${customBase64([...prefix, ...payload], 's4')}=`
}

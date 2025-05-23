const base64abc = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "+",
  "/",
]

/**
 * CREDIT: https://gist.github.com/enepomnyaschih/72c423f727d395eeaa09697058238727
 * Encodes a given Uint8Array, ArrayBuffer or string into RFC4648 base64 representation
 * @param data
 */
function encodeBase64(data: ArrayBuffer | string): string {
  const uint8 =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data)
  let result = ""
  let i: number
  const l = uint8.length
  for (i = 2; i < l; i += 3) {
    const idx1 = uint8[i - 2]! >> 2
    const idx2 = ((uint8[i - 2]! & 0x03) << 4) | (uint8[i - 1]! >> 4)
    const idx3 = ((uint8[i - 1]! & 0x0f) << 2) | (uint8[i]! >> 6)
    const idx4 = uint8[i]! & 0x3f

    if (base64abc[idx1] && base64abc[idx2] && base64abc[idx3] && base64abc[idx4]) {
      result += base64abc[idx1]
      result += base64abc[idx2]
      result += base64abc[idx3]
      result += base64abc[idx4]
    }
  }
  if (i === l + 1) {
    // 1 octet yet to write
    result += base64abc[uint8[i - 2]! >> 2]!
    result += base64abc[(uint8[i - 2]! & 0x03) << 4]!
    result += "=="
  }
  if (i === l) {
    // 2 octets yet to write
    result += base64abc[uint8[i - 2]! >> 2]!
    result += base64abc[((uint8[i - 2]! & 0x03) << 4) | (uint8[i - 1]! >> 4)]!
    result += base64abc[(uint8[i - 1]! & 0x0f) << 2]!
    result += "="
  }
  return result
}

/**
 * Decodes a given RFC4648 base64 encoded string
 * @param b64
 */
function decodeBase64(b64: string): Uint8Array {
  const binString = atob(b64)
  const size = binString.length
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    bytes[i] = binString.charCodeAt(i)
  }
  return bytes
}

export async function hashStringSHA256(str: string) {
  // Encode the string into bytes
  const encoder = new TextEncoder()
  const data = encoder.encode(str)

  // Hash the data with SHA-256
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)

  return encodeBase64(hashBuffer)
}

export const base64 = {
  encodeBase64,
  decodeBase64,
}

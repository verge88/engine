// Radiance RGBE (.hdr) decoder. No DOM or external dependency; usable in Node tests.
// Supports standard scanline RLE and non-RLE pixels. Legacy RGBE run markers
// are deliberately rejected (rare, non-standard in modern HDRI exports).
const MAX_PIXELS = 16_777_216;
const decoder = new TextDecoder();

function line(bytes, position) {
  const end = bytes.indexOf(10, position);
  if (end < 0) throw new Error('Truncated Radiance header');
  const text = decoder.decode(bytes.subarray(position, end)).replace(/\r$/, '');
  return [text, end + 1];
}
function requireBytes(bytes, offset, count) {
  if (offset + count > bytes.length) throw new Error('Truncated Radiance pixel data');
}
function decodeScanline(bytes, offset, width) {
  const scanline = new Uint8Array(width * 4);
  const isRLE = width >= 8 && width <= 32767 &&
    bytes[offset] === 2 && bytes[offset + 1] === 2 &&
    (bytes[offset + 2] & 0x80) === 0;
  if (!isRLE) {
    requireBytes(bytes, offset, width * 4);
    scanline.set(bytes.subarray(offset, offset + width * 4));
    return [scanline, offset + width * 4];
  }
  requireBytes(bytes, offset, 4);
  const encodedWidth = (bytes[offset + 2] << 8) | bytes[offset + 3];
  if (encodedWidth !== width) throw new Error('Radiance RLE scanline width mismatch');
  offset += 4;
  for (let channel = 0; channel < 4; channel++) {
    let x = 0;
    while (x < width) {
      requireBytes(bytes, offset, 1);
      const token = bytes[offset++];
      if (token === 0) throw new Error('Invalid Radiance RLE zero-length run');
      if (token > 128) {
        const count = token - 128;
        requireBytes(bytes, offset, 1);
        if (x + count > width) throw new Error('Radiance RLE overflows scanline');
        const value = bytes[offset++];
        for (let j = 0; j < count; j++) scanline[(x++ * 4) + channel] = value;
      } else {
        if (x + token > width) throw new Error('Radiance RLE literal overflows scanline');
        requireBytes(bytes, offset, token);
        for (let j = 0; j < token; j++) scanline[(x++ * 4) + channel] = bytes[offset++];
      }
    }
  }
  return [scanline, offset];
}

export function decodeRadiance(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = 0;
  let first;
  [first, offset] = line(bytes, offset);
  if (first !== '#?RADIANCE' && first !== '#?RGBE')
    throw new Error('Not a Radiance HDR image');
  let format = false;
  let headerLine;
  for (;;) {
    [headerLine, offset] = line(bytes, offset);
    if (!headerLine.trim()) break;
    if (/^FORMAT=32-bit_rle_rgbe$/i.test(headerLine.trim())) format = true;
  }
  if (!format) throw new Error('Unsupported Radiance HDR format');
  let resolution;
  [resolution, offset] = line(bytes, offset);
  const match = /^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)\s*$/.exec(resolution);
  if (!match) throw new Error('Unsupported Radiance resolution/orientation (expected Y then X)');
  const height = Number(match[2]);
  const width = Number(match[4]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_PIXELS)
    throw new Error('Invalid/oversized Radiance HDR dimensions');
  const topFirst = match[1] === '-';
  const leftFirst = match[3] === '+';
  const pixels = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const [scanline, nextOffset] = decodeScanline(bytes, offset, width);
    offset = nextOffset;
    const y = topFirst ? row : height - 1 - row;
    for (let x = 0; x < width; x++) {
      const sx = x * 4;
      const dx = (y * width + (leftFirst ? x : width - 1 - x)) * 4;
      const exponent = scanline[sx + 3];
      const factor = exponent === 0 ? 0 : Math.pow(2, exponent - 136);
      for (let channel = 0; channel < 3; channel++) {
        pixels[dx + channel] = scanline[sx + channel] * factor;
      }
      pixels[dx + 3] = 1;
    }
  }
  return { width, height, pixels };
}

// HDRI texture upload uses rgba16float and 256-byte row pitch alignment.
export function floatToHalfPositive(value) {
  if (!Number.isFinite(value)) throw new RangeError('Nonfinite HDR pixel');
  if (value <= 0) return 0;
  if (value >= 65504) return 0x7bff;
  const exponent = Math.floor(Math.log2(value));
  if (exponent < -14) return Math.round(value * 16777216);
  const e = exponent + 15;
  const fraction = Math.round((value / Math.pow(2, exponent) - 1) * 1024);
  return fraction === 1024 ? (e + 1) << 10 : (e << 10) | fraction;
}
export function packRGBA16F({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_PIXELS ||
      pixels.length !== width * height * 4) throw new Error('Invalid HDR image');
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const halfsPerRow = bytesPerRow / 2;
  const packed = new Uint16Array(halfsPerRow * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = (y * width + x) * 4;
    const dst = y * halfsPerRow + x * 4;
    for (let c = 0; c < 4; c++) packed[dst + c] = floatToHalfPositive(pixels[src + c]);
  }
  return { bytesPerRow, data: packed };
}

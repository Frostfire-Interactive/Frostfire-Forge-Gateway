// Binary CREATURE_MOVE datagrams (the server's socket/creature_move_codec.ts has the same layout):
//   [u8 0x04][u16 count, little endian] then per creature 13 bytes:
//   [u32 id][i32 x][i32 y][u8 flags]      flags: bits 0-2 the direction, bit 3 moving
// Each entry decodes to the [id, x, y, dir, moving] the JSON packet carries, so applyCreatureMove takes either.

export const CREATURE_MOVE_HEADER = 0x04;
const HEADER_BYTES = 3;
const ENTRY_BYTES = 13;

// Direction names by code. Must equal the server's DIRECTION_ORDER.
const DIRECTION_ORDER = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];

export type CreatureMoveEntry = [number, number, number, string, 0 | 1];

/** The entries of a datagram; none for anything that is not a whole, well-formed one (never throws). */
export function decodeCreatureMoves(bytes: Uint8Array): CreatureMoveEntry[] {
  const entries: CreatureMoveEntry[] = [];
  if (!bytes || bytes.length < HEADER_BYTES || bytes[0] !== CREATURE_MOVE_HEADER) return entries;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A count larger than the bytes present is cut to the whole records there are.
  const count = Math.min(view.getUint16(1, true), Math.floor((bytes.length - HEADER_BYTES) / ENTRY_BYTES));
  for (let i = 0, at = HEADER_BYTES; i < count; i++, at += ENTRY_BYTES) {
    const flags = bytes[at + 12];
    entries.push([
      view.getUint32(at, true),
      view.getInt32(at + 4, true),
      view.getInt32(at + 8, true),
      DIRECTION_ORDER[flags & 0x07],
      (flags & 0x08) !== 0 ? 1 : 0,
    ]);
  }
  return entries;
}

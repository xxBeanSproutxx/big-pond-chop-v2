'use strict';
// Bundle reader for public/tables.v1.bin. Layout per docs/BUILD-SPEC.md:
//   [0 .. 166,440)        depth grid 292 x 285, uint16, ft x 4 (0.25 ft), 65535 = land
//   [166,440 .. 464,360)  fetchEff 16 x 98 x 95, uint16, decametres, 65535 = invalid
//   [464,360 .. 613,320)  pathEff  16 x 98 x 95, uint8, ft
// Grid order is [dir][row][col]. Little-endian via explicit DataView.

const BATHY_ROWS = 292;
const BATHY_COLS = 285;
const FETCH_DIRS = 16;
const FETCH_ROWS = 98;
const FETCH_COLS = 95;
const OFF_DEPTH = 0;
const OFF_FETCH = 166440;
const OFF_PATH = 464360;
const TOTAL_BYTES = 613320;
const LAND_U16 = 65535;
const BATHY_CELLS = BATHY_ROWS * BATHY_COLS; // 83,220
const FETCH_CELLS = FETCH_DIRS * FETCH_ROWS * FETCH_COLS; // 148,960

const cache = new Map();

function decodeTables(buffer) {
  let u8;
  if (buffer instanceof ArrayBuffer) {
    u8 = new Uint8Array(buffer);
  } else {
    u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (u8.byteLength !== TOTAL_BYTES) {
    throw new Error(`tables.v1.bin must be ${TOTAL_BYTES} bytes, got ${u8.byteLength}`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const depth = new Uint16Array(BATHY_CELLS);
  for (let i = 0; i < BATHY_CELLS; i++) depth[i] = dv.getUint16(OFF_DEPTH + i * 2, true);
  const fetchEff = new Uint16Array(FETCH_CELLS);
  for (let i = 0; i < FETCH_CELLS; i++) fetchEff[i] = dv.getUint16(OFF_FETCH + i * 2, true);
  const pathEff = new Uint8Array(FETCH_CELLS);
  for (let i = 0; i < FETCH_CELLS; i++) pathEff[i] = dv.getUint8(OFF_PATH + i);
  return { depth, fetchEff, pathEff, bytes: u8 };
}

function fetchIndex(dir, row, col) {
  return (dir * FETCH_ROWS + row) * FETCH_COLS + col;
}

function loadTables(filePath) {
  const key = String(filePath);
  if (cache.has(key)) return cache.get(key);
  const fs = require('fs');
  const t = decodeTables(fs.readFileSync(key));
  cache.set(key, t);
  return t;
}

module.exports = {
  decodeTables,
  fetchIndex,
  loadTables,
  BATHY_ROWS, BATHY_COLS, BATHY_CELLS,
  FETCH_DIRS, FETCH_ROWS, FETCH_COLS, FETCH_CELLS,
  OFF_DEPTH, OFF_FETCH, OFF_PATH, TOTAL_BYTES, LAND_U16,
};

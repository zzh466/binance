// Build-time only. No application startup, trading or user-data paths are changed.
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const NSIS_SIGNATURE = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
const UNINSTALL = 1;
const NO_CRC = 4;
const FORCE_CRC = 8;
const READER_FIX = Symbol.for("binance.nsis.uninstaller.iconFix");
const MAX_BLOCK_SIZE = 32 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function requireRange(buffer, offset, size, label) {
  if (offset < 0 || size < 0 || offset + size > buffer.length) {
    throw new Error(`Truncated or invalid NSIS ${label}`);
  }
}

function peOverlayOffset(buffer) {
  requireRange(buffer, 0, 64, "DOS header");
  if (buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Invalid NSIS MZ signature");
  }
  const pe = buffer.readUInt32LE(60);
  requireRange(buffer, pe, 24, "PE header");
  if (buffer.readUInt32LE(pe) !== 0x00004550) {
    throw new Error("Invalid NSIS PE signature");
  }
  const sections = buffer.readUInt16LE(pe + 6);
  const table = pe + 24 + buffer.readUInt16LE(pe + 20);
  if (!sections) throw new Error("Invalid NSIS PE section count");
  requireRange(buffer, table, sections * 40, "PE section table");
  let overlay = 0;
  for (let index = 0; index < sections; index += 1) {
    const section = table + index * 40;
    const size = buffer.readUInt32LE(section + 16);
    const offset = buffer.readUInt32LE(section + 20);
    if (size) {
      requireRange(buffer, offset, size, "PE section");
      overlay = Math.max(overlay, offset + size);
    }
  }
  if (overlay < 512 || overlay % 512 !== 0) {
    throw new Error("Unsupported NSIS PE overlay alignment");
  }
  return overlay;
}

function dataHeader(buffer, offset) {
  requireRange(buffer, offset, 28, "first header");
  if (!buffer.subarray(offset + 4, offset + 20).equals(NSIS_SIGNATURE)) {
    throw new Error("Invalid NSIS signature");
  }
  const flags = buffer.readUInt32LE(offset);
  if (flags & ~15) throw new Error("Unsupported NSIS flags");
  if ((flags & NO_CRC) && !(flags & FORCE_CRC)) {
    throw new Error("NSIS integrity checking must not be disabled");
  }
  const dataSize = buffer.readUInt32LE(offset + 24);
  if (dataSize < 32) throw new Error("Invalid NSIS data size");
  requireRange(buffer, offset, dataSize, "data");
  return {
    offset,
    flags,
    headerSize: buffer.readUInt32LE(offset + 20),
    dataSize,
    crcOffset: offset + dataSize - 4,
  };
}

function readNsisHeader(buffer) {
  return dataHeader(buffer, peOverlayOffset(buffer));
}

function assertNsisIntegrity(buffer, { uninstaller } = {}) {
  const header = readNsisHeader(buffer);
  if (uninstaller !== undefined && Boolean(header.flags & UNINSTALL) !== uninstaller) {
    throw new Error(`Expected NSIS ${uninstaller ? "uninstaller" : "installer"}`);
  }
  // NSIS's default CRC skips the first DOS-header sector and excludes the
  // stored CRC and any trailing Authenticode certificate. CRCCheck stays on.
  const storedCrc = buffer.readUInt32LE(header.crcOffset);
  const calculatedCrc = crc32(buffer.subarray(512, header.crcOffset));
  if (storedCrc !== calculatedCrc) {
    throw new Error(
      `NSIS CRC mismatch: stored=${storedCrc.toString(16)}, calculated=${calculatedCrc.toString(16)}`
    );
  }
  return { ...header, storedCrc, calculatedCrc };
}

function applyIconPatches(executable, patches) {
  const result = Buffer.from(executable);
  let cursor = 0;
  while (cursor < patches.length) {
    requireRange(patches, cursor, 4, "icon patch size");
    const size = patches.readUInt32LE(cursor);
    cursor += 4;
    if (size === 0) {
      if (cursor !== patches.length) throw new Error("Unexpected trailing NSIS icon patch data");
      return result;
    }
    requireRange(patches, cursor, 4 + size, "icon patch");
    const offset = patches.readUInt32LE(cursor);
    cursor += 4;
    requireRange(result, offset, size, "icon patch destination");
    patches.copy(result, offset, cursor, cursor + size);
    cursor += size;
  }
  throw new Error("Missing NSIS icon patch terminator");
}

function extractUninstaller(buffer) {
  const header = assertNsisIntegrity(buffer, { uninstaller: false });
  const blocks = [];
  let cursor = header.offset + 28;
  while (cursor < header.crcOffset) {
    requireRange(buffer, cursor, 4, "block size");
    const encodedSize = buffer.readUInt32LE(cursor);
    cursor += 4;
    const size = encodedSize & 0x7fffffff;
    if (!size || size > MAX_BLOCK_SIZE || cursor + size > header.crcOffset) {
      throw new Error("Invalid or truncated NSIS data block");
    }
    const block = buffer.subarray(cursor, cursor + size);
    cursor += size;
    blocks.push(
      encodedSize & 0x80000000
        ? zlib.inflateRawSync(block, { maxOutputLength: MAX_BLOCK_SIZE })
        : block
    );
  }
  if (cursor !== header.crcOffset) throw new Error("Invalid NSIS block boundary");
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.length >= 28 && block.subarray(4, 20).equals(NSIS_SIGNATURE));
  if (candidates.length !== 1) {
    throw new Error(`Expected one NSIS inner uninstaller block, found ${candidates.length}`);
  }
  const { block: inner, index } = candidates[0];
  const innerHeader = dataHeader(inner, 0);
  if (!(innerHeader.flags & UNINSTALL) || innerHeader.dataSize !== inner.length) {
    throw new Error("Invalid NSIS inner uninstaller");
  }
  if (index === 0) throw new Error("Missing NSIS uninstaller icon patch block");
  // Match NSIS exec.c EW_WRITEUNINSTALLER: uninstall_generate() writes the
  // icon-patch block immediately before the inner uninstall data. Its CRC
  // was calculated using the patched PE header, not the installer header.
  const executable = applyIconPatches(buffer.subarray(0, header.offset), blocks[index - 1]);
  const result = Buffer.concat([executable, inner]);
  assertNsisIntegrity(result, { uninstaller: true });
  return result;
}

function installUninstallerReaderFix({
  hostPlatform = process.platform,
  targetName,
  loadNsisUtil = () => require("app-builder-lib/out/targets/nsis/nsisUtil"),
} = {}) {
  if (hostPlatform !== "darwin" || targetName !== "nsis") return false;
  const { UninstallerReader } = loadNsisUtil();
  if (UninstallerReader[READER_FIX]) return false;
  UninstallerReader.exec = async (installerPath, uninstallerPath) => {
    const buffer = await fs.readFile(installerPath);
    // No node_modules files are edited. Only this build process replaces the
    // buggy macOS cross-build reader, before NSIS embeds the generated file.
    await fs.writeFile(uninstallerPath, extractUninstaller(buffer));
  };
  Object.defineProperty(UninstallerReader, READER_FIX, { value: true });
  return true;
}

function artifactBuildStarted(event, options = {}) {
  // This event precedes uninstaller generation even with --prepackaged or
  // npmRebuild=false, unlike beforeBuild/beforePack.
  installUninstallerReaderFix({ ...options, targetName: event.targetPresentableName });
}

async function artifactBuildCompleted(event, dependencies = {}) {
  if (event.target?.name !== "nsis" || path.extname(event.file).toLowerCase() !== ".exe") return;
  const readFile = dependencies.readFile || fs.readFile;
  const getPath7za = dependencies.getPath7za || require("app-builder-lib/out/toolsets/7zip").getPath7za;
  const run = dependencies.execFile || promisify(execFile);
  const installer = await readFile(event.file);
  assertNsisIntegrity(installer, { uninstaller: false });
  const name = event.packager.appInfo.productFilename;
  const { stdout } = await run(
    await getPath7za(),
    ["e", "-so", event.file, `$R0/Uninstall ${name}.exe`],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }
  );
  if (!Buffer.isBuffer(stdout) || !stdout.length) throw new Error("Missing embedded NSIS uninstaller");
  assertNsisIntegrity(stdout, { uninstaller: true });
  console.log("  • NSIS 安装器及内嵌卸载器完整性校验通过");
}

module.exports = {
  crc32,
  readNsisHeader,
  assertNsisIntegrity,
  applyIconPatches,
  extractUninstaller,
  installUninstallerReaderFix,
  artifactBuildStarted,
  artifactBuildCompleted,
};

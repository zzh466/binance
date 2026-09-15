const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");
const {
  crc32,
  readNsisHeader,
  assertNsisIntegrity,
  applyIconPatches,
  extractUninstaller,
  installUninstallerReaderFix,
  artifactBuildStarted,
  artifactBuildCompleted,
} = require("../scripts/windowsNsisIntegrity");

const NSIS_SIGNATURE = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");

// The fixture checksum is deliberately independent of the production helper.
function fixtureCrc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dword(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0);
  return result;
}

function minimalPe() {
  const result = Buffer.alloc(1024);
  result.write("MZ");
  result.writeUInt32LE(128, 60);
  result.write("PE\0\0", 128, "binary");
  result.writeUInt16LE(0x014c, 132);
  result.writeUInt16LE(1, 134);
  result.writeUInt16LE(224, 148);
  result.writeUInt16LE(0x010b, 152);
  result.write(".text", 376);
  result.writeUInt32LE(512, 392);
  result.writeUInt32LE(512, 396);
  result.fill(0x41, 512);
  return result;
}

function makeNsis(executable, payload, flags = 0) {
  const header = Buffer.alloc(28);
  header.writeUInt32LE(flags, 0);
  NSIS_SIGNATURE.copy(header, 4);
  header.writeUInt32LE(0, 20);
  header.writeUInt32LE(header.length + payload.length + 4, 24);
  const body = Buffer.concat([executable, header, payload]);
  return Buffer.concat([body, dword(fixtureCrc(body.subarray(512)))]);
}

function makeBlock(payload, compressed = false) {
  const bytes = compressed ? zlib.deflateRawSync(payload) : payload;
  return Buffer.concat([dword(bytes.length | (compressed ? 0x80000000 : 0)), bytes]);
}

function makePatches(entries = [{ offset: 600, bytes: Buffer.from("ICON") }]) {
  const chunks = entries.map(({ offset, bytes }) =>
    Buffer.concat([dword(bytes.length), dword(offset), bytes])
  );
  return Buffer.concat([...chunks, dword(0)]);
}

function fixture({ compressed = false, includePatch = true, innerCount = 1 } = {}) {
  const executable = minimalPe();
  const patches = makePatches();
  const expectedExecutable = Buffer.from(executable);
  Buffer.from("ICON").copy(expectedExecutable, 600);
  const expected = makeNsis(expectedExecutable, Buffer.from("uninstall-payload"), 1);
  const inner = expected.subarray(executable.length);
  const blocks = [makeBlock(Buffer.from("outer-header"), compressed)];
  if (includePatch) blocks.push(makeBlock(patches, compressed));
  for (let index = 0; index < innerCount; index += 1) {
    blocks.push(makeBlock(inner, compressed));
  }
  const outer = makeNsis(executable, Buffer.concat(blocks));
  return { executable, patches, expected, inner, outer };
}

test("CRC32 matches the published standard test vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("the independent PE/NSIS fixture exposes offsets and validates original CRC", () => {
  const { outer, expected } = fixture();
  const header = readNsisHeader(outer);
  assert.equal(header.offset, 1024);
  assert.equal(header.flags, 0);
  assert.equal(header.headerSize, 0);
  assert.equal(header.dataSize, outer.length - 1024);
  assert.equal(header.crcOffset, outer.length - 4);
  const result = assertNsisIntegrity(expected, { uninstaller: true });
  assert.equal(result.flags, 1);
  assert.equal(result.storedCrc, result.calculatedCrc);
});

for (const compressed of [false, true]) {
  test(`icon patches recover the uninstaller without changing its CRC (${compressed ? "zlib" : "raw"} blocks)`, () => {
    const { executable, outer, expected, inner } = fixture({ compressed });
    const original = Buffer.from(outer);
    const oldBrokenUninstaller = Buffer.concat([executable, inner]);
    assert.throws(() => assertNsisIntegrity(oldBrokenUninstaller, { uninstaller: true }));
    const repaired = extractUninstaller(outer);
    assert.deepEqual(repaired, expected);
    assert.deepEqual(repaired.subarray(-4), inner.subarray(-4));
    assertNsisIntegrity(repaired, { uninstaller: true });
    assert.deepEqual(outer, original, "extracting must not mutate installer bytes");
  });
}

test("icon patching clones input and applies multiple byte ranges", () => {
  const executable = minimalPe();
  const original = Buffer.from(executable);
  const entries = [
    { offset: 600, bytes: Buffer.from("ICON") },
    { offset: 800, bytes: Buffer.from([1, 2, 3]) },
  ];
  const result = applyIconPatches(executable, makePatches(entries));
  assert.notEqual(result, executable);
  assert.deepEqual(result.subarray(600, 604), Buffer.from("ICON"));
  assert.deepEqual(result.subarray(800, 803), Buffer.from([1, 2, 3]));
  assert.deepEqual(executable, original);
});

test("malformed icon patches fail closed without mutating input", () => {
  const executable = minimalPe();
  const original = Buffer.from(executable);
  const valid = makePatches();
  const cases = [
    ["truncated size", Buffer.from([1, 0])],
    ["truncated offset", Buffer.concat([dword(4), Buffer.from([1, 0])])],
    ["truncated patch bytes", Buffer.concat([dword(4), dword(600), Buffer.from([1])])],
    ["range past stub", makePatches([{ offset: 1023, bytes: Buffer.from("bad") }])],
    ["huge unsigned offset", makePatches([{ offset: 0xffffffff, bytes: Buffer.from("bad") }])],
    ["missing terminator", valid.subarray(0, valid.length - 4)],
    ["bytes after terminator", Buffer.concat([valid, Buffer.from([1])])],
    ["empty patch stream", Buffer.alloc(0)],
  ];
  for (const [label, patches] of cases) {
    assert.throws(() => applyIconPatches(executable, patches), label);
    assert.deepEqual(executable, original, label);
  }
});

test("invalid signatures and truncated executable headers are rejected", () => {
  const { outer } = fixture();
  for (const offset of [0, 128, 1028]) {
    const invalid = Buffer.from(outer);
    invalid[offset] ^= 0xff;
    assert.throws(() => readNsisHeader(invalid));
  }
  for (const length of [0, 1, 61, 130, 400, 1024, 1051]) {
    assert.throws(() => readNsisHeader(outer.subarray(0, length)));
  }
});

test("CRC damage and truncated archives are rejected", () => {
  const { outer } = fixture();
  const corrupt = Buffer.from(outer);
  corrupt[550] ^= 0xff;
  assert.throws(() => assertNsisIntegrity(corrupt));
  assert.throws(() => extractUninstaller(corrupt));
  assert.throws(() => extractUninstaller(outer.subarray(0, outer.length - 1)));
  const checksumDamage = Buffer.from(outer);
  checksumDamage[checksumDamage.length - 1] ^= 0xff;
  assert.throws(() => assertNsisIntegrity(checksumDamage));
});

test("declared archive sizes are enforced and trailing signing bytes are excluded from CRC", () => {
  const { outer } = fixture();
  for (const adjustment of [-1, 1]) {
    const invalid = Buffer.from(outer);
    invalid.writeUInt32LE(outer.length - 1024 + adjustment, 1048);
    assert.throws(() => assertNsisIntegrity(invalid));
  }
  const signedTail = Buffer.concat([outer, Buffer.from("certificate-tail")]);
  assert.equal(readNsisHeader(signedTail).crcOffset, outer.length - 4);
  assertNsisIntegrity(signedTail);
});

test("uninstaller extraction rejects missing icon patches and missing or ambiguous inner blocks", () => {
  assert.throws(() => extractUninstaller(fixture({ includePatch: false }).outer));
  assert.throws(() => extractUninstaller(fixture({ innerCount: 0 }).outer));
  assert.throws(() => extractUninstaller(fixture({ innerCount: 2 }).outer));
});

test("uninstaller extraction rejects malformed raw and compressed block lengths", () => {
  const executable = minimalPe();
  const rawTruncated = makeNsis(executable, Buffer.concat([dword(500), Buffer.from([1])]));
  const invalidCompressed = makeNsis(executable, makeBlock(Buffer.from("not deflate")));
  invalidCompressed.writeUInt32LE(0x8000000b, 1052);
  invalidCompressed.writeUInt32LE(fixtureCrc(invalidCompressed.subarray(512, -4)), invalidCompressed.length - 4);
  assert.throws(() => extractUninstaller(rawTruncated));
  assert.throws(() => extractUninstaller(invalidCompressed));
});

test("the in-process reader fix is scoped to macOS NSIS builds and installs only once", () => {
  const originalExec = () => {};
  const nsisUtil = { UninstallerReader: { exec: originalExec } };
  const options = { hostPlatform: "darwin", targetName: "nsis", loadNsisUtil: () => nsisUtil };
  assert.equal(installUninstallerReaderFix(options), true);
  const patchedExec = nsisUtil.UninstallerReader.exec;
  assert.notEqual(patchedExec, originalExec);
  assert.equal(installUninstallerReaderFix(options), false);
  assert.equal(nsisUtil.UninstallerReader.exec, patchedExec);
});

test("Windows builds and non-NSIS targets never load or override the macOS workaround", () => {
  let loaded = 0;
  const loadNsisUtil = () => { loaded += 1; throw new Error("must not load"); };
  assert.equal(installUninstallerReaderFix({ hostPlatform: "win32", targetName: "nsis", loadNsisUtil }), false);
  assert.equal(installUninstallerReaderFix({ hostPlatform: "darwin", targetName: "zip", loadNsisUtil }), false);
  assert.equal(loaded, 0);
});

test("artifact-start hook installs the workaround before macOS NSIS generation", async () => {
  const originalExec = () => {};
  const nsisUtil = { UninstallerReader: { exec: originalExec } };
  const options = { hostPlatform: "darwin", loadNsisUtil: () => nsisUtil };
  await artifactBuildStarted({ targetPresentableName: "nsis", file: "/tmp/installer.exe" }, options);
  assert.notEqual(nsisUtil.UninstallerReader.exec, originalExec);
});

test("artifact-start hook keeps Windows native builds and unrelated targets unchanged", async () => {
  let loaded = 0;
  const loadNsisUtil = () => { loaded += 1; throw new Error("must not load"); };
  await artifactBuildStarted({ targetPresentableName: "nsis", file: "C:\\temp\\installer.exe" }, { hostPlatform: "win32", loadNsisUtil });
  await artifactBuildStarted({ targetPresentableName: "zip", file: "/tmp/app.zip" }, { hostPlatform: "darwin", loadNsisUtil });
  assert.equal(loaded, 0);
});

function completedEvent(file, target = "nsis") {
  return {
    target: { name: target },
    file,
    packager: { appInfo: { productFilename: "Binance统一交易台" } },
  };
}

for (const [host, file, tool] of [
  ["darwin", "/private/tmp/构建 空格/Binance-Windows-arm64.exe", "/Users/build/Library/Caches/electron-builder/7za"],
  ["win32", "C:\\Users\\测试 用户\\AppData\\Local\\Temp\\Binance-Windows-arm64.EXE", "C:\\Users\\测试 用户\\AppData\\Local\\electron-builder\\7za.exe"],
]) {
  test(`completed hook checks both installer CRCs and binary extraction on ${host}`, async () => {
    const { outer, expected } = fixture();
    const calls = [];
    await artifactBuildCompleted(completedEvent(file), {
      readFile: async (input) => { assert.equal(input, file); return outer; },
      getPath7za: async () => tool,
      execFile: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: expected };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, tool);
    assert.deepEqual(calls[0].args, ["e", "-so", file, "$R0/Uninstall Binance统一交易台.exe"]);
    assert.equal(calls[0].options.encoding, "buffer");
    assert.notEqual(calls[0].options.shell, true);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.timeout, 60000);
    assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024);
  });
}

test("completed hook rejects an invalid outer CRC before launching an extraction process", async () => {
  const { outer } = fixture();
  outer[600] ^= 0xff;
  let extracted = false;
  await assert.rejects(() => artifactBuildCompleted(completedEvent("/tmp/installer.exe"), {
    readFile: async () => outer,
    getPath7za: async () => { extracted = true; return "/tool/7za"; },
    execFile: async () => { extracted = true; return { stdout: Buffer.alloc(0) }; },
  }));
  assert.equal(extracted, false);
});

test("completed hook rejects invalid, absent or text-decoded embedded uninstallers", async () => {
  const { outer, expected } = fixture();
  const badCrc = Buffer.from(expected);
  badCrc[600] ^= 0xff;
  for (const stdout of [badCrc, Buffer.alloc(0), undefined, expected.toString("binary")]) {
    await assert.rejects(() => artifactBuildCompleted(completedEvent("C:\\build\\installer.exe"), {
      readFile: async () => outer,
      getPath7za: async () => "C:\\tools\\7za.exe",
      execFile: async () => ({ stdout }),
    }));
  }
});

test("completed hook rejects 7zip execution failures instead of allowing distribution", async () => {
  const { outer } = fixture();
  await assert.rejects(() => artifactBuildCompleted(completedEvent("/tmp/installer.exe"), {
    readFile: async () => outer,
    getPath7za: async () => "/tool/7za",
    execFile: async () => { throw new Error("7zip could not extract the uninstaller"); },
  }), /7zip could not extract/);
});

test("completed hook skips zip artifacts, unrelated Windows targets and non-executable files", async () => {
  let touched = false;
  const dependencies = {
    readFile: async () => { touched = true; throw new Error("must not read"); },
    getPath7za: async () => { touched = true; throw new Error("must not resolve"); },
    execFile: async () => { touched = true; throw new Error("must not execute"); },
  };
  await artifactBuildCompleted(completedEvent("/tmp/app.zip", "zip"), dependencies);
  await artifactBuildCompleted(completedEvent("C:\\build\\app.exe", "portable"), dependencies);
  await artifactBuildCompleted(completedEvent("/tmp/app.zip", "nsis"), dependencies);
  assert.equal(touched, false);
});

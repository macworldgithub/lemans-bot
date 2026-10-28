// Downloads the pinned LiveKit server release into tools/livekit and verifies its checksum.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.13.11';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tools', 'livekit');
const exe = path.join(dir, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');

if (existsSync(exe)) {
  console.log(`LiveKit server already installed: ${path.relative(root, exe)}`);
  process.exit(0);
}

const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!os || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
const asset = `livekit_${VERSION}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/livekit/livekit/releases/download/v${VERSION}`;

async function download(name) {
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`Download failed for ${name}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(`Downloading ${asset} ...`);
const [archive, checksums] = await Promise.all([download(asset), download('checksums.txt')]);
const expected = checksums
  .toString()
  .split('\n')
  .find((line) => line.trim().endsWith(asset))
  ?.split(/\s+/)[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${asset}`);

mkdirSync(dir, { recursive: true });
const archivePath = path.join(dir, asset);
writeFileSync(archivePath, archive);
// Windows 10+ ships bsdtar, which reads zip; call it by path so Git Bash's GNU tar can't shadow it.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', asset], { cwd: dir, stdio: 'inherit' });
rmSync(archivePath);
console.log(`Installed LiveKit server ${VERSION} (checksum verified) to ${path.relative(root, dir)}`);

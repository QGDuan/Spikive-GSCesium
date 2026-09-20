import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ReadStream, readFileInfo, readFile } from '@playcanvas/splat-transform';

// Implements the official public filesystem contract; no PLY parser or decoder is copied.
class FileRange extends ReadStream {
  constructor(fd, start, end) {
    super(end - start);
    this.fd = fd;
    this.position = start;
    this.end = end;
    this.closed = false;
  }
  async pull(target) {
    if (this.closed) return 0;
    const n = readSync(this.fd, target, 0, Math.min(target.length, this.end - this.position), this.position);
    this.position += n;
    this.bytesRead += n;
    return n;
  }
  close() {
    this.closed = true;
  }
}
export const nativeFileSystem = {
  async createSource(path) {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    let closed = false;
    return {
      size,
      seekable: true,
      read: (start = 0, end = size) => new FileRange(fd, start, end),
      close() {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      }
    };
  },
  mkdir: (path) => mkdir(path, { recursive: true }),
  async createWriter(path) {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'w');
    let closed = false;
    return {
      bytesWritten: 0,
      async write(data) {
        let offset = 0;
        while (offset < data.byteLength) {
          const { bytesWritten } = await handle.write(data, offset);
          offset += bytesWritten;
          this.bytesWritten += bytesWritten;
        }
      },
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
      async abort() {
        await this.close();
        await rm(path, { force: true });
      }
    };
  }
};
export const sourceInfo = (filename) =>
  readFileInfo({ filename, inputFormat: 'ply', fileSystem: nativeFileSystem });
export const openPly = async (filename) =>
  (await readFile({ filename, inputFormat: 'ply', fileSystem: nativeFileSystem }))[0];

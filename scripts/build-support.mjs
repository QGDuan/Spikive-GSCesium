import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export const TOOL_VERSION = '3.4.2';
export const resourceProfile = (value = 'low-memory') => {
  if (!['low-memory', 'standard'].includes(value)) {
    throw Object.assign(new Error('构建资源模式无效。'), { statusCode: 400 });
  }
  return value;
};
export const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
export const readJson = async (path, fallback = null) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
export const atomicJson = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
};
export const safePath = (root, relative) => {
  if (typeof relative !== 'string' || !relative || relative.includes('\0')) throw new Error('产物路径无效。');
  const path = resolve(root, relative);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error('产物路径越界。');
  return path;
};
export const checkDisk = async (directory, requestedBytes = 0) => {
  const info = await statfs(directory);
  const free = info.bavail * info.bsize;
  if (free < requestedBytes + 2 * 1024 ** 3) {
    throw Object.assign(
      new Error(
        `磁盘空间不足：可用 ${(free / 1024 ** 3).toFixed(1)} 吉字节，当前阶段至少需要 ${((requestedBytes + 2 * 1024 ** 3) / 1024 ** 3).toFixed(1)} 吉字节。`
      ),
      { code: 'DISK_FULL' }
    );
  }
};
export const checkCancelled = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('任务已取消，可继续执行。'), { code: 'CANCELLED' });
};
export const classifyBuildFailure = (message) => {
  if (/CANCELLED|任务已取消/i.test(message))
    return { code: 'CANCELLED', message: '任务已取消，可继续执行。' };
  if (/DISK_FULL|ENOSPC|磁盘空间不足/i.test(message))
    return { code: 'DISK_FULL', message: '磁盘空间不足，请释放临时目录所在磁盘的空间后继续。' };
  if (/mutable-grid|32-bit mutable-grid|safety limit/i.test(message))
    return { code: 'GRID_LIMIT', message: '调试网格超过官方网格保护限制；已完成的碰撞数据不受影响。' };
  if (/DEVICE_HUNG|DEVICE_REMOVED|device.lost|device removed|value is not object/i.test(message))
    return { code: 'GPU_LOST', message: '图形设备挂起或丢失；任务已停止，不会发布受损结果。' };
  if (
    /GPU.*memory|buffer.*(?:limit|exceed|larger)|maxBufferSize|maxStorageBufferBindingSize|out.of.device.memory|StorageBuffer|binding.*size|GPU.*allocation/i.test(
      message
    )
  )
    return { code: 'GPU_MEMORY', message: '图形设备缓冲区或显存不足。' };
  if (
    /heap out of memory|allocation failed|Array buffer allocation|Invalid typed array length|out of memory/i.test(
      message
    )
  )
    return { code: 'RAM', message: '系统内存不足，请关闭占用内存的程序后继续。' };
  return { code: 'CONVERTER', message: '官方转换程序失败，请查看完整任务日志。' };
};

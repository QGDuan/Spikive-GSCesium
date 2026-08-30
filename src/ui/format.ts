export const formatBytes = (value?: number) => {
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} 吉字节`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} 兆字节`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} 千字节`;
  return `${value} 字节`;
};

export const formatBackend = (value: string) => value === 'WebGPU'
  ? '高性能图形模式'
  : value === 'WebGL2'
    ? '兼容图形模式'
    : '三维图形模式';

export const createRatios = (levelCount: number) =>
  Array.from({ length: levelCount }, (_, index) => Math.ceil((100 * (levelCount - index)) / levelCount));

export const shortRevision = (value?: string | null) => value ? value.slice(0, 18) : '—';

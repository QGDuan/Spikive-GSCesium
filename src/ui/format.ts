export const formatBytes = (value?: number) => {
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
};

export const createRatios = (levelCount: number) =>
  Array.from({ length: levelCount }, (_, index) => Math.ceil((100 * (levelCount - index)) / levelCount));

export const shortRevision = (value?: string | null) => value ? value.slice(0, 18) : '—';

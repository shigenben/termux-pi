export function formatElapsed(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new TypeError('seconds must be a finite number');
  }
  if (seconds < 0) {
    throw new RangeError('seconds must be non-negative');
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

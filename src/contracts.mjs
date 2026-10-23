import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
export function revision(value) {
  requireThat(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'Expected a full Git revision');
  return value;
}
export function safePath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/')
    && !/^[a-z]:/i.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe relative path');
  return value;
}
export function projectRoot(value) {
  return value === '.' ? value : safePath(value);
}
export function positiveInteger(value) {
  requireThat(Number.isSafeInteger(value) && value > 0, 'Expected a positive integer');
  return value;
}
export function projectId(root) {
  return sha256(projectRoot(root)).slice(0, 20);
}

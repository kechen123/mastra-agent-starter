import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 组合 className 的统一入口：先 `clsx` 做条件拼接，再 `twMerge` 解决
 * Tailwind 工具类顺序冲突（如 `p-2 p-4` 中后者应胜出）。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones.
 *
 * Both `clsx` and `tailwind-merge` have been in package.json since the start and
 * neither was ever imported — every conditional class in the app is template-
 * literal concatenation. That is why a component could not accept a `className`
 * override without the caller's `px-4` and the component's `px-3` both landing in
 * the DOM and the winner being decided by CSS source order rather than intent.
 *
 * `twMerge` resolves that: the last conflicting utility in the same group wins,
 * which is what every caller already assumes is happening.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

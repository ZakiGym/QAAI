import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

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

/*
 * tailwind-merge has to be told about our type scale.
 *
 * It decides what `text-…` means by looking at the value: a t-shirt size or a
 * length is a font size, anything else is a colour. Every size in `@theme` —
 * `text-micro`, `text-row`, `text-display-lg` — falls through to "colour", so
 * twMerge saw `text-micro text-ink-faint` as two colours and deleted the first.
 *
 * It did this silently, and it was already happening before the redesign:
 * `Button`'s primary variant reduced to `text-body-sm gap-2 …` with
 * `text-white` dropped, so the one button in the app that sets its own text
 * colour was rendering with whatever it inherited. Anything that put a size and
 * a colour in the same `cn()` call lost its size.
 *
 * Registering the scale under `font-size` puts each utility in the right group:
 * sizes now merge against sizes, colours against colours, and the two coexist —
 * which is what they do in CSS, since they set different properties.
 *
 * Keep this list in step with the `--text-*` block in `app/globals.css`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'meta',
            'micro',
            'body-sm',
            'row',
            'row-sub',
            'display-lg',
            'display',
            'display-sm',
            'stat',
            'score',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

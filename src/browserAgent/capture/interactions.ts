/**
 * Interaction capture — logs user clicks with element descriptor and text.
 * Uses capture phase so we see events before any handler stops propagation.
 */

import { push } from '../transport';
import { describeElement } from '../utils';

export function initInteractionCapture(): void {
  if ((document as any).__ms_click_patched) {
    return;
  }
  (document as any).__ms_click_patched = true;

  document.addEventListener(
    'click',
    (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) {
        return;
      } // a click with no element target isn't worth logging
      const text = (target.textContent || '').trim().slice(0, 100);
      push({
        type: 'interaction',
        event: 'click',
        target: describeElement(target),
        text,
        url: location.href,
      });
    },
    true, // capture phase
  );
}

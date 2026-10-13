// FIFO queue: layers of [qty, rate], oldest first (02 §5.2).
// Functions change the queue in place; the caller copies it when it needs to keep an old state.

import { roundQty } from '../money.ts';

export type Layer = [qty: number, rate: number];

/** Add qty at rate to the newest end of the queue (02 §5.2 "Add"). */
export function addToQueue(queue: Layer[], qty: number, rate: number): void {
  const last = queue[queue.length - 1];
  if (!last) {
    queue.push([qty, rate]);
  } else if (last[1] === rate) {
    // Same rate as the newest layer: merge.
    last[0] = roundQty(last[0] + qty);
  } else if (last[0] > 0) {
    queue.push([qty, rate]);
  } else {
    // Newest layer is negative (stock went below zero): fill it first (02 §5.3).
    // If it turns positive the layer takes the new rate, else it stays at its old rate.
    last[0] = roundQty(last[0] + qty);
    if (last[0] > 0) last[1] = rate;
  }
  dropEmptyLayers(queue);
}

/**
 * Take qty from the oldest layers (02 §5.2 "Remove"). Returns the pieces taken, each [qty, rate].
 * (A transfer does not hand these layers to the target: the target gets one layer at their average, referee S03.)
 * If the queue runs out, one negative layer is left at the last rate used (or `fallbackRate` if the
 * queue was empty): 02 §5.2, §5.3.
 */
export function takeFromQueue(queue: Layer[], qty: number, fallbackRate: number): Layer[] {
  const pieces: Layer[] = [];
  let need = qty;
  let lastRate = fallbackRate;
  while (need > 0) {
    const first = queue[0];
    if (!first) {
      queue.push([-need, lastRate]);
      pieces.push([need, lastRate]);
      break;
    }
    if (first[0] <= 0) {
      // Already negative: it goes further below zero at its own rate.
      first[0] = roundQty(first[0] - need);
      pieces.push([need, first[1]]);
      break;
    }
    lastRate = first[1];
    if (first[0] > need) {
      first[0] = roundQty(first[0] - need);
      pieces.push([need, first[1]]);
      break;
    }
    pieces.push([first[0], first[1]]);
    need = roundQty(need - first[0]);
    queue.shift();
  }
  dropEmptyLayers(queue);
  return pieces;
}

export function queueQty(queue: Layer[]): number {
  return roundQty(queue.reduce((sum, [q]) => sum + q, 0));
}

/** Unrounded value of the queue; the caller rounds to money. */
export function queueValue(queue: Layer[]): number {
  return queue.reduce((sum, [q, r]) => sum + q * r, 0);
}

export function copyQueue(queue: Layer[]): Layer[] {
  return queue.map(([q, r]) => [q, r] as Layer);
}

function dropEmptyLayers(queue: Layer[]): void {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i][0] === 0) queue.splice(i, 1);
}

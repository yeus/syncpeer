/**
 * Native element activation for controls inside an Android WebView overlay.
 * Svelte's delegated click listener lives at the app root; an interrupted
 * event path must not make critical setup controls inert.
 */
export const directTap = (node: HTMLButtonElement, activate: () => void | Promise<unknown>) => {
  let touchStart: { id: number; x: number; y: number } | null = null;
  let lastTouchActivation = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary || node.disabled) return;
    touchStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerCancel = () => { touchStart = null; };
  const onPointerUp = (event: PointerEvent) => {
    const start = touchStart;
    touchStart = null;
    if (!start || node.disabled || start.id !== event.pointerId ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
    // Some WebViews deliver touch pointer events without a subsequent click.
    lastTouchActivation = Date.now();
    void activate();
  };
  const onClick = () => {
    if (node.disabled || Date.now() - lastTouchActivation < 750) return;
    void activate();
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerCancel);
  node.addEventListener("click", onClick);
  return {
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
      node.removeEventListener("click", onClick);
    },
  };
};

/** Preserve native form validation, but submit only once per tap or click. */
export const directSubmit = (node: HTMLButtonElement) => {
  const activation = directTap(node, () => {
    const form = node.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit(node);
    } else if (form.reportValidity()) {
      // Old Android WebViews lack requestSubmit; keep validation and onsubmit.
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  });
  // The explicit submit above replaces the browser's default submit on click.
  const preventDuplicate = (event: MouseEvent) => event.preventDefault();
  node.addEventListener("click", preventDuplicate, { capture: true });
  return {
    destroy() {
      activation.destroy();
      node.removeEventListener("click", preventDuplicate, { capture: true });
    },
  };
};

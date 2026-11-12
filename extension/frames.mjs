// Self-contained isolated-world geometry relay; page scripts never supply coordinates.
export async function frameOperation(operation, args) {
  const key = '__jevFrameGeometry_v1';
  globalThis[key] ||= new Map();
  const pending = globalThis[key];
  if (operation === 'send') {
    parent.postMessage({ type: 'jev-frame-geometry', nonce: args.nonce }, '*');
    return { sent: true };
  }
  if (operation === 'prepare') {
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    const listener = (event) => {
      if (
        !event.isTrusted ||
        event.data?.type !== 'jev-frame-geometry' ||
        event.data.nonce !== args.nonce
      )
        return;
      const roots = [document];
      for (let i = 0; i < roots.length; i++)
        for (const node of roots[i].querySelectorAll('*'))
          if (node.shadowRoot) roots.push(node.shadowRoot);
      const owner = roots
        .flatMap((root) => [...root.querySelectorAll('iframe,frame')])
        .find((node) => node.contentWindow === event.source);
      if (!owner) return;
      cleanup();
      try {
        const style = getComputedStyle(owner);
        for (
          let ancestor = owner;
          ancestor;
          ancestor = ancestor.parentElement || ancestor.getRootNode().host
        ) {
          const ancestorStyle = getComputedStyle(ancestor);
          const matrix = new DOMMatrixReadOnly(
            ancestorStyle.transform === 'none' ? undefined : ancestorStyle.transform,
          );
          if (
            !matrix.is2D ||
            Math.abs(matrix.b) > 0.001 ||
            Math.abs(matrix.c) > 0.001 ||
            matrix.a <= 0 ||
            matrix.d <= 0 ||
            ancestorStyle.perspective !== 'none' ||
            (ancestorStyle.rotate &&
              ancestorStyle.rotate !== 'none' &&
              ancestorStyle.rotate !== '0deg')
          )
            throw new Error(
              'FRAME_TRANSFORM_UNSUPPORTED: Use screenshot coordinates for rotated/skewed/perspective frames.',
            );
        }
        const rect = owner.getBoundingClientRect();
        if (
          !rect.width ||
          !rect.height ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        )
          throw new Error('FRAME_HIDDEN');
        const x =
          rect.left +
          ((owner.clientLeft + (parseFloat(style.paddingLeft) || 0) + args.point.x) * rect.width) /
            owner.offsetWidth;
        const y =
          rect.top +
          ((owner.clientTop + (parseFloat(style.paddingTop) || 0) + args.point.y) * rect.height) /
            owner.offsetHeight;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
          throw new Error('FRAME_OUTSIDE_VIEWPORT: Scroll the parent iframe into view.');
        if (owner.getRootNode().elementFromPoint(x, y) !== owner)
          throw new Error('FRAME_OCCLUDED: Another element covers the iframe.');
        resolve({ x, y });
      } catch (error) {
        resolve({ error: error.message });
      }
    };
    const cleanup = () => {
      removeEventListener('message', listener);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      pending.delete(args.nonce);
      resolve({ error: 'FRAME_MAPPING_TIMEOUT: Frame changed while locating its owner.' });
    }, 1500);
    addEventListener('message', listener);
    pending.set(args.nonce, { result, cleanup });
    return { prepared: true };
  }
  const entry = pending.get(args.nonce);
  if (!entry) return { error: 'Frame mapping was not prepared' };
  pending.delete(args.nonce);
  if (operation === 'cancel') {
    entry.cleanup();
    return { cancelled: true };
  }
  return entry.result;
}

// Transport image bytes as images, including screenshots returned by a tab batch.
export function splitImages(result) {
  const images = [];
  function visit(value, location = 'result') {
    if (Array.isArray(value))
      return value.map((entry, index) => visit(entry, `${location}[${index}]`));
    if (!value || typeof value !== 'object') return value;
    const output = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === 'image' &&
        ['image/png', 'image/jpeg'].includes(entry?.mimeType) &&
        typeof entry.data === 'string'
      ) {
        images.push({ ...entry, location: `${location}.image` });
        output.image = `[attached image ${images.length}]`;
      } else output[key] = visit(entry, `${location}.${key}`);
    }
    return output;
  }
  return { value: visit(result), images };
}
